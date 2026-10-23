import { confirm, isCancel, multiselect, outro, select, text } from '@clack/prompts'
import { collectScan } from './scan.ts'
import { executeAll } from './delete.ts'
import { runSearch } from './search.ts'
import { runMap } from './map.ts'
import { runStats } from './stats.ts'
import { partitionTargets, describeGuard } from '../core/guards.ts'
import { renderScanResult } from '../core/render.ts'
import { errorLog, log, warn, colors, isTTYOut } from '../utils/logger.ts'
import { formatBytes } from '../utils/format.ts'
import { renderFullBanner, renderCompactBanner } from '../utils/banner.ts'
import type { DeleteMode, ScanEntry } from '../core/result.ts'
import type { NmhConfig } from '../utils/config.ts'

/** No-arg entry point (PRD §7.5). TTY: full wizard menu. Non-TTY: plain safe scan, never hangs. */
export async function runWizard(
  cwd: string,
  options: WizardOptions = {},
): Promise<number> {
  if (!isTTYOut()) return runFallbackScan(cwd, options)
  return runInteractiveWizard(cwd, options)
}

export interface WizardSettings {
  /** .nmhrc path that supplied the values, when one was found. */
  source: string | null
  values: Partial<NmhConfig>
}

export interface WizardOptions {
  defaultMode?: DeleteMode
  /** Non-TTY fallback honors --json so piped callers get clean machine-readable output (banner suppressed). */
  json?: boolean
  /** Backs the ⚙️ settings menu (v0.7, PRD §7.5 step 3). */
  settings?: WizardSettings
}

/** Wizard quick-scan depth (PRD §7.5 step 2). The menu never supplies --depth; keep one source of truth. */
const WIZARD_DEPTH = 3

/**
 * Piped/CI path: compact banner + read-only scan by default; with --json the output is a bare
 * scan payload — same shape as `nmh scan --json` — so scripts can call `nmh` with no args safely.
 */
async function runFallbackScan(cwd: string, options: WizardOptions): Promise<number> {
  if (!options.json) log(renderCompactBanner())
  const outcome = await collectScan({ targets: ['.'], cwd, maxDepth: WIZARD_DEPTH })
  if (outcome.result.entries.length > 0 || options.json) {
    log(renderScanResult(outcome.result, { cwd, json: options.json === true, sizeMode: 'each' }))
  } else {
    warn('no node_modules found in this folder')
  }
  warn('the interactive wizard needs a TTY — this was a plain read-only scan; every menu action exists as a command: see nmh --help')
  return outcome.code
}

/**
 * TTY path (v0.7, PRD §7.5): banner → quick scan → arrow menu
 * (delete all / pick manually / search / map / report / settings / quit),
 * looping back after read-only actions until the user quits.
 */
async function runInteractiveWizard(cwd: string, options: WizardOptions): Promise<number> {
  log(renderFullBanner())

  for (;;) {
    const scan = await collectScan({ targets: ['.'], cwd, maxDepth: WIZARD_DEPTH })
    const entries = scan.result.entries
    if (entries.length === 0) {
      outro('nothing found 🙃')
      return scan.result.permissionIssues.length > 0 ? 4 : 2
    }

    const totalSize = sum(entries)
    const choice = await select({
      message: `${entries.length} node_modules found in this tree — ${formatBytes(totalSize)} · next move?`,
      options: [
        { value: 'delete-all', label: '🗑️  Delete everything found (guards, mode & confirm included)' },
        { value: 'pick', label: '☑️  Pick manually — checkboxes (space to select)' },
        { value: 'search', label: '🔍  Search installed packages by pattern' },
        { value: 'map', label: '🗺️  Map dependencies — project → PM → declared deps' },
        { value: 'stats', label: '📊  Detailed report — the full stats read-out' },
        { value: 'settings', label: '⚙️  Settings & integration (read-only view)' },
        { value: 'quit', label: '⏹  Exit nmh' },
      ],
    })
    if (isCancel(choice) || choice === 'quit') {
      outro('bye 👋 — nothing deleted')
      return 0
    }

    switch (choice) {
      case 'delete-all':
        return deleteFlow('all', entries, options)
      case 'pick':
        return deleteFlow('pick', entries, options)
      case 'search': {
        const pattern = await text({
          message: 'Search installed packages — which pattern?',
          placeholder: 'e.g. lodash, react-dom, es*build, /react(-dom)?/i',
          validate: (value) => (value.trim().length === 0 ? 'give a pattern — substring, glob, or /regex/' : undefined),
        })
        if (isCancel(pattern)) {
          warn('search skipped — back to the menu')
          continue
        }
        await runSearch({ pattern: String(pattern).trim(), targets: ['.'], cwd, maxDepth: WIZARD_DEPTH })
        break
      }
      case 'map':
        await runMap({ targets: ['.'], cwd, maxDepth: WIZARD_DEPTH })
        break
      case 'stats':
        await runStats({ targets: ['.'], cwd, maxDepth: WIZARD_DEPTH })
        break
      case 'settings':
        log(renderSettings(options.settings, cwd))
        break
    }
  }
}

