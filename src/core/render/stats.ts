import { colors, isSilent, colorEnabled } from '../../utils/logger.ts'
import { t } from '../../i18n/index.ts'
import { formatBytes, formatAge, formatCo2, formatDuration, formatIdle } from '../../utils/format.ts'
import { toolVersion } from '../../utils/version.ts'
import { pmLabel, shortenPath, signedBytes } from './shared.ts'
import { renderMapTree } from './map.ts'
import { renderGlobalReport } from './global.ts'
import { renderDepsAudit } from './why.ts'
import { BaselineJsonExtra } from './baseline.ts'
import type { BaselineComparison } from '../../utils/baseline.ts'
import type { MapOutcome, MapProjectInfo, PMInfo, StatsOutcome, StatsPackageGroup, StatsTypeBreakdown } from '../result.ts'

export interface RenderStatsOptions {
  cwd: string
  expand?: boolean
  topN: number
  by: 'package' | 'size' | 'type' | 'licenses' | null
  /** --licenses (or --by licenses): show + focus the LICENSES section. */
  licenses?: boolean
  /** --graph: show + focus the lockfile-grade GRAPH section. */
  graph?: boolean
  /** --phantom/--dead focus: which halves of the audit to show. */
  audit?: 'phantom' | 'dead' | 'both' | null
}

function projectBadges(projects: MapProjectInfo[]): string {
  return `${projects.length} node_modules`
}

