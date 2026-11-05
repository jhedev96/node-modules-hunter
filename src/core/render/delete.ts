import { colors } from '../../utils/logger.ts'
import { t } from '../../i18n/index.ts'
import { formatBytes } from '../../utils/format.ts'
import { shortenPath, totalsJson } from './shared.ts'
import { toolVersion } from '../../utils/version.ts'
import type { DeleteMode, DeleteOutcome, ScanEntry } from '../result.ts'

export function renderPlan(
  entries: ScanEntry[],
  mode: DeleteMode,
  options: { maxShown?: number; dryRun?: boolean } = {},
): string {
  const shown = options.maxShown ?? 20
  const modeLabel = mode === 'hard' ? t('render.plan.hardLabel') : t('render.plan.trashLabel')
  const total = entries.reduce((sum, entry) => sum + entry.size, 0)

  const header = options.dryRun === false
    ? t('render.plan.notExecuted', { label: modeLabel, count: entries.length, size: formatBytes(total) })
    : t('render.plan.dryRun', { label: modeLabel, count: entries.length, size: formatBytes(total) })
  const lines = [header]
  for (const entry of entries.slice(0, shown)) {
    lines.push(
      `  ${colors.red('✗')} ${entry.displayPath} ${colors.dim(`(${formatBytes(entry.size)}${entry.pm.family === 'unknown' ? '' : `, ${entry.pm.family}`})`)}`,
    )
  }
  if (entries.length > shown) lines.push(colors.dim(t('render.plan.more', { n: entries.length - shown })))
  lines.push(t('render.plan.rerun'))
  return lines.join('\n')
}

export function renderDeleteSummary(outcome: DeleteOutcome, mode: DeleteMode): string {
  const verb = mode === 'hard' ? t('render.delete.verbHard') : t('render.delete.verbTrash')
  const lines: string[] = []
  if (outcome.deleted > 0) {
    lines.push(t('render.delete.deleted', { verb, size: formatBytes(outcome.freed), count: outcome.deleted }))
  }
  if (outcome.failed > 0) {
    lines.push(colors.yellow(t('render.delete.failed', { count: outcome.failed })))
  }
  return lines.join('\n')
}

export function renderDeleteJson(
  outcome: DeleteOutcome,
  mode: DeleteMode,
  dryRun: boolean,
): string {
  const payload = {
    nmh: toolVersion(),
    command: 'delete',
    mode,
    dryRun,
    totals: totalsJson({
      folders: outcome.results.length,
      size: outcome.results.reduce((sum, row) => sum + row.size, 0),
      packages: 0,
    }),
    freed: outcome.freed,
    deleted: outcome.deleted,
    failed: outcome.failed,
    results: outcome.results.map((row) => ({
      path: row.path,
      status: row.status,
      size: row.size,
      sizeFormatted: formatBytes(row.size),
      error: row.error ?? null,
      // v1.1 additive — trash backend per row, only when trash mode ran
      ...(row.backend !== undefined ? { backend: row.backend } : {}),
    })),
    // v1.1 additive — nmh-internal trash batch dir / fallback flag, only when used
    ...(outcome.trashBatch !== undefined ? { trashBatch: outcome.trashBatch } : {}),
    ...(outcome.trashFallback === true ? { trashFallback: true } : {}),
  }
  return JSON.stringify(payload, null, 2)
}
