import { createRequire } from 'node:module'

let cached: string | null = null

/** Tool version, read from package.json relative to the built entry; safe fallback for odd runtimes. */
export function toolVersion(): string {
  if (cached) return cached
  const fallback = '0.1.0'
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('../package.json') as { version?: unknown }
    cached = typeof pkg.version === 'string' ? pkg.version : fallback
  } catch {
    cached = fallback
  }
  return cached
}
