import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/** Lazy registry fallback (PRD §5.4): at most this many network lookups per stats run. */
export const MAX_REGISTRY_DEPRECATED_FETCHES = 25
/** Registry lookups are cheap single-version docs; never let one hang the run. */
export const REGISTRY_TIMEOUT_MS = 4000
/** Cache answers (incl. known-absent) for a month: deprecations rarely change. */
export const DEPRECATED_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface DeprecatedAnswer {
  /** Deprecation note from the registry, or null when the version is fine/absent. */
  message: string | null
}

/** ~/.nmh/cache/registry-deprecated — honors a HOME override (tests). */
export function registryDeprecatedCacheDir(home: string = os.homedir()): string {
  return path.join(home, '.nmh', 'cache', 'registry-deprecated')
}

function cachePath(cacheDir: string, name: string, version: string): string {
  return path.join(cacheDir, `${encodeURIComponent(name)}@${encodeURIComponent(version)}.json`)
}

/**
 * One lazy lookup for `registry.npmjs.org/<name>/<version>` (cached for DEPRECATED_TTL_MS).
 * Network/base errors degrade to null silently — this feature is best-effort by design.
 * `base` overrides the registry origin (tests/mirrors; default official).
 */
export async function registryDeprecated(
  name: string,
  version: string,
  cacheDir: string,
  base: string = 'https://registry.npmjs.org',
): Promise<DeprecatedAnswer | null> {
  if (name.length === 0 || version.length === 0) return null
  const file = cachePath(cacheDir, name, version)
  try {
    const cached = JSON.parse(await fs.readFile(file, 'utf8')) as { checkedAt?: string; message?: unknown }
    if (typeof cached.checkedAt === 'string') {
      const age = Date.now() - Date.parse(cached.checkedAt)
      if (Number.isFinite(age) && age >= 0 && age < DEPRECATED_TTL_MS) {
        return { message: typeof cached.message === 'string' ? cached.message : null }
      }
    }
  } catch {
    // not cached yet → fetch
  }
  let message: string | null = null
  try {
    const response = await fetch(`${base.replace(/\/+$/, '')}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    })
    if (response.ok) {
      const doc = (await response.json()) as { deprecated?: unknown; error?: unknown }
      if (typeof doc.deprecated === 'string' && doc.deprecated.trim().length > 0) message = doc.deprecated
      else if (doc.deprecated === true) message = ''
    }
  } catch {
    return null // offline/broken registry: stay silent, “absent” stays uncached for the next run
  }
  await writeDeprecatedCache(file, message)
  return { message }
}

async function writeDeprecatedCache(file: string, message: string | null): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ checkedAt: new Date().toISOString(), message }), 'utf8')
  } catch {
    // cache write failures never break the scan
  }
}
