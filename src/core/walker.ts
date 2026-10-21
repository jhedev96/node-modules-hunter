import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import { createLimiter } from '../utils/limit.ts'

export interface WalkOutcome {
  /** Absolute paths of found node_modules folders. */
  entries: string[]
  /** Directories that could not be read (EACCES / EPERM). */
  permissionIssues: string[]
}

export interface WalkOptions {
  /**
   * How many directory levels below a root a node_modules may sit. Default: unlimited.
   * Walker never descends INTO a found node_modules — nested ones belong to the entry
   * above (this is what keeps totals from double counting).
   */
  maxDepth?: number
  onFound?: (entryPath: string) => void
}

/**
 * Find node_modules folders under the given roots.
 * - Skips `.git` and never follows symlinks (symlinked dirs are invisible to the walk,
 *   which also makes cycle/loop traversal impossible).
 * - Recursive depth is bounded and `node_modules` becomes an owned entry, not a diving board.
 */
export async function scanForNodeModules(roots: string[], options: WalkOptions = {}): Promise<WalkOutcome> {
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY
  const entries: string[] = []
  const permissionIssues: string[] = []
  const visited = new Set<string>()
  const limiter = createLimiter(16)

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (visited.has(dir)) return
    visited.add(dir)

    let dirents: Dirent<string>[]
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (isPermissionError(err)) permissionIssues.push(dir)
      // A dir that vanished mid-walk (ENOENT) is fine; anything else non-permission: ignore too.
      return
    }

    const subdirs: Array<{ dir: string; depth: number }> = []
    for (const dirent of dirents) {
      if (dirent.name === '.git') continue
      if (dirent.isSymbolicLink()) continue // never follow links while walking
      if (!dirent.isDirectory()) continue

      const child = path.join(dir, dirent.name)
      const childDepth = depth + 1
      if (childDepth > maxDepth) continue

      if (dirent.name === 'node_modules') {
        entries.push(child)
        options.onFound?.(child)
        continue // do NOT descend into a found node_modules
      }
      subdirs.push({ dir: child, depth: childDepth })
    }

    await Promise.all(subdirs.map((sub) => limiter(() => walk(sub.dir, sub.depth))))
  }

  await Promise.all(roots.map((root) => walk(root, 0)))
  return { entries, permissionIssues }
}

export function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'EACCES' || code === 'EPERM'
}
