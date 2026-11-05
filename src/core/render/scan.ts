import Table from 'cli-table3'
import { colors, isSilent, colorEnabled } from '../../utils/logger.ts'
import { t } from '../../i18n/index.ts'
import { formatBytes, formatAge, formatIdle } from '../../utils/format.ts'
import { pmLabel, renderBar, totalsJson } from './shared.ts'
import { toolVersion } from '../../utils/version.ts'
import type { ScanCommandResult, ScanEntry, ScanTotals } from '../result.ts'

export interface RenderScanOptions {
  cwd: string
  json: boolean
  sizeMode: 'each' | 'total'
  /** --expand: full absolute paths instead of shortened display paths. */
  expand?: boolean
}

export function renderScanResult(result: ScanCommandResult, options: RenderScanOptions): string {
  if (options.json) return renderScanJson(result)
  if (options.sizeMode === 'total' || isSilent()) return renderScanTotals(result)
  return renderScanTable(result, options)
}

function renderScanTable(result: ScanCommandResult, options: RenderScanOptions): string {
  // v1.1: the Idle column appears only when activity data exists (--stale/--sort idle)
  const showIdle = result.entries.some((entry) => entry.idleDays !== undefined)
  // v1.1: Share bar scales against the largest entry; nested rows don't compete
  // (their bytes already belong to the owner's total)
  const maxSize = result.entries.reduce((max, entry) => (entry.nested === true ? max : Math.max(max, entry.size)), 0)
  const table = new Table({
    head: [
      colors.dim(t('common.path')),
      colors.dim(t('common.size')),
      colors.dim(t('common.share')),
      colors.dim(t('common.packages')),
      colors.dim(t('common.pm')),
      ...(showIdle ? [colors.dim(t('common.idle'))] : []),
      colors.dim(t('common.modified')),
    ],
    style: { head: [], border: colorEnabled() ? ['gray'] : [] },
  })

  const pushRow = (entry: ScanEntry, nested: boolean): void => {
    const display = options.expand === true ? entry.path : entry.displayPath
    const label = nested
      ? `${colors.dim('└─')}${colors.dim(t('render.scan.nested'))}${display}`
      : colors.bold(display)
    table.push([
      label,
      formatBytes(entry.size),
      nested ? colors.dim('·') : renderBar(entry.size, maxSize),
      entry.packageCount > 0 ? String(entry.packageCount) : '0',
      pmLabel(entry.pm),
      ...(showIdle ? [formatIdle(entry.idleDays)] : []),
      formatAge(entry.mtimeMs),
    ])
  }

  for (const entry of result.entries) {
    if (entry.nested) continue
    pushRow(entry, false)
    for (const child of result.entries) {
      if (child.nested && child.ownerPath === entry.path) pushRow(child, true)
    }
  }

  const lines = [table.toString(), renderScanTotals(result)]
  if (result.permissionIssues.length > 0) {
    lines.push(
      colors.yellow(t('render.warn.permission', { n: result.permissionIssues.length })),
    )
  }
  return lines.join('\n')
}

export function renderScanTotals(result: ScanCommandResult): string {
  const { totals } = result
  const nestedCount = result.entries.filter((entry) => entry.nested).length
  const nestedNote = nestedCount > 0 ? colors.dim(t('render.scan.nestedNote', { n: nestedCount })) : ''
  return t('render.scan.total', { size: formatBytes(totals.size), folders: totals.folders, packages: totals.packages }) + nestedNote
}

export function renderScanJson(result: ScanCommandResult): string {
  const payload = {
    nmh: toolVersion(),
    command: 'scan',
    totals: totalsJson(result.totals),
    permissionIssues: result.permissionIssues,
    unresolvable: result.unresolvable,
    entries: result.entries.map((entry) => ({
      path: entry.path,
      size: entry.size,
      sizeFormatted: formatBytes(entry.size),
      packageCount: entry.packageCount,
      pm: entry.pm.family,
      pmSources: entry.pm.sources,
      pmMultiple: entry.pm.multiple,
      pmVp: entry.pm.vp,
      pmProjectRoot: entry.pm.projectRoot,
      nested: entry.nested === true,
      ownerPath: entry.ownerPath ?? entry.path,
      // v1.1 additive — keys appear only when --stale/--sort idle ran (frozen-contract friendly)
      ...(entry.idleDays !== undefined
        ? { idleDays: entry.idleDays, activitySource: entry.activitySource }
        : {}),
      modifiedAt: entry.mtimeMs == null ? null : new Date(entry.mtimeMs).toISOString(),
    })),
  }
  return JSON.stringify(payload, null, 2)
}