/**
 * Shared delete path for menu items 1 and 2: guards surface-and-exclude first,
 * then the mode decision and the final confirm gate — exactly like v0.1, just loop-aware.
 */
async function deleteFlow(
  kind: 'all' | 'pick',
  entries: ScanEntry[],
  options: WizardOptions,
): Promise<number> {
  // Guards run before anything is offered (blocked victims are surfaced, not hidden silently).
  const { safe, blocked } = await partitionTargets(entries.map((entry) => entry.path))
  for (const item of blocked) {
    errorLog(`🛑 ${item.path} — ${describeGuard(item.verdict)} (excluded from wizard)`)
  }
  const safeSet = new Set(safe)
  const selectable = entries.filter((entry) => safeSet.has(entry.path))
  const selectableSet = new Map(selectable.map((entry) => [entry.path, entry] as const))

  if (selectable.length === 0) {
    outro('nothing safe to select — done')
    return 3
  }

  let selected: ScanEntry[]
  if (kind === 'all') {
    selected = selectable
  } else {
    const picked = await multiselect({
      message: `${selectable.length} node_modules — ${formatBytes(sum(selectable))} found · space to select, enter to continue`,
      options: selectable.map((entry) => ({
        value: entry.path,
        label: `${formatBytes(entry.size)} · ${entry.displayPath}${entry.pm.family === 'unknown' ? '' : colors.dim(`  · ${entry.pm.family}`)}`,
      })),
      required: true,
    })
    if (isCancel(picked)) {
      outro('cancelled — nothing deleted')
      return 0
    }
    selected = (picked as string[])
      .map((path_) => selectableSet.get(path_))
      .filter((entry): entry is ScanEntry => entry !== undefined)
    if (selected.length === 0) {
      outro('nothing selected — bye 👋')
      return 0
    }
  }

  const mode = await pickDeleteMode(options.defaultMode)
  if (mode === null) {
    outro('cancelled — nothing deleted')
    return 0
  }

  const admitted = await confirm({
    message:
      mode === 'hard'
        ? `Delete ${selected.length} folder(s) — ${formatBytes(sum(selected))} — PERMANENTLY (no undo)?`
        : `Move ${selected.length} folder(s) — ${formatBytes(sum(selected))} — to the OS trash?`,
    initialValue: mode !== 'hard',
  })
  if (isCancel(admitted) || admitted === false) {
    outro('cancelled — nothing deleted')
    return 0
  }

  const result = await executeAll(selected, { mode, json: false, quietSummary: true })
  outro(
    result.outcome.failed > 0
      ? `${colors.yellow('⚠')} done with ${result.outcome.failed} failure(s) — freed ${formatBytes(result.outcome.freed)}`
      : `${colors.green('✅')} Freed: ${formatBytes(result.outcome.freed)} from ${result.outcome.deleted} folder(s)`,
  )
  return result.code
}

/** Trash pre-selected as the safe default (PRD decision #2); hard demands the loud confirm later. */
async function pickDeleteMode(defaultMode?: DeleteMode): Promise<DeleteMode | null> {
  const modeChoice = await select({
    message: 'How should these die?',
    options: [
      { value: 'trash', label: 'Move to OS trash — safe & restorable (recommended)' },
      { value: 'hard', label: 'Delete permanently — there is no undo' },
    ],
    initialValue: defaultMode ?? 'trash',
  })
  return isCancel(modeChoice) ? null : (modeChoice as DeleteMode)
}

/** ⚙️ menu: what .nmhrc is in effect, what it says, and where real config changes happen. */
function renderSettings(settings: WizardSettings | undefined, cwd: string): string {
  const values = settings?.values ?? {}
  const row = (key: string, value: string): string => `${colors.dim(key.padEnd(12, ' '))}${value}`
  const list = (items?: string[]): string => (items === undefined || items.length === 0 ? '(none)' : `${items.length}: ${items.join(', ')}`)
  return [
    '',
    colors.bold('⚙  settings & integration'),
    row('cwd', cwd),
    row('config', settings?.source ?? 'none found (.nmhrc in cwd → home)'),
    row('defaultMode', values.defaultMode ?? 'trash (wizard keeps it safe by default)'),
    row('depth', values.depth !== undefined ? String(values.depth) : 'default 3 here — flag --depth <n> overrides'),
    row('animate', values.animate === undefined ? 'auto (TTY on)' : String(values.animate)),
    row('color', values.color === undefined ? 'auto (TTY on)' : String(values.color)),
    row('updateCheck', values.updateCheck === undefined ? 'off — opt-in via --update-check' : String(values.updateCheck)),
    row('exclude', list(values.exclude)),
    row('keep', list(values.keep)),
    row('logDir', values.logDir ?? '~/.nmh (delete receipts)'),
    '',
    colors.dim('change with .nmhrc (cwd/home) or CLI flags — README §10 ·'),
    colors.dim('this whole menu also exists as plain commands: nmh clean · nmh search <pattern> · nmh map · nmh stats'),
  ].join('\n')
}

function sum(entries: ScanEntry[]): number {
  return entries.reduce((acc, entry) => acc + entry.size, 0)
}
