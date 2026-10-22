import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { toolVersion } from './version.ts'
import { verboseLog } from './logger.ts'

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

/** Plain triple-version compare (`0.4.10` > `0.4.9`); prerelease suffix on latest ignored except ordering ties. */
export function isNewer(current: string, latest: string): boolean {
  const triple = (v: string): [number, number, number, string] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(v.trim())
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
  return false
}

export function updateNote(latest: string, current: string): string {
  return `update tersedia: ${current} → ${latest} — npm i -g node-modules-hunter (cek 24 jam sekali, opt-in via --update-check)`
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
    verboseLog(`update-cache write failed: ${err instanceof Error ? err.message : String(err)}`)
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
    verboseLog(`update check failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

async function fetchLatest(): Promise<string | null> {
  try {
    const response = await fetch(registryUrl(), { signal: AbortSignal.timeout(4000) })
    if (!response.ok) {
      verboseLog(`update check: registry responded ${response.status}`)
      return null
    }
    const latest = parseLatestVersion(await response.json())
    if (latest !== null) await writeCache(latest)
    return latest
  } catch (err) {
    verboseLog(`update check: registry unreachable (${err instanceof Error ? err.message : String(err)})`)
    return null
  }
}
