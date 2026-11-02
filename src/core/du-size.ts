import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { countTopLevelPackages, type EntryMeasure } from './sizer.ts'

const execFileP = promisify(execFile)

/**
 * v1.1 `--fast-size`: measure one node_modules with a single `du -sk` instead of
 * walking every file — huge stores come back in one syscall rather than thousands
 * of stat calls. The trade is granularity: du answers in whole KiB blocks
 * (size is always a multiple of 1024), and hardlinks dedupe only WITHIN this one
 * invocation, du-style — across entries a shared inode may count twice, exactly
 * like the walker's per-entry scope. Real symlinks are never followed (du's
 * default), so the pnpm symlink-farm rule of §6 holds.
 *
 * Returns null whenever du can't answer (binary missing — e.g. Windows, flags
 * unsupported, output shape unexpected, tree unreadable): callers fall back
 * silently to the exact walker.
 */
export async function measureEntryFast(entryPath: string): Promise<EntryMeasure | null> {
  try {
    // `-s` one summary line, `-k` whole KiB; `--` survives entry names starting
    // with '-'; the echoed path is verified so a newline-named directory can
    // never silently shift the parse.
    const { stdout } = await execFileP('du', ['-sk', '--', entryPath], {
      maxBuffer: 8 * 1024,
      timeout: 30_000,
    })
    const line = stdout.split('\n').find((value) => value.includes('\t')) ?? ''
    const tabIndex = line.lastIndexOf('\t')
    const kb = Number.parseInt(line.slice(0, tabIndex).trim(), 10)
    const echoed = line.slice(tabIndex + 1)
    if (!Number.isInteger(kb) || kb < 0 || echoed !== entryPath) return null

    const [packageCount, stat] = await Promise.all([
      countTopLevelPackages(entryPath),
      fs.lstat(entryPath).catch(() => null),
    ])
    return { size: kb * 1024, packageCount, mtimeMs: stat?.mtimeMs ?? null }
  } catch {
    return null
  }
}
