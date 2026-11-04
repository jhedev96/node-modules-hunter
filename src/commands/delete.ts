import { confirm, select, isCancel } from '@clack/prompts'
import { note } from '../utils/logger.ts'
import { collectScan } from './scan.ts'
import { deleteEntries } from '../core/deleter.ts'
import { partitionTargets, describeGuard } from '../core/guards.ts'
import { renderDeleteJson, renderDeleteSummary, renderPlan, shortenPath } from '../core/render.ts'
import { writeDeleteLog } from '../utils/delete-log.ts'
import { spinUpdate, spinClear, errorLog, isSilent, isTTYOut, log, warn, payload } from '../utils/logger.ts'
import { formatBytes } from '../utils/format.ts'
import { toolVersion } from '../utils/version.ts'
import { t } from '../i18n/index.ts'
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
  /** --stale <days> (v1.1): only projects idle >= N days (git activity signal) become victims. */
  stale?: number
  /** --trash=system|nmh (v1.1): which trash takes victims in trash mode. Default: system. */
  trashMode?: 'system' | 'nmh'
  /** --no-skip (v1.1): don't hide .Trash*, Library/, and *.app dirs while discovering. Default: skip. */
  skipSystem?: boolean
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
  /** --trash=system|nmh (v1.1): which trash takes victims in trash mode. Default: system. */
  trashMode?: 'system' | 'nmh'
}

/** Shared executor for delete/clean/wizard: run deletion, render, log to ~/.nmh/logs. */
export async function executeAll(
  entries: ScanEntry[],
  request: ExecuteRequest,
): Promise<{ code: number; outcome: DeleteOutcome }> {
  const outcome = await deleteEntries(entries, {
    mode: request.mode,
    trashMode: request.trashMode,
    onRow: (_row: DeleteOutcomeRow, done: number, total: number) => {
      spinUpdate(t('delete.spin.progress', { done, total }))
    },
  })
  spinClear()

  if (request.json) payload(renderDeleteJson(outcome, request.mode, false))
  else {
    const summary = renderDeleteSummary(outcome, request.mode)
    if (summary) log(summary)
    // v1.1: when the restorable nmh trash was used, say where it lives and how to undo.
    // stderr side-channels keep stdout clean for tables; --json carries the same data.
    if (outcome.trashBatch !== undefined) {
      if (outcome.trashFallback === true) {
        note(t('delete.note.trashFallback', { batch: outcome.trashBatch }))
      } else {
        note(t('delete.note.trashBatch', { batch: outcome.trashBatch }))
      }
    }
  }

  await writeDeleteLog({
    mode: request.mode,
    results: outcome.results,
    freed: outcome.freed,
    deleted: outcome.deleted,
    failed: outcome.failed,
    ...(outcome.trashBatch !== undefined ? { trashBatch: outcome.trashBatch } : {}),
    ...(outcome.trashFallback === true ? { trashFallback: true } : {}),
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
    stale: request.stale,
    skipSystem: request.skipSystem,
  })

  // Unresolvable user targets are an explicit guard case (PRD §6.3 symlink loops first-class).
  if (scan.result.unresolvable.length > 0) {
    for (const suspect of scan.result.unresolvable) {
      errorLog(t('delete.guard.unresolvable', { path: shortenPath(suspect, request.cwd) }))
    }
    if (request.blockedMode !== 'filter') {
      errorLog(t('delete.guard.abort'))
      return 3
    }
    warn(t('delete.warn.unresolvableSkipped', { n: scan.result.unresolvable.length }))
  }

  const all = scan.result.entries

  if (all.length === 0) {
    if (!request.json) warn(t('scan.warn.none'))
    return scan.result.permissionIssues.length > 0 ? 4 : 2
  }

  const { safe, blocked } = await partitionTargets(all.map((entry) => entry.path))
  const safeSet = new Set(safe)
  const safeEntries = all.filter((entry) => safeSet.has(entry.path))

  if (blocked.length > 0) {
    for (const item of blocked) {
      errorLog(t('delete.guard.blocked', { path: shortenPath(item.path, request.cwd), reason: describeGuard(item.verdict) }))
    }
    if (request.blockedMode !== 'filter') {
      errorLog(t('delete.guard.abort'))
      return 3
    }
    warn(t('delete.warn.guardSkipped', { n: blocked.length }))
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
    warn(t('delete.warn.jsonNeedsYes'))
    return 1
  }

  if (request.json) {
    const { code } = await executeAll(safeEntries, { mode, json: true, trashMode: request.trashMode })
    return code
  }

  if (!request.assumeYes) {
    if (!isTTYOut()) {
      warn(t('delete.warn.nonInteractive'))
      log(renderPlan(safeEntries, mode, { maxShown: 10, dryRun: false }))
      return 1
    }
    const admitted = await confirmDeletion(safeEntries.length, totalSize, mode)
    if (admitted !== true) {
      if (!isSilent()) log(t('delete.cancelled'))
      return 0
    }
  }

  const { code } = await executeAll(safeEntries, { mode, json: false, trashMode: request.trashMode })
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
    errorLog(t('cli.err.deleteNeedsTty'))
    return null
  }
  if (!dryRun) {
    const choice = await select({
      message: t('delete.select.mode'),
      options: [
        { value: 'trash', label: t('delete.select.trash') },
        { value: 'hard', label: t('delete.select.hard') },
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
        ? t('delete.confirm.hard', { count, size: formatBytes(size) })
        : t('delete.confirm.trash', { count, size: formatBytes(size) }),
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
