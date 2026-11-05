import Table from 'cli-table3'
import { colors, colorEnabled } from '../../utils/logger.ts'
import { t } from '../../i18n/index.ts'
import { formatBytes } from '../../utils/format.ts'
import { shortenPath, signedBytes } from './shared.ts'
import type { BaselineComparison, BaselineListItem } from '../../utils/baseline.ts'

export interface BaselineJsonExtra {
  saved?: { name: string; createdAt?: string; file?: string }
  compare?: BaselineComparison | null
}
export function renderBaselineCompare(comp: BaselineComparison): string {
  const lines: string[] = []
  lines.push(`━━━ ${colors.bold(t('render.section.baseline'))} ━━━`)
  lines.push(t('render.baseline.saved', { name: comp.baselineName, date: comp.baselineCreatedAt }))
  const pct =
    comp.totalDeltaPercent === null ? '' : ` (${comp.totalDeltaPercent > 0 ? '+' : comp.totalDeltaPercent < 0 ? '−' : '±'}${Math.abs(comp.totalDeltaPercent)}%)`
  lines.push(t('render.baseline.totalSize', { delta: signedBytes(comp.totalDelta), pct, before: formatBytes(comp.totalBefore), after: formatBytes(comp.totalAfter) }))
  lines.push(t('render.baseline.packages', { delta: signedBytes(comp.packagesDelta) }))

  const changed = comp.deltas.filter((delta) => delta.kind !== 'same')
  if (changed.length > 0) {
    lines.push('')
    const table = new Table({
      head: [colors.dim(t('common.path')), colors.dim(t('render.baseline.headBefore')), colors.dim(t('render.baseline.headNow')), colors.dim(t('render.baseline.headDelta'))],
      style: { head: [], border: colorEnabled() ? ['gray'] : [] },
    })
    for (const delta of changed.slice(0, 15)) {
      const marker =
        delta.kind === 'new'
          ? colors.yellow(t('render.baseline.new'))
          : delta.kind === 'gone'
            ? colors.dim(t('render.baseline.gone'))
            : ''
      table.push([
        marker ? `${delta.rel} ${marker}` : delta.rel,
        delta.before === null ? '—' : formatBytes(delta.before),
        delta.after === null ? '—' : formatBytes(delta.after),
        delta.delta >= 0 ? colors.yellow(signedBytes(delta.delta)) : signedBytes(delta.delta),
      ])
    }
    lines.push(table.toString())
    if (changed.length > 15) {
      lines.push(colors.dim(t('render.baseline.moreChanged', { n: changed.length - 15 })))
    }
  }

  if (comp.packageMovers.length > 0) {
    lines.push('')
    lines.push(t('render.baseline.movers'))
    comp.packageMovers.slice(0, 5).forEach((mover, index) => {
      const rank = String(index + 1).padStart(2)
      const delta = mover.delta >= 0 ? colors.yellow(signedBytes(mover.delta)) : signedBytes(mover.delta)
      lines.push(`${rank}. ${mover.name}  ${delta}`)
    })
  }

  if (Math.abs(comp.totalDelta) > 0 && comp.totalBefore > 0 && comp.totalDeltaPercent !== null && comp.totalDeltaPercent > 30) {
    lines.push(colors.yellow(t('render.baseline.bloatGrowth')))
  }
  return lines.join('\n')
}

export function renderBaselineHistory(items: BaselineListItem[], cwd: string): string {
  const lines: string[] = []
  lines.push(colors.cyan(t('render.baselineHistory.title', { count: items.length })))
  if (items.length === 0) {
    lines.push(colors.dim(t('render.baselineHistory.saveHint')))
    return lines.join('\n')
  }
  const table = new Table({
    head: [colors.dim(t('render.baselineHistory.head.name')), colors.dim(t('render.baselineHistory.head.saved')), colors.dim(t('common.size')), colors.dim(t('render.baselineHistory.head.modules')), colors.dim(t('render.baselineHistory.head.where'))],
    style: { head: [], border: colorEnabled() ? ['gray'] : [] },
  })
  for (const item of items) {
    table.push([
      item.name + (item.cwd === cwd ? colors.yellow(t('render.baselineHistory.thisDir')) : ''),
      item.createdAt.replace('T', ' ').replace(/\..*/, '').replace(/Z$/, ''),
      formatBytes(item.totals.size ?? 0),
      String(item.totals.folders ?? 0),
      shortenPath(item.cwd, cwd, 40),
    ])
  }
  lines.push(table.toString())
  return lines.join('\n')
}
