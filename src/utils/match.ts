/**
 * Minimal glob → RegExp translation (no extra dep): `**` crosses segments,
 * `*` stays in-segment, `?` is one char, `{a,b}` alternates, `[…]` passes through.
 * Windows backslashes are normalized so patterns are written posix-style everywhere.
 */

const ESCAPE_CHARS = new Set(['.', '+', '^', '$', '(', ')', '|'])

function escapeLiteral(ch: string): string {
  return ESCAPE_CHARS.has(ch) ? '\\' + ch : ch
}

export function globToRegExp(pattern: string, flags = ''): RegExp {
  const normalized = pattern.replace(/\\/g, '/')
  let re = ''
  let i = 0

  while (i < normalized.length) {
    const ch = normalized[i]

    if (ch === '*') {
      let stars = 0
      while (normalized[i] === '*') {
        stars += 1
        i += 1
      }
      if (stars >= 2) {
        if (normalized[i] === '/') {
          re += '(?:[^/]*/)*'
          i += 1
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
      continue
    }

    if (ch === '?') {
      re += '[^/]'
      i += 1
      continue
    }

    if (ch === '{') {
      const end = normalized.indexOf('}', i + 1)
      if (end === -1) {
        re += '\\{'
        i += 1
        continue
      }
      const body = normalized
        .slice(i + 1, end)
        .split(',')
        .map((part) => part.split('').map(escapeLiteral).join(''))
        .join('|')
      re += `(?:${body})`
      i = end + 1
      continue
    }

    if (ch === '[') {
      const end = normalized.indexOf(']', i + 1)
      if (end === -1) {
        re += '\\['
        i += 1
        continue
      }
      re += normalized.slice(i, end + 1)
      i = end + 1
      continue
    }

    re += escapeLiteral(ch)
    i += 1
  }

  return new RegExp(`^${re}$`, flags)
}

export type PathMatcher = (candidate: string) => boolean

/** Hard caps that keep pathological globs from turning into catastrophic-backtracking regexes
 * (v0.9.4) — a pattern is user input, never trust it with arbitrary complexity. */
const MAX_PATTERN_LENGTH = 512
const MAX_DOUBLE_STARS = 8

export function makeGlobMatcher(
  patterns: string[],
  options: { caseInsensitive?: boolean } = {},
): PathMatcher {
  for (const pattern of patterns) {
    if (pattern.length > MAX_PATTERN_LENGTH) {
      throw new Error(`glob pattern too long (>${MAX_PATTERN_LENGTH} chars): ${pattern.slice(0, 40)}…`)
    }
    // `**/` translates to nested quantifiers — the only ReDoS-capable shape here
    const stars = (pattern.match(/\*\*/g) ?? []).length
    if (stars > MAX_DOUBLE_STARS) {
      throw new Error(`glob pattern too complex (>${MAX_DOUBLE_STARS} '**'): ${pattern.slice(0, 40)}…`)
    }
  }
  const flag = options.caseInsensitive || process.platform === 'win32' ? 'i' : ''
  const regexps = patterns.map((pattern) => globToRegExp(pattern, flag))
  return (candidate: string) => {
    const normalized = candidate.replace(/\\/g, '/')
    return regexps.some((re) => re.test(normalized))
  }
}

export type SearchMatcher = (name: string) => boolean

/**
 * Search pattern semantics (PRD §5.3): `/re/flags` → regex, glob chars → wildcard,
 * otherwise case-insensitive substring — the 90% case for `nmh search lodash`.
 */
export function makeSearchMatcher(pattern: string): SearchMatcher {
  const regexForm = /^\/(.+)\/([a-z]*)$/s.exec(pattern)
  if (regexForm) {
    let flags = regexForm[2]
    if (!flags.includes('u')) flags += 'u'
    const re = new RegExp(regexForm[1], flags)
    return (name) => re.test(name)
  }

  if (/[*?{[]/.test(pattern)) {
    const glob = globToRegExp(pattern, 'i')
    return (name) => glob.test(name.replace(/\\/g, '/'))
  }

  const needle = pattern.toLowerCase()
  return (name) => name.toLowerCase().includes(needle)
}