export function renderStatsReport(outcome: StatsOutcome, options: RenderStatsOptions): string {
  const { overview } = outcome
  const dim = colors.dim
  const lines: string[] = []

  lines.push(colors.cyan(t('render.stats.title', { badges: projectBadges(outcome.projects) }) + (overview.waste > 0 ? dim(t('render.stats.dedupPotential')) : '')))
  lines.push('')
  lines.push(`━━━ ${colors.bold(t('render.section.overview'))} ━━━`)
  lines.push(t('render.stats.totalSize', { size: formatBytes(overview.totalSize), count: overview.entryCount }))
  lines.push(
    t('render.stats.packages', { instances: overview.instances, unique: overview.unique, dup: overview.dupFactor }),
  )
  if (overview.symlinked > 0) {
    lines.push(colors.dim(t('render.stats.symlinkedNote', { count: overview.symlinked })))
  }
  if (overview.declared !== null) {
    lines.push(t('render.stats.directDeps', { count: overview.declared }))
  }
  lines.push(t('render.stats.waste', { size: formatBytes(overview.waste), percent: overview.wastePercent }))

  if (options.by === 'type') {
    // focused view (§8.1): overview + BY TYPE only — TOP/dedup sections stay hidden
    lines.push('')
    lines.push(`━━━ ${colors.bold(t('render.section.byType'))} ━━━`)
    for (const row of outcome.typeBreakdown) {
      if (row.packages === 0) continue
      lines.push(`${row.field.padEnd(22)}: ${formatBytes(row.size)} · ${row.packages} pkg`)
    }
  }

  if (options.by === 'licenses' || options.licenses === true) {
    // focused view (§8.1/§8.2): overview + LICENSES only
    lines.push('')
    lines.push(`━━━ ${colors.bold(t('render.section.licenses'))} ━━━`)
    if (outcome.licenseBreakdown.length === 0) {
      lines.push(colors.dim(t('render.stats.noLicenses')))
    }
    for (const row of outcome.licenseBreakdown) {
      const marker =
        row.production && row.copyleft
          ? colors.yellow(t('render.stats.copyleftProd'))
          : row.copyleft
            ? colors.dim(t('render.stats.copyleftOther'))
            : ''
      lines.push(`${row.type.padEnd(24)}: ${formatBytes(row.size)} · ${row.packages} pkg${marker}`)
    }
  }

  if (outcome.score !== null || outcome.co2 !== null) {
    // experimental focus (§8.2): overview + SCORE/CO2 only
    lines.push('')
    lines.push(`━━━ ${colors.bold(outcome.score !== null ? t('render.section.score') : t('render.section.co2'))} ━━━ ${colors.dim(t('render.stats.experimental'))}`)
    if (outcome.score !== null) {
      const { score, grade, components } = outcome.score
      const filled = Math.round((score / 100) * 20)
      lines.push(
        `${String(score).padStart(3)} / 100  ${t('render.stats.grade')} ${grade}  [${'█'.repeat(filled)}${'░'.repeat(20 - filled)}]`,
      )
      lines.push(`${colors.dim(t('render.stats.wasteLabel'))}  ${components.wastePercent}%  → ${components.wastePoints} pt`)
      lines.push(`${colors.dim(t('render.stats.dupLabel'))}  ${components.dupFactor}×  → ${components.dupPoints} pt`)
      if (components.deadPackages > 0) {
        lines.push(`${colors.dim(t('render.stats.deadLabel'))}  ${components.deadPercent}% (${components.deadPackages} pkg)  → ${components.deadPoints} pt`)
      } else {
        lines.push(`${colors.dim(t('render.stats.deadLabel'))}  ${t('render.stats.deadNotAudited')}  → 0 pt`)
      }
      lines.push(`${colors.dim(t('render.stats.sizeLabel'))}  ${formatBytes(outcome.overview.totalSize)}  → ${components.sizePoints} pt`)
    }
    if (outcome.co2 !== null) {
      lines.push(`${colors.dim(t('render.stats.co2Storage'))}: ${formatCo2(outcome.co2.storageGrams)}`)
      lines.push(`${colors.dim(t('render.stats.co2Transfer'))}: ${formatCo2(outcome.co2.transferGrams)}`)
    }
  }

  if (outcome.deprecations !== null) {
    // --online focus (§5.4/§8.2): overview + DEPRECATED only
    lines.push('')
    lines.push(`━━━ ${colors.bold(t('render.section.deprecated'))} ━━━`)
    const { count, refs } = outcome.deprecations
    if (count === 0) {
      lines.push(colors.dim(t('render.stats.deprecatedNone')))
    } else {
      lines.push(t('render.stats.deprecatedCount', { count }))
      const shown = refs.slice(0, 10)
      for (const ref of shown) {
        const note = ref.message && ref.message.length > 0 ? ` — ${ref.message}` : ''
        const tag = ref.source === 'registry' ? colors.dim(' [registry]') : ''
        lines.push(`${colors.yellow(`${ref.name}${ref.version ? `@${ref.version}` : ''}`)}${tag}  ${ref.displayPath}${note}`)
      }
      if (refs.length > shown.length) lines.push(colors.dim(t('render.stats.moreDeprecations', { n: refs.length - shown.length })))
    }
  }

  if (outcome.graph !== null) {
    // --graph focus (PRD §8.2 v0.6): lockfile-grade dependency graph per entry
    lines.push('')
    lines.push(
      `━━━ ${colors.bold(t('render.section.graph'))} ━━━ ${colors.dim(outcome.graph.fullEntries === outcome.graph.totalEntries ? t('render.stats.lockfileGrade') : `${colors.yellow(`${outcome.graph.fullEntries}/${outcome.graph.totalEntries}`)} ${t('render.stats.graphSuffix')}`)}`,
    )
    lines.push(
      t('render.stats.graphRoot', { declared: outcome.graph.rootDirect, nodes: outcome.graph.nodes, edges: outcome.graph.edges }),
    )
    if (outcome.graph.depthHistogram.length === 0) {
      lines.push(colors.dim(t('render.stats.graphNoDepth')))
    }
    for (const bucket of outcome.graph.depthHistogram) {
      const filled = Math.max(1, Math.min(20, bucket.packages))
      lines.push(`depth ${String(bucket.depth).padStart(2)}    : ${'█'.repeat(filled).padEnd(20)} ${bucket.packages}`)
    }
    if (outcome.graph.unreachable > 0) {
      lines.push(colors.dim(t('render.stats.graphUnreachable', { n: outcome.graph.unreachable })))
    }
    for (const row of outcome.graph.entries) {
      const detail = row.grade === 'full'
        ? `${row.file} · ${row.nodes} nodes · ${row.edges} edges · direct ${row.rootDirect}`
        : colors.dim(t('render.stats.noLockfile'))
      lines.push(`· ${row.displayPath}  ${colors.dim(row.pm)} ${detail}`)
    }
  }

  if (outcome.reinstall !== null) {
    // --reinstall focus (§8.2 v0.6): naive npm ci-style estimate
    lines.push('')
    lines.push(`━━━ ${colors.bold(t('render.section.reinstall'))} ━━━ ${colors.dim(t('render.stats.reinstallNaive'))}`)
    lines.push(t('render.stats.reinstallLine', { duration: formatDuration(outcome.reinstall.seconds) }))
    lines.push(colors.dim(`· ${outcome.reinstall.formula}`))
  }

  const focused =
    options.by === 'type' || options.by === 'licenses' || options.licenses === true ||
    outcome.score !== null || outcome.co2 !== null || outcome.deprecations !== null ||
    outcome.graph !== null ||
    outcome.reinstall !== null ||
    (options.audit ?? null) !== null

  if (outcome.depsAudit !== null && (options.audit ?? null) !== null) {
    lines.push('')
    lines.push(renderDepsAudit(outcome.depsAudit, options.audit ?? 'both'))
  }

  const top = options.by === 'type' || focused ? [] : outcome.sizeGroups.slice(0, options.topN)
  if (top.length > 0) {
    lines.push('')
    lines.push(`━━━ ${colors.bold(t('render.section.top', { n: options.topN }))} ━━━`)
    top.forEach((group, index) => {
      const rank = String(index + 1).padStart(2)
      const copies = group.copies > 1 ? colors.yellow(t('render.stats.copies', { n: group.copies })) : dim(t('render.stats.oneCopy'))
      const saving =
        group.dedupableSize !== undefined
          ? dim(t('render.stats.dedupSaving', { size: formatBytes(group.dedupableSize) }))
          : ''
      lines.push(`${rank}. ${group.name}  ${copies}  ${formatBytes(group.totalSize)}${saving}`)
    })
    if (options.by === 'package' && outcome.sizeGroups.length > top.length) {
      const rest = outcome.sizeGroups.slice(options.topN)
      const restCount = rest.reduce((sum, group) => sum + group.copies, 0)
      const restSize = rest.reduce((sum, group) => sum + group.totalSize, 0)
      lines.push('')
      lines.push(`━━━ ${colors.bold(t('render.section.longTail'))} ━━━`)
      lines.push(dim(t('render.stats.longTail', { names: rest.length, instances: restCount, size: formatBytes(restSize) })))
    }
  }

  if (!focused && outcome.dedupSuggestions.length > 0) {
    lines.push('')
    lines.push(`━━━ ${colors.bold(t('render.section.dedup'))} ━━━`)
    outcome.dedupSuggestions.forEach((suggestion, index) => {
      const rank = String(index + 1).padStart(2)
      const version = suggestion.version !== null ? `@${suggestion.version}` : ''
      lines.push(`${rank}. ${colors.bold(suggestion.name + version)}  ${dim(t('render.stats.copies', { n: suggestion.instances.length }))}  ${colors.yellow(signedBytes(suggestion.save))}${dim(t('render.stats.bisaHemat'))}`)
      for (const inst of suggestion.instances) {
        const declared =
          inst.projectName !== null && inst.declaredRange !== null
            ? t('render.stats.declaredRange', { project: inst.projectName, range: inst.declaredRange, field: inst.declaredField ?? 'null' })
            : t('render.stats.transitive')
        lines.push(`    · ${inst.displayPath} (${inst.pm}) · ${formatBytes(inst.size ?? 0)} · ${declared}`)
      }
      lines.push(`    ${dim(`↳ ${suggestion.hint}`)}`)
    })
  }

  if (outcome.permissionIssues.length > 0) {
    lines.push(colors.yellow(t('render.warn.permission', { n: outcome.permissionIssues.length })))
  }
  return lines.join('\n')
}

