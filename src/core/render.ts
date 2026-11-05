import Table from 'cli-table3'
import path from 'node:path'
import { homedir } from 'node:os'
import { colors, isSilent, colorEnabled } from '../utils/logger.ts'
import { t } from '../i18n/index.ts'
import { formatBytes, formatAge, formatCo2, formatDuration, formatIdle } from '../utils/format.ts'
import { toolVersion } from '../utils/version.ts'
import type { BaselineComparison, BaselineListItem } from '../utils/baseline.ts'
import type {
  DeleteMode,
  DeleteOutcome,
  DepsAudit,
  GlobalDuplicate,
  GlobalOutcome,
  GlobalPmReport,
  MapOutcome,
  MapProjectInfo,
  PMInfo,
  ScanCommandResult,
  ScanEntry,
  SearchOutcome,
  StatsOutcome,
  StatsPackageGroup,
  StatsTypeBreakdown,
  ScanTotals,
  WhyOutcome,
} from './result.ts'

/** Absolute path → short display path: `~/…` for the home tree, `./…` for subpaths of cwd, middle-truncated. */
export function shortenPath(absolute: string, cwd: string, max = 56): string {
  let display = absolute
  const home = homedir()
  if (display === home) display = '~'
  else if (display.startsWith(home + path.sep)) display = '~' + display.slice(home.length)
  else if (display.startsWith(cwd + path.sep)) display = './' + display.slice(cwd.length + 1)
  else if (display === cwd) display = '.'

  const sep = display.includes('\\') ? '\\' : path.sep
  if (display.length > max) {
    const segments = display.split(sep)
    const tailMatters = segments.slice(-2).join(sep)
    const headStays = display.slice(0, Math.max(1, max - tailMatters.length - 1))
    display = `${headStays}${sep}…${sep}${tailMatters}`
  }
  return display
}

export function pmLabel(pm: PMInfo): string {
  if (pm.family === 'unknown') {
    const tag = pm.vp ? colors.magenta(' [vp]') : ''
    return (pm.multiple ? colors.yellow('[multiple]') : '—') + tag
  }
  const vpTag = pm.vp ? colors.magenta(' [vp]') : ''
  const multiTag = pm.multiple ? colors.yellow(' [multiple]') : ''
  return pm.family + vpTag + multiTag
}

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

/** Width of the v1.1 Share bar, in cells — proportion of the largest entry. */
const BAR_CELLS = 12

function renderBar(size: number, max: number): string {
  if (max <= 0 || size <= 0) return colors.dim('·')
  const cells = Math.max(1, Math.round((size / max) * BAR_CELLS))
  return colors.cyan('█'.repeat(Math.min(cells, BAR_CELLS)))
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

function totalsJson(totals: ScanTotals) {
  return {
    folders: totals.folders,
    packages: totals.packages,
    size: totals.size,
    sizeFormatted: formatBytes(totals.size),
  }
}

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

export interface RenderSearchOptions {
  cwd: string
  expand?: boolean
}

export function renderSearchResults(outcome: SearchOutcome, options: RenderSearchOptions): string {
  const totalMatches = outcome.results.reduce((sum, result) => sum + result.matches.length, 0)
  const lines = [
    colors.cyan(
      t('render.search.header', { pattern: outcome.pattern, count: totalMatches, dirs: outcome.results.length }),
    ),
  ]

  for (const result of outcome.results) {
    const display = options.expand === true ? result.entry.path : result.entry.displayPath
    const badge = result.entry.nested ? colors.dim(' [nested]') : ''
    lines.push('')
    lines.push(
      `${colors.bold(display)}${badge} ${colors.dim(`· ${pmLabel(result.entry.pm)} · ${formatBytes(result.entry.size)}`)}`,
    )
    if (result.matches.length === 0) {
      lines.push(t('render.search.pathMatch'))
      continue
    }
    for (const pkg of result.matches) {
      const version = pkg.version ? colors.dim(`@${pkg.version}`) : ''
      const link = pkg.symlinked ? colors.dim(' (link)') : ''
      lines.push(`   ${colors.cyan('•')} ${pkg.name}${version}${link} ${colors.dim(formatBytes(pkg.size))}`)
    }
  }

  if (outcome.permissionIssues.length > 0) {
    lines.push(
      colors.yellow(
        `⚠ ${outcome.permissionIssues.length} directory(ies) unreadable (permission denied) — exit code 4`,
      ),
    )
  }
  return lines.join('\n')
}

export function renderSearchJson(outcome: SearchOutcome, options: RenderSearchOptions): string {
  const payload = {
    nmh: toolVersion(),
    command: 'search',
    pattern: outcome.pattern,
    totals: {
      matchedEntries: outcome.results.length,
      matches: outcome.results.reduce((sum, result) => sum + result.matches.length, 0),
      matchedSize: outcome.results.reduce(
        (sum, result) => sum + result.matches.reduce((inner, pkg) => inner + pkg.size, 0),
        0,
      ),
    },
    permissionIssues: outcome.permissionIssues,
    results: outcome.results.map((result) => ({
      path: result.entry.path,
      displayPath: options.expand === true ? result.entry.path : result.entry.displayPath,
      pm: result.entry.pm.family,
      pmVp: result.entry.pm.vp,
      nested: result.entry.nested === true,
      ownerPath: result.entry.ownerPath ?? result.entry.path,
      entrySize: result.entry.size,
      pathMatch: result.pathMatch,
      matches: result.matches.map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        size: pkg.size,
        sizeFormatted: formatBytes(pkg.size),
        path: pkg.path,
        symlinked: pkg.symlinked,
      })),
    })),
  }
  return JSON.stringify(payload, null, 2)
}

