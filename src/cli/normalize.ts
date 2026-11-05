import path from 'node:path'
import { existsSync } from 'node:fs'
import { versionDetail, renderVersionDetail } from '../utils/version.ts'
import type { DeleteMode } from '../core/result.ts'

const PM_FAMILIES = new Set(['npm', 'pnpm', 'yarn', 'bun', 'vp'])

/** Every dispatchable first-token (PRD §7 commands + analyze/info aliases + wizard v1.2). */
const KNOWN_SUBCOMMANDS = new Set([
  'scan', 'clean', 'search', 'map', 'why', 'treemap', 'stats',
  'analyze', 'info', 'config', 'update', 'version', 'help', 'wizard',
])

/** Read-only views the wizard `--` router may open before the menu (v1.2). */
export const WIZARD_VIEWS = new Set(['stats', 'analyze', 'info', 'map', 'search', 'why', 'treemap'])

function looksLikePath(text: string): boolean {
  return (
    text.includes('/') ||
    text.includes('\\') ||
    text.startsWith('.') ||
    text.startsWith('~') ||
    /^[A-Za-z]:/.test(text)
  )
}

/**
 * Classify the first positional. Order matters:
 * 1. a registered subcommand always wins — `nmh scan` is the scan command even if a
 *    `scan/` directory happens to sit in the cwd;
 * 2. an existing cwd-relative path is a scan target — `nmh node_modules` from inside a
 *    project must hit the folder itself, not degenerate into a positional-less scan;
 * 3. path-like strings (absolute, ~/~, ./…, C:\…) are targets wherever they exist now or not
 *    (the scan reports unmatched patterns with honesty);
 * 4. anything else is an unknown command — a silent lapse; it used to fall back to a cwd scan.
 */
export function resolveSubcommand(
  positionals: string[],
  cwd: string,
): { subcommand: string | null; unknown: string | null } {
  if (positionals.length === 0) return { subcommand: null, unknown: null }
  const first = positionals[0]
  if (KNOWN_SUBCOMMANDS.has(first)) return { subcommand: first, unknown: null }
  if (existsSync(path.resolve(cwd, first)) || looksLikePath(first)) {
    return { subcommand: null, unknown: null }
  }
  return { subcommand: null, unknown: first }
}

export function normalizeDelete(value: unknown): { given: boolean; mode: DeleteMode | null } | 'invalid' {
  if (value === undefined || value === false) return { given: false, mode: null }
  if (value === true) return { given: true, mode: null }
  if (typeof value === 'string') {
    if (value === 'hard') return { given: true, mode: 'hard' }
    if (value === 'trash' || value === 'soft') return { given: true, mode: 'trash' }
    return 'invalid'
  }
  return 'invalid'
}

export function normalizePm(value: unknown): { given: boolean; family: string | null } | 'invalid' {
  if (value === undefined) return { given: false, family: null }
  if (value === true) return { given: true, family: null } // bare --pm = list what was detected
  if (typeof value === 'string' && PM_FAMILIES.has(value)) return { given: true, family: value }
  return 'invalid'
}

export function normalizeDepth(value: unknown): number | null | 'invalid' {
  if (value === undefined || value === false) return null
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10)
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  return 'invalid'
}

/**
 * `nmh version` / `--version`: rich banner by default (v0.7 — runtime/system/io),
 * `--json` prints the same payload machine-readable.
 */
export function printVersion(json: boolean): void {
  if (json) {
    console.log(JSON.stringify(versionDetail(), null, 2))
    return
  }
  console.log(renderVersionDetail(versionDetail()))
}

/**
 * --animate is negatable, so cac reports flags.animate=true even when nobody passed it;
 * argv sniffing separates the explicit forms. .nmhrc animate:false mutes the default.
 */
export function normalizeAnimate(argv: string[], configAnimate?: boolean): 'auto' | 'on' | 'off' {
  if (argv.includes('--no-animate') || argv.includes('--animate=false')) return 'off'
  if (argv.includes('--animate') || argv.includes('--animate=true')) return 'on'
  return configAnimate === false ? 'off' : 'auto'
}