export function renderStatsJson(
  outcome: StatsOutcome,
  request: { tree?: boolean; topN?: number; by?: 'package' | 'type' | 'size' | 'licenses'; licenses?: boolean; score?: boolean; co2?: boolean; online?: boolean; graph?: boolean; reinstall?: boolean },
  extra?: { baseline?: BaselineJsonExtra },
): string {
  const payload = {
    nmh: toolVersion(),
    command: 'stats',
    mode: request.tree === true ? 'tree' : request.by ?? (request.score === true ? 'score' : request.co2 === true ? 'co2' : request.graph === true ? 'graph' : request.reinstall === true ? 'reinstall' : request.licenses === true ? 'licenses' : request.online === true ? 'deprecated' : 'report'),
    baseline: extra?.baseline ?? null,
    overview: outcome.overview,
    permissionIssues: outcome.permissionIssues,
    sizeGroups: outcome.sizeGroups,
    dedupSuggestions: outcome.dedupSuggestions,
    typeBreakdown: outcome.typeBreakdown,
    licenseBreakdown: outcome.licenseBreakdown,
    graph: outcome.graph,
    score: outcome.score,
    co2: outcome.co2,
    reinstall: outcome.reinstall,
    deprecations: outcome.deprecations,
    depsAudit: outcome.depsAudit,
    projects: outcome.projects.map((project) => ({
      project: project.project,
      path: project.entry.path,
      displayPath: project.entry.displayPath,
      pm: project.entry.pm.family,
      pmVp: project.entry.pm.vp,
      nested: project.entry.nested === true,
      ownerPath: project.entry.ownerPath ?? project.entry.path,
      size: project.entry.size,
      topPackagesCount: project.topPackages.length,
      topPackages: project.topPackages.map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        symlinked: pkg.symlinked,
        size: pkg.size,
        sizeFormatted: pkg.size == null ? null : formatBytes(pkg.size),
      })),
      declared:
        project.declared === null
          ? null
          : {
              projectDir: project.declared.projectDir,
              projectName: project.declared.name,
              dependencies: project.declared.dependencies,
              devDependencies: project.declared.devDependencies,
            },
    })),
  }
  return JSON.stringify(payload, null, 2)
}