export interface RenderMapOptions {
  cwd: string
  expand?: boolean
}

function mapEntryDisplay(entry: MapProjectInfo['entry'], options: RenderMapOptions): string {
  return options.expand === true ? entry.path : entry.displayPath
}

function projectNameOrPath(project: MapProjectInfo, options: RenderMapOptions): string {
  const badge = project.entry.nested ? colors.dim(' [nested]') : ''
  if (project.project !== null) return colors.bold(project.project) + badge
  return colors.bold(mapEntryDisplay(project.entry, options)) + badge
}

function mapPmSuffix(project: MapProjectInfo): string {
  return `${pmLabel(project.entry.pm)} · ${formatBytes(project.entry.size)}`
}

export function renderMapTable(projects: MapProjectInfo[], options: RenderMapOptions): string {
  const table = new Table({
    head: [
      colors.dim(t('render.map.head.project')),
      colors.dim(t('common.pm')),
      colors.dim(t('common.size')),
      colors.dim(t('render.map.head.topPkgs')),
      colors.dim(t('render.map.head.declared')),
    ],
    style: { head: [], border: colorEnabled() ? ['gray'] : [] },
  })

  for (const project of projects) {
    table.push([
      options.expand === true ? mapEntryDisplay(project.entry, options) : projectNameOrPath(project, options),
      pmLabel(project.entry.pm),
      formatBytes(project.entry.size),
      String(project.topPackages.length),
      project.declared === null
        ? colors.dim('—')
        : String(project.declared.dependencies.length + project.declared.devDependencies.length),
    ])
  }

  return table.toString()
}

export function renderMapTree(projects: MapProjectInfo[], options: RenderMapOptions): string {
  const lines: string[] = []
  for (const project of projects) {
    lines.push(
      `${projectNameOrPath(project, options)} ${colors.dim(`· ${mapEntryDisplay(project.entry, options)} · ${mapPmSuffix(project)}`)}`,
    )
    const packages = project.topPackages
    if (packages.length === 0) {
      lines.push(colors.dim(t('render.map.noPkgs')))
      continue
    }
    packages.forEach((pkg, index) => {
      const branch = index === packages.length - 1 ? '└─' : '├─'
      const version = pkg.version ? colors.dim(`@${pkg.version}`) : ''
      const link = pkg.symlinked ? colors.dim(' (link)') : ''
      const size = pkg.size != null && !pkg.symlinked ? colors.dim(` (${formatBytes(pkg.size)})`) : ''
      lines.push(`  ${branch} ${pkg.name}${version}${size}${link}`)
    })
  }
  return lines.join('\n')
}

export function renderMapDepend(projects: MapProjectInfo[], options: RenderMapOptions): string {
  const lines: string[] = []
  for (const project of projects) {
    lines.push(
      `${projectNameOrPath(project, options)} ${colors.dim(`· ${mapEntryDisplay(project.entry, options)} · ${pmLabel(project.entry.pm)}`)}`,
    )
    if (project.declared === null) {
      lines.push(colors.dim(t('render.map.noManifest')))
      continue
    }
    if (project.declared.dependencies.length > 0) {
      lines.push(`   dependencies: ${project.declared.dependencies.join(', ')}`)
    }
    if (project.declared.devDependencies.length > 0) {
      lines.push(`   devDependencies: ${project.declared.devDependencies.join(', ')}`)
    }
    if (project.declared.dependencies.length + project.declared.devDependencies.length === 0) {
      lines.push(colors.dim(t('render.map.noDeclared')))
    }
  }
  return lines.join('\n')
}

export function renderMapDependReverse(
  projects: MapProjectInfo[],
  dependPkg: string,
  options: RenderMapOptions,
): string {
  const lines = [colors.cyan(t('render.map.declaredBy', { pkg: dependPkg, count: projects.length }))]
  for (const project of projects) {
    const where =
      project.declared?.dependencies.includes(dependPkg) === true
        ? 'dependencies'
        : 'devDependencies'
    lines.push(
      `   • ${projectNameOrPath(project, options)} ${colors.dim(`[${where}] · ${mapEntryDisplay(project.entry, options)}`)}`,
    )
  }
  return lines.join('\n')
}

