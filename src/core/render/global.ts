import Table from 'cli-table3'
import { colors, colorEnabled } from '../../utils/logger.ts'
import { t } from '../../i18n/index.ts'
import { formatBytes } from '../../utils/format.ts'
import { shortenPath } from './shared.ts'
import { toolVersion } from '../../utils/version.ts'
import type { GlobalDuplicate, GlobalOutcome, GlobalPmReport } from '../result.ts'

export function renderGlobalReport(outcome: GlobalOutcome, request: { cwd: string }): string {
  const lines: string[] = []
  lines.push(colors.cyan(t('render.global.title')))
  lines.push(colors.dim(t('render.global.readonly')))
  lines.push('')
  const attempted = ['npm', 'pnpm', 'yarn', 'bun']
  lines.push(t('render.global.pmDetected', { pms: outcome.reports.map((report) => report.pm).join(', ') || '—', skipped: skippedSuffix(outcome, attempted) }))
  lines.push(t('render.global.total', { count: outcome.totals.packages, size: formatBytes(outcome.totals.size) }))
  lines.push('')

  for (const report of outcome.reports) {
    lines.push(colors.bold(`${report.pm} · ${shortenPath(report.root, request.cwd)}`))
    lines.push(globalPackageTable(report, outcome.duplicates))
    if (report.dead.length > 0) {
      lines.push(colors.yellow(t('render.global.dead', { pm: report.pm, count: report.dead.length })))
      for (const dead of report.dead.slice(0, 5)) {
        lines.push(colors.yellow(`  - ${dead.name} → ${dead.detail} (${dead.kind})`))
      }
      if (report.dead.length > 5) lines.push(colors.yellow(t('render.global.more', { n: report.dead.length - 5 })))
    }
    lines.push('')
  }

  if (outcome.duplicates.length > 0) {
    const savings = outcome.duplicates.reduce((sum, dup) => sum + dup.savings, 0)
    lines.push(colors.yellow(t('render.global.crossDup', { count: outcome.duplicates.length, size: formatBytes(savings) })))
    for (const dup of outcome.duplicates.slice(0, 8)) {
      lines.push(`  - ${dup.name}: ${dup.pms.join(' + ')}`)
    }
    if (outcome.duplicates.length > 8) lines.push(t('render.global.more', { n: outcome.duplicates.length - 8 }))
    lines.push('')
  }
  if (outcome.permissionIssues.length > 0) {
    lines.push(colors.yellow(t('render.global.unreadable', { count: outcome.permissionIssues.length })))
  }
  return lines.join('\n')
}

function skippedSuffix(outcome: GlobalOutcome, attempted: string[]): string {
  const skipped = attempted.filter((pm) => !outcome.reports.some((report) => report.pm === pm))
  return skipped.length > 0 ? colors.dim(t('render.global.notFound', { list: skipped.join(', ') })) : ''
}

function globalPackageTable(report: GlobalPmReport, duplicates: GlobalDuplicate[]): string {
  const table = new Table({
    head: [colors.dim(t('render.global.head.package')), colors.dim(t('render.global.head.version')), colors.dim(t('common.size')), colors.dim(t('common.pm'))],
    style: { head: [], border: colorEnabled() ? ['gray'] : [] },
  })
  const dupNames = new Set(duplicates.map((dup) => dup.name))
  for (const pkg of report.packages) {
    table.push([
      colors.bold(pkg.name) + (dupNames.has(pkg.name) ? colors.dim(t('render.global.multiPm')) : ''),
      pkg.version ?? '—',
      formatBytes(pkg.size ?? 0),
      report.pm,
    ])
  }
  return table.toString()
}

export function renderGlobalJson(outcome: GlobalOutcome, request: { pmFilter?: string[] | null }): string {
  const payload = {
    nmh: toolVersion(),
    command: 'stats',
    mode: 'global',
    pmFilter: request.pmFilter ?? null,
    totals: {
      ...outcome.totals,
      sizeFormatted: formatBytes(outcome.totals.size),
    },
    duplicates: outcome.duplicates.map((dup) => ({ ...dup, savingsFormatted: formatBytes(dup.savings) })),
    pms: outcome.reports.map((report) => ({
      pm: report.pm,
      root: report.root,
      binDir: report.binDir,
      source: report.source,
      dead: report.dead,
      packages: report.packages.map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        symlinked: pkg.symlinked,
        size: pkg.size,
        sizeFormatted: pkg.size == null ? null : formatBytes(pkg.size),
      })),
    })),
    skippedPms: outcome.skippedPms,
    permissionIssues: outcome.permissionIssues,
  }
  return JSON.stringify(payload, null, 2)
}

