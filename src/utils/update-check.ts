import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { toolVersion } from './version.ts'
import { verboseLog } from './logger.ts'
import { t } from '../i18n/index.ts'

/** npm's latest-release JSON shape (only the fields this check reads). */
interface RegistryLatest {
  version?: string
}

export interface UpdateCheckCacheEntry {
  checkedAt: string
  latest: string
}

export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000

function cacheFile(): string {
  return path.join(homedir(), '.nmh', 'cache', 'update-check.json')
}

function registryUrl(): string {
  // test/MCI escape hatch + registry mirror escape hatch; only used for the fetch path
  return process.env.NMH_REGISTRY_JSON ?? 'https://registry.npmjs.org/node-modules-hunter/latest'
}

/**
 * Semver-aware compare. Triples decide first; on a triple tie the prerelease
 * breaks it — no prerelease beats any prerelease, otherwise identifiers compare
 * left-to-right (numeric identifiers numerically, everything else lexically,
 * shorter set loses). So `1.4.0` > `1.4.0-beta.1` and `1.4.0-beta.2` > `1.4.0-beta.1`
 * — a tag can now offer an honest downgrade/upgrade inside the same triple.
 */
export function isNewer(current: string, latest: string): boolean {
  const triple = (v: string): [number, number, number, string] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-?([^+]*))?(?:\+.*)?$/.exec(v.trim())
    return match === null
      ? null
      : [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? '']
  }
  const now = triple(current)
  const next = triple(latest)
  if (now === null || next === null) return false
  for (let i = 0; i < 3; i += 1) {
    if (next[i]! > now[i]!) return true
    if (next[i]! < now[i]!) return false
  }
  // triple tie — prerelease decides (v1.4): none > some, then identifier-wise
  const curPre = now[3] === '' ? [] : now[3].split('.')
  const nextPre = next[3] === '' ? [] : next[3].split('.')
  if (curPre.length === 0 && nextPre.length === 0) return false
  if (curPre.length === 0) return false // a release beats its own prereleases
  if (nextPre.length === 0) return true // current is a prerelease of the release
  for (let i = 0; i < Math.min(curPre.length, nextPre.length); i += 1) {
    const a = curPre[i]
    const b = nextPre[i]
    const numA = /^\d+$/.test(a)
    const numB = /^\d+$/.test(b)
    if (numA && numB) {
      const diff = Number(b) - Number(a)
      if (diff !== 0) return diff > 0
    } else if (numA !== numB) {
      return !numB // numeric identifiers sort below alphanumeric ones
    } else if (a !== b) {
      return b > a
    }
  }
  return nextPre.length > curPre.length
}

export function updateNote(latest: string, current: string): string {
  return t('update.note', { current, latest })
}

async function readFreshCache(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(cacheFile(), 'utf8')) as UpdateCheckCacheEntry
    const age = Date.now() - new Date(parsed.checkedAt).getTime()
    if (Number.isFinite(age) && age >= 0 && age < UPDATE_CACHE_TTL_MS && typeof parsed.latest === 'string') {
      return parsed.latest
    }
  } catch {
    // no cache file / unreadable → fetch below
  }
  return null
}

async function writeCache(latest: string): Promise<void> {
  try {
    const entry: UpdateCheckCacheEntry = { checkedAt: new Date().toISOString(), latest }
    await fs.mkdir(path.dirname(cacheFile()), { recursive: true })
    await fs.writeFile(cacheFile(), `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
  } catch (err) {
    verboseLog(t('verbose.updateCacheWriteFailed', { detail: err instanceof Error ? err.message : String(err) }))
  }
}

/** Latest version string from the registry payload, or null when the shape is unexpected. */
export function parseLatestVersion(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const version = (payload as RegistryLatest).version
  if (typeof version !== 'string' || version.length === 0) return null
  return tripleOf(version) ? version : null
}

function tripleOf(version: string): boolean {
  return /^\d+\.\d+\.\d+/.test(version.trim())
}

/**
 * --update-check (PRD §5.5): non-blocking registry peek, cached 24 h, OFF by default.
 * Never throws, never changes exit codes — failures stay verbose-log only.
 */
export async function checkForUpdate(): Promise<string | null> {
  try {
    const fresh = await readFreshCache()
    const latest = fresh ?? (await fetchLatest())
    if (latest === null) return null
    return isNewer(toolVersion(), latest) ? updateNote(latest, toolVersion()) : null
  } catch (err) {
    verboseLog(t('verbose.updateCheckFailed', { detail: err instanceof Error ? err.message : String(err) }))
    return null
  }
}

async function fetchLatest(): Promise<string | null> {
  try {
    const response = await fetch(registryUrl(), { signal: AbortSignal.timeout(4000) })
    if (!response.ok) {
      verboseLog(t('verbose.updateRegistryStatus', { status: response.status }))
      return null
    }
    const latest = parseLatestVersion(await response.json())
    if (latest !== null) await writeCache(latest)
    return latest
  } catch (err) {
    verboseLog(t('verbose.updateRegistryUnreachable', { detail: err instanceof Error ? err.message : String(err) }))
    return null
  }
}
