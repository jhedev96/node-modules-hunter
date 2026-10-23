import { confirm, select, isCancel } from '@clack/prompts'
import { collectScan } from './scan.ts'
import { deleteEntries } from '../core/deleter.ts'
import { partitionTargets, describeGuard } from '../core/guards.ts'
import { renderDeleteJson, renderDeleteSummary, renderPlan, shortenPath } from '../core/render.ts'
import { writeDeleteLog } from '../utils/delete-log.ts'
import { clearProgress, errorLog, isSilent, isTTYOut, log, progressLine, warn, payload } from '../utils/logger.ts'
import { formatBytes } from '../utils/format.ts'
import { toolVersion } from '../utils/version.ts'
import type { DeleteMode, DeleteOutcome, DeleteOutcomeRow, ScanEntry } from '../core/result.ts'

export interface DeleteFlowRequest {
  /** User-given targets; empty → cwd. */
  targets: string[]
  cwd: string
  /** null = not specified → ask interactively (TTY) or refuse (non-TTY). */
  mode: DeleteMode | null
  dryRun: boolean
  /** --yes or --force (force implies yes). */
  assumeYes: boolean
  json: boolean
  maxDepth?: number
  /** -r: nested node_modules inside entries become individual victims too. */
  recursive?: boolean
  /** --exclude globs. */
  excludes?: string[]
  /** --keep: never delete node_modules of these projects. */
  keep?: string[]
  /** --pm filter: families and/or 'vp'. */
  pmFilter?: string[]
  /**
   * abort (default): any guarded target aborts the whole run (exit 3).
   * filter: garbage-collector semantics (clean/wizard) — skip guarded, warn, continue.
   */
  blockedMode?: 'abort' | 'filter'
}

export interface ExecuteRequest {
  mode: DeleteMode
  json: boolean
  /** wizard renders its own outro. */
  quietSummary?: boolean
}

/** Shared executor for delete/clean/wizard: run deletion, render, log to ~/.nmh/logs. */
export async function executeAll(
  entries: ScanEntry[],
  request: ExecuteRequest,
): Promise<{ code: number; outcome: DeleteOutcome }> {
  const outcome = await deleteEntries(entries, {
    mode: request.mode,
    onRow: (_row: DeleteOutcomeRow, done: number, total: number) => {
      progressLine(`🗑  ${done}/${total} folders…`)
    },
  })
  clearProgress()

  if (request.json) payload(renderDeleteJson(outcome, request.mode, false))
  else {
    const summary = renderDeleteSummary(outcome, request.mode)
    if (summary) log(summary)
  }

  await writeDeleteLog({
    mode: request.mode,
    results: outcome.results,
    freed: outcome.freed,
    deleted: outcome.deleted,
    failed: outcome.failed,
  })

  const code = outcome.permissionDenied ? 4 : outcome.failed > 0 ? 1 : 0
  return { code, outcome }
}

export async function runDelete(request: DeleteFlowRequest): Promise<number> {
  return deleteFlow(request)
}

