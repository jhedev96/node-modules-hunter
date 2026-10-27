import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import { createLimiter } from '../utils/limit.ts'
import { listTopLevelPackages } from './packages.ts'
import { isPermissionError } from './walker.ts'

export interface EntryMeasure {
  /** Bytes of real files only. Symlinks are never followed, so a pnpm virtual store
   *  (`.pnpm` symlink farm) is counted once — through its real files. Files hardlinked
   *  within the entry (pnpm store dedupe) count once per inode, du-style. */
  size: number
  /** Top-level packages: plain dirs + symlinked dirs counted as packages; scopes expanded. */
  packageCount: number
  mtimeMs: number | null
}

export interface MeasureProgress {
  measuredEntries: number
  bytesSoFar: number
}

type ProgressHook = (progress: MeasureProgress) => void

/**
 * Measure one node_modules folder: BFS across directories, stat files in parallel queues.
 * Perm failures inside an entry are pushed to `permIssues` and do not abort the walk.
 */
export async function measureEntry(
  entryPath: string,
  permIssues: string[] = [],
): Promise<EntryMeasure> {
  const limiter = createLimiter(8)
  let size = 0
  // Hardlink dedupe, du-style, scoped to ONE entry: the same inode linked under
  // several .pnpm paths counts once here. Cross-entry sharing (a global pnpm
  // store) stays out of scope — each entry is a separately deletable unit.
  const seenHardlinks = new Set<string>()

  let frontier: string[] = [entryPath]
  while (frontier.length > 0) {
    const current = frontier
    frontier = []
    await Promise.all(
      current.map((dir) =>
        limiter(async () => {
          let dirents: Dirent<string>[]
          try {
            dirents = await fs.readdir(dir, { withFileTypes: true })
          } catch (err) {
            if (isPermissionError(err)) permIssues.push(dir)
            return // vanished or unreadable — skip
          }
          for (const dirent of dirents) {
            // Classify via lstat, never via dirent d_type. Some filesystems (FUSE /
            // sdcardfs on Android; hardlink-heavy pnpm stores) report plain FILE
            // dirents as symlinks — trusting d_type silently skipped 112 of 125
            // entries in one typescript/lib dir (folder measured 650 KB while du
            // showed 66 MB). lstat also keeps the hard rule intact: a real symlink
            // still reports as a symlink and is never followed.
            const full = path.join(dir, dirent.name)
            const st = await fs.lstat(full).catch(() => null)
            if (st === null) continue // vanished or unreadable — skip
            if (st.isDirectory()) {
              frontier.push(full)
            } else if (st.isFile()) {
              if (st.nlink > 1 && st.ino !== 0) {
                const key = `${st.dev}:${st.ino}`
                if (seenHardlinks.has(key)) continue
                seenHardlinks.add(key)
              }
              size += Number(st.size)
            }
          }
        }),
      ),
    )
  }

  const packageCount = await countTopLevelPackages(entryPath)
  const stat = await fs.lstat(entryPath).then(
    (value) => value,
    () => null,
  )
  return { size, packageCount, mtimeMs: stat?.mtimeMs ?? null }
}

/** Count top-level installable packages: plain dirs + symlinked dirs counted as packages, scopes expanded. */
export async function countTopLevelPackages(entryPath: string): Promise<number> {
  return (await listTopLevelPackages(entryPath)).length
}

export interface MeasureOptions {
  concurrency?: number
  onProgress?: ProgressHook
}

/** Measure a list of entries with bounded parallelism, emitting progress after each one. */
export async function measureEntries(
  entryPaths: string[],
  permIssues: string[] = [],
  options: MeasureOptions = {},
): Promise<Map<string, EntryMeasure>> {
  const results = new Map<string, EntryMeasure>()
  const limiter = createLimiter(options.concurrency ?? 4)
  let measured = 0
  let bytesSoFar = 0

  await Promise.all(
    entryPaths.map((entryPath) =>
      limiter(async () => {
        const measure = await measureEntry(entryPath, permIssues)
        results.set(entryPath, measure)
        measured += 1
        bytesSoFar += measure.size
        options.onProgress?.({
          measuredEntries: measured,
          bytesSoFar,
        })
      }),
    ),
  )
  return results
}
