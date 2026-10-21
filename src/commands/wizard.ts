import { confirm, intro, isCancel, multiselect, outro, select } from '@clack/prompts'
import { collectScan } from './scan.ts'
import { executeAll } from './delete.ts'
import { partitionTargets, describeGuard } from '../core/guards.ts'
import { renderScanResult } from '../core/render.ts'
import { errorLog, log, warn, colors, isTTYOut } from '../utils/logger.ts'
import { formatBytes } from '../utils/format.ts'
import type { DeleteMode, ScanEntry } from '../core/result.ts'

/** No-arg entry point (PRD §7.5). TTY: full wizard. Non-TTY: plain safe scan, never hangs. */
export async function runWizard(cwd: string): Promise<number> {
  if (!isTTYOut()) {
    const outcome = await collectScan({ targets: ['.'], cwd, maxDepth: 3 })
    if (outcome.result.entries.length > 0) {
      log(renderScanResult(outcome.result, { cwd, json: false, sizeMode: 'each' }))
    } else {
      warn('no node_modules found in this folder')
    }
    warn('the interactive wizard needs a TTY — this was a plain read-only scan; see nmh --help')
    return outcome.code
  }

  intro(`${colors.magenta('🐉')} ${colors.bold('nmh')} — node_modules hunter`)

  const scan = await collectScan({ targets: ['.'], cwd, maxDepth: 3 })
  const entries = scan.result.entries

  if (entries.length === 0) {
    outro(renderScanTotalsLine(scan.result.totals.folders, scan.result.totals.size))
    return scan.result.permissionIssues.length > 0 ? 4 : 2
  }

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

  const selected: ScanEntry[] = (picked as string[])
    .map((path_) => selectableSet.get(path_))
    .filter((entry): entry is ScanEntry => entry !== undefined)
  if (selected.length === 0) {
    outro('nothing selected — bye 👋')
    return 0
  }

  const modeChoice = await select({
    message: 'How should these die?',
    options: [
      { value: 'trash', label: 'Move to OS trash — safe & restorable (recommended)' },
      { value: 'hard', label: 'Delete permanently — there is no undo' },
    ],
    initialValue: 'trash',
  })
  if (isCancel(modeChoice)) {
    outro('cancelled — nothing deleted')
    return 0
  }
  const mode = modeChoice as DeleteMode

  const totalSize = sum(selected)
  const admitted = await confirm({
    message:
      mode === 'hard'
        ? `Delete ${selected.length} folder(s) — ${formatBytes(totalSize)} — PERMANENTLY (no undo)?`
        : `Move ${selected.length} folder(s) — ${formatBytes(totalSize)} — to the OS trash?`,
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

function sum(entries: ScanEntry[]): number {
  return entries.reduce((acc, entry) => acc + entry.size, 0)
}

function renderScanTotalsLine(folders: number, size: number): string {
  if (folders === 0) return 'nothing found 🙃'
  return `💾 found ${folders} folder(s) — ${formatBytes(size)} (nothing deleted)`
}
