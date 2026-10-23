import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import { makeGlobMatcher } from '../utils/match.ts'

export interface WalkEntry {
  /** Absolute path of the found node_modules. */
  path: string
  /** Top-level owner entry (== path for top entries; the parent entry for nested ones). */
  ownerPath: string
  nested: boolean
}

export interface WalkOutcome {
  entries: WalkEntry[]
  /** Directories that could not be read (EACCES / EPERM). */
  permissionIssues: string[]
}

export interface WalkOptions {
  /** Max directory levels below a root where a node_modules may sit. Default: unlimited. */
  maxDepth?: number
  /** Also look INSIDE found node_modules (nested audit). Totals stay top-level only. */
  recursive?: boolean
  /** Exclude globs — matched against absolute path, path relative to the walk root, and basename. */
  excludes?: string[]
  /** Used when a direct node_modules target is walked with -r: entries found inside are nested under it. */
  initialOwner?: string
  onFound?: (entry: WalkEntry) => void
}

/**
 * Find node_modules folders under the given roots.
 * - Skips `.git`; never follows symlinks (cycle/loop traversal impossible; pnpm-safe).
 * - A found node_modules becomes an owned entry, not a diving board — unless `recursive`.
 * - Walker entries are real dirs; overlapping roots collapse via the visited set.
 *
 * Scheduling (v0.7.1): each concurrency slot runs ONE readdir as its whole task — a
 * task NEVER awaits children. Holding a slot across a subtree would eventually
 * deadlock: bursts of readdir results saturate every slot with parents whose children
 * are all queued behind them (circular wait), which froze wide bushy pnpm trees
 * (12 packages × bushy node_modules) with NOTHING printed and exit 0 mid-walk.
 */
export async function scanForNodeModules(roots: string[], options: WalkOptions = {}): Promise<WalkOutcome> {
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY
  const recursive = options.recursive === true
  const isExcluded = options.excludes && options.excludes.length > 0 ? makeGlobMatcher(options.excludes) : null

  const entries: WalkEntry[] = []
  const permissionIssues: string[] = []
  const visited = new Set<string>()
  const CONCURRENCY = 16

  interface Job {
    dir: string
    /** The walk root this chain descended from (exclude globs match relative to it). */
    root: string
    depth: number
    owner: string | null
  }

  const queue: Job[] = roots.map((root) => ({ dir: root, root, depth: 0, owner: options.initialOwner ?? null }))
  let active = 0
  let failure: unknown = null

  return await new Promise<WalkOutcome>((settle) => {
    const maybeFinish = (): void => {
      if (active === 0 && queue.length === 0) {
        settle({ entries, permissionIssues })
      }
    }
    const pump = (): void => {
      while (active < CONCURRENCY && queue.length > 0) {
        const job = queue.shift() as Job
        active += 1
        void processDir(job)
      }
      maybeFinish()
    }
    const processDir = async (job: Job): Promise<void> => {
      try {
        if (visited.has(job.dir)) return
        visited.add(job.dir)

        let dirents: Dirent<string>[]
        try {
          dirents = await fs.readdir(job.dir, { withFileTypes: true })
        } catch (err) {
          if (isPermissionError(err)) permissionIssues.push(job.dir)
          return // vanished or unreadable — skip
        }

        for (const dirent of dirents) {
          if (dirent.name === '.git') continue
          const child = path.join(job.dir, dirent.name)
          // Classify with lstat, same reason as the sizer: d_type lies on some
          // filesystems, and trusting it would hide real dirs (a missed
          // node_modules). lstat does not follow entries, so the "never follow
          // symlinks" rule holds by construction.
          const st = await fs.lstat(child).catch(() => null)
          if (st === null) continue // vanished or unreadable — skip
          if (!st.isDirectory()) continue // files and symlinks: never followed

          const childDepth = job.depth + 1
          if (childDepth > maxDepth) continue

          if (isExcluded) {
            const relative = path.relative(job.root, child)
            if (isExcluded(child) || isExcluded(relative) || isExcluded(dirent.name)) continue
          }

          if (dirent.name === 'node_modules') {
            const entry: WalkEntry = job.owner
              ? { path: child, ownerPath: job.owner, nested: true }
              : { path: child, ownerPath: child, nested: false }
            entries.push(entry)
            options.onFound?.(entry)
            if (recursive) queue.push({ dir: child, root: job.root, depth: childDepth, owner: job.owner ?? child })
            continue
          }
          queue.push({ dir: child, root: job.root, depth: childDepth, owner: job.owner })
        }
      } catch (err) {
        if (failure === null) failure = err
      } finally {
        active -= 1
        pump()
      }
    }
    pump()
  }).then((outcome) => {
    if (failure !== null) throw failure
    return outcome
  })
}

export function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'EACCES' || code === 'EPERM'
}