/** The full delete pipeline: scan → guards → mode → dry-run/confirm → execute. */
export async function deleteFlow(request: DeleteFlowRequest): Promise<number> {
  const scan = await collectScan({
    targets: request.targets,
    cwd: request.cwd,
    maxDepth: request.maxDepth,
    recursive: request.recursive,
    excludes: request.excludes,
    keep: request.keep,
    pmFilter: request.pmFilter,
  })

  // Unresolvable user targets are an explicit guard case (PRD §6.3 symlink loops first-class).
  if (scan.result.unresolvable.length > 0) {
    for (const suspect of scan.result.unresolvable) {
      errorLog(`🛑 ${shortenPath(suspect, request.cwd)} — refusing: cannot resolve real path (symlink loop?)`)
    }
    if (request.blockedMode !== 'filter') {
      errorLog('delete aborted — safety guard refused; nothing was deleted (exit 3)')
      return 3
    }
    warn(`${scan.result.unresolvable.length} unresolvable target(s) skipped`)
  }

  const all = scan.result.entries

  if (all.length === 0) {
    if (!request.json) warn('no node_modules found — nothing to hunt here 🙃')
    return scan.result.permissionIssues.length > 0 ? 4 : 2
  }

  const { safe, blocked } = await partitionTargets(all.map((entry) => entry.path))
  const safeSet = new Set(safe)
  const safeEntries = all.filter((entry) => safeSet.has(entry.path))

  if (blocked.length > 0) {
    for (const item of blocked) {
      errorLog(`🛑 ${shortenPath(item.path, request.cwd)} — ${describeGuard(item.verdict)}`)
    }
    if (request.blockedMode !== 'filter') {
      errorLog('delete aborted — safety guard refused; nothing was deleted (exit 3)')
      return 3
    }
    warn(`${blocked.length} target(s) skipped by safety guard — continuing with the safe ones`)
  }

  if (safeEntries.length === 0) return 2

  const mode = await resolveMode(request.mode, request.json, request.dryRun)
  if (mode === null) return 1 // refusal already logged (non-TTY without value)
  if (mode === 'cancelled') return 0

  const totalSize = safeEntries.reduce((sum, entry) => sum + entry.size, 0)

  if (request.dryRun) {
    if (request.json) payload(planJson(safeEntries, mode, true))
    else log(renderPlan(safeEntries, mode))
    return 0
  }

  if (request.json && !request.assumeYes) {
    // v0.9.2: TTY no longer exempts --json — machine output has no interactive prompt slot,
    // so a TTY --json run used to hard-delete with zero confirmation. --yes is the only door.
    warn('--json deletes require an explicit --yes (or --force) — there is no interactive confirm inside --json; nothing was deleted')
    return 1
  }

  if (request.json) {
    const { code } = await executeAll(safeEntries, { mode, json: true })
    return code
  }

  if (!request.assumeYes) {
    if (!isTTYOut()) {
      warn('non-interactive shell — nothing deleted without --yes (tip: --dry-run previews first)')
      log(renderPlan(safeEntries, mode, { maxShown: 10 }).replace('[DRY RUN]', '[NOT EXECUTED]'))
      return 1
    }
    const admitted = await confirmDeletion(safeEntries.length, totalSize, mode)
    if (admitted !== true) {
      if (!isSilent()) log('cancelled — nothing deleted')
      return 0
    }
  }

  const { code } = await executeAll(safeEntries, { mode, json: false })
  return code
}

async function resolveMode(
  requested: DeleteMode | null,
  json: boolean,
  dryRun: boolean,
): Promise<DeleteMode | 'cancelled' | null> {
  if (requested) return requested
  if (json) return 'trash' // JSON callers are scripts; pick the safe default, never prompt
  if (!isTTYOut()) {
    errorLog('--delete without a value needs an interactive terminal — pass hard | soft | trash (soft = trash)')
    return null
  }
  if (!dryRun) {
    const choice = await select({
      message: 'Deletion mode:',
      options: [
        { value: 'trash', label: 'trash — move to OS bin (safe, restorable) · recommended' },
        { value: 'hard', label: 'hard — delete permanently · no undo' },
      ],
      initialValue: 'trash',
    })
    if (isCancel(choice)) return 'cancelled'
    return choice as DeleteMode
  }
  return 'trash'
}

async function confirmDeletion(count: number, size: number, mode: DeleteMode): Promise<boolean> {
  const answer = await confirm({
    message:
      mode === 'hard'
        ? `Delete ${count} folder(s) — ${formatBytes(size)} — PERMANENTLY (no undo)?`
        : `Move ${count} folder(s) — ${formatBytes(size)} — to the OS trash?`,
    initialValue: mode !== 'hard',
  })
  return answer === true
}

function planJson(entries: ScanEntry[], mode: DeleteMode, dryRun: boolean): string {
  const size = entries.reduce((sum, entry) => sum + entry.size, 0)
  return JSON.stringify(
    {
      nmh: toolVersion(),
      command: 'delete',
      mode,
      dryRun,
      totals: { folders: entries.length, size, sizeFormatted: formatBytes(size) },
      results: entries.map((entry) => ({
        path: entry.path,
        status: `would-${mode}`,
        size: entry.size,
        sizeFormatted: formatBytes(entry.size),
      })),
    },
    null,
    2,
  )
}
