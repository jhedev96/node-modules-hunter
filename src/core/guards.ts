import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { isRootPath, realpathSafe } from '../utils/paths.ts'
import { t } from '../i18n/index.ts'

export type GuardCode = 'root' | 'home' | 'system' | 'name' | 'symlink-loop' | 'not-found' | 'not-directory'

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
  if (!st) return verdict('not-found', t('guard.reason.notFound'))
  if (!st.isDirectory() && !st.isSymbolicLink()) return verdict('not-directory', t('guard.reason.notDirectory'))

  const real = await realpathSafe(candidate)
  if (!real) return verdict('symlink-loop', t('guard.reason.symlinkLoop'))

  if (path.basename(candidate) !== 'node_modules') {
    return verdict('name', t('guard.reason.name', { name: path.basename(candidate) }))
  }
  if (isRootPath(real)) return verdict('root', t('guard.reason.root'))
  if (isHome(real)) return verdict('home', t('guard.reason.home'))
  // v1.5 hardening (sisa review #28): OS/package-manager-owned global trees — deleting one
  // nukes every global package (often npm itself). Scan may list them read-only; delete refuses.
  // Checked on BOTH spellings: the typed path and where a symlink really lands.
  if (isSystemNodeModules(candidate) || isSystemNodeModules(real)) {
    return verdict('system', t('guard.reason.system'))
  }
  // v0.9 audit hardening: a node_modules SITTING DIRECTLY inside / or $HOME is
  // structural damage territory (think `home/node_modules` drifting packages) — same risk
  // class as deleting $HOME itself, so it refuses as well.
  const parent = path.dirname(real)
  if (isRootPath(parent)) return verdict('root', t('guard.reason.rootParent'))
  if (isHome(parent)) return verdict('home', t('guard.reason.homeParent'))

  return { safe: true }
}

/** Exact home match on Linux/Windows; case-insensitive on macOS (APFS is case-insensitive
 *  and homedir() may spell the path differently than a realpath reports it — the guard must
 *  not miss it over a casing detail). */
function isHome(p: string): boolean {
  const home = os.homedir()
  return process.platform === 'darwin' ? p.toLowerCase() === home.toLowerCase() : p === home
}

/** v1.5 hardening: the global node_modules trees owned by the OS or a version manager —
 *  the target itself OR anything inside it is off-limits to delete. Absolute posix-style
 *  prefixes cover Linux (`/usr/lib`, `/usr/local/lib`, `/lib`) and macOS Homebrew
 *  (`/opt/homebrew`); Windows resolves npm's global default under %AppData%. */
const SYSTEM_NODE_MODULES_PREFIXES = [
  '/usr/lib/node_modules',
  '/usr/local/lib/node_modules',
  '/lib/node_modules',
  '/opt/homebrew/lib/node_modules',
]

export function isSystemNodeModules(p: string): boolean {
  let normalized = p.replace(/\\/g, '/')
  const bases = [...SYSTEM_NODE_MODULES_PREFIXES]
  if (process.platform === 'win32') {
    // Windows paths are case-insensitive — compare lowered on both sides
    bases.push(`${os.homedir().replace(/\\/g, '/')}/appdata/roaming/npm/node_modules`)
    normalized = normalized.toLowerCase()
  }
  return bases.some((base) => {
    const b = process.platform === 'win32' ? base.toLowerCase() : base
    return normalized === b || normalized.startsWith(`${b}/`)
  })
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
  return verdict.reason ?? verdict.code ?? t('guard.reason.unsafe')
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
