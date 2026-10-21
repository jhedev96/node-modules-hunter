import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import { createLimiter } from '../utils/limit.ts'
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
 */
export async function scanForNodeModules(roots: string[], options: WalkOptions = {}): Promise<WalkOutcome> {
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY
  const recursive = options.recursive === true
  const isExcluded = options.excludes && options.excludes.length > 0 ? makeGlobMatcher(options.excludes) : null

  const entries: WalkEntry[] = []
  const permissionIssues: string[] = []
  const visited = new Set<string>()
  const limiter = createLimiter(16)

  const makeWalker = (root: string) => {
    const walk = async (dir: string, depth: number, owner: string | null): Promise<void> => {
      if (visited.has(dir)) return
      visited.add(dir)

      let dirents: Dirent<string>[]
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true })
      } catch (err) {
        if (isPermissionError(err)) permissionIssues.push(dir)
        return // vanished or unreadable — skip
      }

      const subdirs: Array<{ dir: string; depth: number; owner: string | null }> = []
      for (const dirent of dirents) {
        if (dirent.name === '.git') continue
        if (dirent.isSymbolicLink()) continue // never follow links while walking
        if (!dirent.isDirectory()) continue

        const child = path.join(dir, dirent.name)
        const childDepth = depth + 1
        if (childDepth > maxDepth) continue

        if (isExcluded) {
          const relative = path.relative(root, child)
          if (isExcluded(child) || isExcluded(relative) || isExcluded(dirent.name)) continue
        }

        if (dirent.name === 'node_modules') {
          const entry: WalkEntry = owner
            ? { path: child, ownerPath: owner, nested: true }
            : { path: child, ownerPath: child, nested: false }
          entries.push(entry)
          options.onFound?.(entry)
          if (recursive) subdirs.push({ dir: child, depth: childDepth, owner: owner ?? child })
          continue
        }
        subdirs.push({ dir: child, depth: childDepth, owner })
      }

      await Promise.all(subdirs.map((sub) => limiter(() => walk(sub.dir, sub.depth, sub.owner))))
    }
    return walk
  }

  await Promise.all(roots.map((root) => makeWalker(root)(root, 0, options.initialOwner ?? null)))
  return { entries, permissionIssues }
}

export function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'EACCES' || code === 'EPERM'
}
