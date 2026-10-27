import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { isRootPath, realpathSafe } from '../utils/paths.ts'

export type GuardCode = 'root' | 'home' | 'name' | 'symlink-loop' | 'not-found' | 'not-directory'

export interface GuardVerdict {
  safe: boolean
  code?: GuardCode
  reason?: string
}

/** Hard guard rules (PRD §6.3) applied to every delete victim. */
export async function checkDeleteTarget(candidate: string): Promise<GuardVerdict> {
  const st = await fs.lstat(candidate).then(
    (value) => value,
    () => null,
  )
  if (!st) return verdict('not-found', 'path does not exist')
  if (!st.isDirectory() && !st.isSymbolicLink()) return verdict('not-directory', 'not a directory')

  const real = await realpathSafe(candidate)
  if (!real) return verdict('symlink-loop', 'cannot resolve real path (symlink loop?)')

  if (path.basename(candidate) !== 'node_modules') {
    return verdict('name', `refusing: folder is not named node_modules (${path.basename(candidate)})`)
  }
  if (isRootPath(real)) return verdict('root', 'refusing: target is a filesystem root')
  if (real === os.homedir()) return verdict('home', 'refusing: target is the user home directory')
  // v0.9 audit hardening: a node_modules SITTING DIRECTLY inside / or $HOME is
  // structural damage territory (think `home/node_modules` drifting packages) — same risk
  // class as deleting $HOME itself, so it refuses as well.
  const parent = path.dirname(real)
  if (isRootPath(parent)) return verdict('root', 'refusing: node_modules directly inside the filesystem root')
  if (parent === os.homedir()) return verdict('home', 'refusing: node_modules directly inside the home directory')

  return { safe: true }
}

export interface PartitionedTargets {
  safe: string[]
  blocked: Array<{ path: string; verdict: GuardVerdict }>
}

export async function partitionTargets(candidates: string[]): Promise<PartitionedTargets> {
  const safe: string[] = []
  const blocked: PartitionedTargets['blocked'] = []
  // Sequential keeps stderr order deterministic and guards don't touch the FS heavily anyway.
  for (const candidate of candidates) {
    const verdict = await checkDeleteTarget(candidate)
    if (verdict.safe) safe.push(candidate)
    else blocked.push({ path: candidate, verdict })
  }
  return { safe, blocked }
}

export function describeGuard(verdict: GuardVerdict): string {
  return verdict.reason ?? verdict.code ?? 'unsafe target'
}

function verdict(code: GuardCode, reason: string): GuardVerdict {
  return { safe: false, code, reason }
}

// Self-protection constants (moved here in v0.9.3 — they used to live in commands/config.ts,
// but they guard scans/deletes, not config): the documented special value "self" in exclude/keep.
export const SELF_TOKEN = 'self'

/** True when an absolute entry path sits inside (or is exactly) the guarded root. */
export function insideRoot(entryPath: string, root: string): boolean {
  return entryPath === root || entryPath.startsWith(root + path.sep)
}
