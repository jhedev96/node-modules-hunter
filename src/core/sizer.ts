import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import { createLimiter } from '../utils/limit.ts'
import { isPermissionError } from './walker.ts'

export interface EntryMeasure {
  /** Bytes of real files only. Symlinks are never followed, so a pnpm virtual store
   *  (`.pnpm` symlink farm) is counted once — through its real files. */
  size: number
  /** Top-level packages: plain dirs + symlinked dirs counted as packages; scopes expanded. */
  packageCount: number
  mtimeMs: number | null
}

export interface MeasureProgress {
  measuredEntries: number
  bytesSoFar: number
  currentEntry: string
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
            if (dirent.isSymbolicLink()) continue // hard rule: never follow links
            if (!dirent.isDirectory() && !dirent.isFile()) continue
            const full = path.join(dir, dirent.name)
            if (dirent.isDirectory()) {
              frontier.push(full)
            } else {
              const st = await fs.stat(full).then(
                (value) => value,
                () => null,
              )
              if (st?.isFile()) size += Number(st.size)
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

/** Count top-level installable packages: dirs (incl. symlinked ones) minus dotdirs; `@scope` expands. */
export async function countTopLevelPackages(entryPath: string): Promise<number> {
  let dirents: Dirent<string>[]
  try {
    dirents = await fs.readdir(entryPath, { withFileTypes: true })
  } catch {
    return 0
  }

  let count = 0
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue // .pnpm, .bin, .cache, …

    if (dirent.isDirectory()) {
      if (dirent.name.startsWith('@')) count += await countScopedMembers(entryPath, dirent.name)
      else count += 1
      continue
    }

    if (dirent.isSymbolicLink()) {
      // pnpm-style top-level links point at real package dirs; count them if they really are dirs.
      const st = await fs.stat(path.join(entryPath, dirent.name)).then(
        (value) => value,
        () => null,
      )
      if (st?.isDirectory()) count += 1
    }
  }
  return count
}

async function countScopedMembers(entryPath: string, scope: string): Promise<number> {
  let members: Dirent<string>[]
  try {
    members = await fs.readdir(path.join(entryPath, scope), { withFileTypes: true })
  } catch {
    return 0
  }
  let count = 0
  for (const dirent of members) {
    if ((dirent.isDirectory() || dirent.isSymbolicLink()) && !dirent.name.startsWith('.')) count += 1
  }
  return count
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
          currentEntry: entryPath,
        })
      }),
    ),
  )
  return results
}