export function renderMapJson(outcome: MapOutcome, request: { dependPkg?: string | null; tree?: boolean; depend?: boolean }): string {
  const payload = {
    nmh: toolVersion(),
    command: 'map',    mode:
      (request.depend === true && request.dependPkg) ? 'depend-reverse'
      : request.depend === true ? 'depend-list'
      : request.tree === true ? 'tree'
      : 'table',
    dependPkg: request.dependPkg ?? null,
    permissionIssues: outcome.permissionIssues,
    totals: {
      projects: outcome.projects.length,
      topPackages: outcome.projects.reduce((sum, project) => sum + project.topPackages.length, 0),
    },
    projects: outcome.projects.map((project) => ({
      project: project.project,
      path: project.entry.path,
      displayPath: project.entry.displayPath,
      pm: project.entry.pm.family,
      pmVp: project.entry.pm.vp,
      multiple: project.entry.pm.multiple,
      nested: project.entry.nested === true,
      ownerPath: project.entry.ownerPath ?? project.entry.path,
      size: project.entry.size,
      sizeFormatted: formatBytes(project.entry.size),
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

/** Optional telemetry stamped into stats JSON when baseline flags are involved. */
export interface BaselineJsonExtra {
  saved?: { name: string; createdAt?: string; file?: string }
  compare?: BaselineComparison | null
}

const signedBytes = (n: number): string => (n > 0 ? '+' : n < 0 ? '−' : '±') + formatBytes(Math.abs(n))

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

export function renderWhyReport(outcome: WhyOutcome, options: { cwd: string; expand?: boolean }): string {
  const lines: string[] = []
  lines.push(colors.cyan(t('render.why.title', { pkg: outcome.pkg, count: outcome.instances.length })))
  for (const instance of outcome.instances) {
    lines.push('')
    const version = instance.version !== null ? `@${instance.version}` : ''
    const linked = instance.symlinked
    const size = linked ? colors.dim(t('render.why.linked')) : formatBytes(instance.size ?? 0)
    lines.push(`${colors.bold(instance.displayPath)} · ${colors.bold(outcome.pkg + version)} · ${size}${instance.pm !== 'unknown' ? colors.dim(` · ${instance.pm}`) : ''}`)
    if (instance.declaredBy !== null) {
      lines.push(t('render.why.declares', { project: instance.declaredBy.projectName ?? t('render.why.noName'), range: colors.yellow(instance.declaredBy.range), field: instance.declaredBy.field }))
    } else {
      lines.push(colors.dim(t('render.why.transitive')))
    }
    if (instance.requiredBy.length > 0) {
      const gradeTag = instance.requiredByGrade === 'lockfile' ? colors.dim(` ${t('render.stats.lockfileGrade')}`) : ''
      lines.push(t('render.why.requiredBy', { count: instance.requiredBy.length }) + gradeTag)
      for (const req of instance.requiredBy.slice(0, 10)) {
        const reqVersion = req.version !== null ? `@${req.version}` : ''
        lines.push(`    · ${req.name}${reqVersion} → ${req.range} (${req.field})`)
      }
      if (instance.requiredBy.length > 10) {
        lines.push(colors.dim(t('render.why.moreRequirers', { n: instance.requiredBy.length - 10 })))
      }
    } else if (instance.requiredByGrade === 'lockfile') {
      lines.push(colors.dim(t('render.why.rootOnly')))
    } else {
      lines.push(colors.dim(t('render.why.orphan')))
    }
  }
  if (outcome.permissionIssues.length > 0) {
    lines.push(colors.yellow(t('render.warn.permission', { n: outcome.permissionIssues.length })))
  }
  return lines.join('\n')
}

export function renderWhyJson(outcome: WhyOutcome, _request: { cwd: string }): string {
  return JSON.stringify(
    {
      nmh: toolVersion(),
      command: 'why',
      pkg: outcome.pkg,
      found: outcome.instances.length,
      instances: outcome.instances,
      permissionIssues: outcome.permissionIssues,
    },
    null,
    2,
  )
}

export function renderDepsAudit(audit: DepsAudit, focus: 'phantom' | 'dead' | 'both'): string {
  const lines: string[] = []
  lines.push(`━━━ ${colors.bold(t('render.section.audit'))} ━━━`)
  lines.push(colors.dim(t('render.audit.disclaimer', { count: audit.scannedFiles })))
  const showPhantom = focus === 'phantom' || focus === 'both'
  const showDead = focus === 'dead' || focus === 'both'
  if (showPhantom && audit.phantom.length === 0 && showDead && audit.dead.length === 0) {
    lines.push(colors.green(t('render.audit.clean')))
  }
  if (showPhantom && audit.phantom.length > 0) {
    lines.push(t('render.audit.phantom', { count: audit.phantom.length }))
    for (const hit of audit.phantom) {
      const sites = hit.sites.length > 0 ? colors.dim(` — ${hit.sites.join(', ')}`) : ''
      lines.push(`  · ${colors.bold(hit.name)}${sites}`)
    }
  }
  if (showDead && audit.dead.length > 0) {
    lines.push(t('render.audit.dead', { count: audit.dead.length }))
    for (const hit of audit.dead) {
      lines.push(`  · ${colors.bold(hit.name)} — ${hit.declaringProjects.join(', ')}`)
    }
  }
  return lines.join('\n')
}
