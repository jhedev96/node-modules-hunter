/**
 * Flags declared in the PRD but scheduled for v0.2+. When someone passes them today we
 * warn (never silently swallow) and continue.
 */
const FUTURE_FLAGS = new Set([
  'exclude',
  'keep',
  'pm',
  'recursive',
  'depth',
  'empty',
  'animate',
  'global',
  'why',
  'depend',
  'map',
  'search',
  'stats',
  'tree',
  'report',
  'saveReport',
  'updateCheck',
  'online',
  'co2',
  'score',
  'licenses',
  'phantom',
  'dead',
  'saveBaseline',
  'compare',
  'history',
  'config',
  'expand',
])

/** camelCased option keys seen by the CLI that are future scopes. */
export function detectFutureFlags(flagKeys: Iterable<string>): string[] {
  const hits: string[] = []
  for (const key of flagKeys) {
    if (FUTURE_FLAGS.has(key)) hits.push(`--${key.replace(/([A-Z])/g, (_, c) => '-' + c.toLowerCase())}`)
  }
  return hits
}
