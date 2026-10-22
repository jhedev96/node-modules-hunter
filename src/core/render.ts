import Table from 'cli-table3'
import path from 'node:path'
import { homedir } from 'node:os'
import { colors, isSilent, colorEnabled } from '../utils/logger.ts'
import { formatBytes, formatAge } from '../utils/format.ts'
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

function renderScanTable(result: ScanCommandResult, options: RenderScanOptions): string {
  const table = new Table({
    head: [
      colors.dim('Path'),
      colors.dim('Size'),
      colors.dim('Pkgs'),
      colors.dim('PM'),
      colors.dim('Modified'),
    ],
    style: { head: [], border: colorEnabled() ? ['gray'] : [] },
  })

  const pushRow = (entry: ScanEntry, nested: boolean): void => {
    const display = options.expand === true ? entry.path : entry.displayPath
    const label = nested
      ? `${colors.dim('└─')}${colors.dim(' nested ')}${display}`
      : colors.bold(display)
    table.push([
      label,
      formatBytes(entry.size),
      entry.packageCount > 0 ? String(entry.packageCount) : '0',
      pmLabel(entry.pm),
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
      colors.yellow(`⚠ ${result.permissionIssues.length} directory(ies) unreadable (permission denied) — exit code 4`),
    )
  }
  return lines.join('\n')
}

export function renderScanTotals(result: ScanCommandResult): string {
  const { totals } = result
  const nestedCount = result.entries.filter((entry) => entry.nested).length
  const nestedNote = nestedCount > 0 ? colors.dim(` (+${nestedCount} nested, not counted)`) : ''
  return `💾 Total: ${formatBytes(totals.size)} across ${totals.folders} folder(s), ${totals.packages} packages${nestedNote}`
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
  options: { maxShown?: number } = {},
): string {
  const shown = options.maxShown ?? 20
  const modeLabel = mode === 'hard' ? 'DELETE (permanent)' : 'TRASH (restorable)'
  const total = entries.reduce((sum, entry) => sum + entry.size, 0)

  const lines = [`[DRY RUN] Would ${modeLabel} ${entries.length} folder(s) (${formatBytes(total)}):`]
  for (const entry of entries.slice(0, shown)) {
    lines.push(
      `  ${colors.red('✗')} ${entry.displayPath} ${colors.dim(`(${formatBytes(entry.size)}${entry.pm.family === 'unknown' ? '' : `, ${entry.pm.family}`})`)}`,
    )
  }
  if (entries.length > shown) lines.push(colors.dim(`  … plus ${entries.length - shown} more`))
  lines.push('Run again without --dry-run to execute.')
  return lines.join('\n')
}

export function renderDeleteSummary(outcome: DeleteOutcome, mode: DeleteMode): string {
  const verb = mode === 'hard' ? 'Deleted' : 'Trashed'
  const lines: string[] = []
  if (outcome.deleted > 0) {
    lines.push(`✅ ${verb}: ${formatBytes(outcome.freed)} from ${outcome.deleted} folder(s)`)
  }
  if (outcome.failed > 0) {
    lines.push(colors.yellow(`⚠ ${outcome.failed} folder(s) failed — rerun with --verbose for details`))
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
    })),
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
      `🔍 '${outcome.pattern}' → ${totalMatches} package(s) in ${outcome.results.length} node_modules`,
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
      lines.push(`   ${colors.dim('(path match)')}`)
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
      colors.dim('Project'),
      colors.dim('PM'),
      colors.dim('Size'),
      colors.dim('TopPkgs'),
      colors.dim('Declared'),
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
      lines.push(colors.dim('   (no top-level packages)'))
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
      lines.push(colors.dim('   (no manifest with declared dependencies)'))
      continue
    }
    if (project.declared.dependencies.length > 0) {
      lines.push(`   dependencies: ${project.declared.dependencies.join(', ')}`)
    }
    if (project.declared.devDependencies.length > 0) {
      lines.push(`   devDependencies: ${project.declared.devDependencies.join(', ')}`)
    }
    if (project.declared.dependencies.length + project.declared.devDependencies.length === 0) {
      lines.push(colors.dim('   (no declared dependencies)'))
    }
  }
  return lines.join('\n')
}

export function renderMapDependReverse(
  projects: MapProjectInfo[],
  dependPkg: string,
  options: RenderMapOptions,
): string {
  const lines = [colors.cyan(`🔗 '${dependPkg}' is declared by ${projects.length} project(s):`)]
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

  lines.push(colors.cyan(`📊 nmh stats — ${projectBadges(outcome.projects)}${overview.waste > 0 ? dim(' · dedup potential detected') : ''}`))
  lines.push('')
  lines.push(`━━━ ${colors.bold('OVERVIEW')} ━━━`)
  lines.push(`Total size        : ${formatBytes(overview.totalSize)} across ${overview.entryCount} node_modules`)
  lines.push(
    `Packages          : ${overview.instances} instances / ${overview.unique} unique (dup ${overview.dupFactor}×)`,
  )
  if (overview.declared !== null) {
    lines.push(`Direct deps       : ${overview.declared} declared across the scanned projects`)
  }
  lines.push(`Waste (dedupable) : ${formatBytes(overview.waste)} (${overview.wastePercent}% of package sizes)`)

  if (options.by === 'type') {
    // focused view (§8.1): overview + BY TYPE only — TOP/dedup sections stay hidden
    lines.push('')
    lines.push(`━━━ ${colors.bold('BY TYPE')} ━━━`)
    for (const row of outcome.typeBreakdown) {
      if (row.packages === 0) continue
      lines.push(`${row.field.padEnd(22)}: ${formatBytes(row.size)} · ${row.packages} pkg`)
    }
  }

  if (options.by === 'licenses' || options.licenses === true) {
    // focused view (§8.1/§8.2): overview + LICENSES only
    lines.push('')
    lines.push(`━━━ ${colors.bold('LICENSES')} ━━━`)
    if (outcome.licenseBreakdown.length === 0) {
      lines.push(colors.dim('no package manifests found — nothing to license'))
    }
    for (const row of outcome.licenseBreakdown) {
      const marker =
        row.production && row.copyleft
          ? colors.yellow('  ⚠ copyleft di production dependencies')
          : row.copyleft
            ? colors.dim('  (copyleft, bukan prod-dep)')
            : ''
      lines.push(`${row.type.padEnd(24)}: ${formatBytes(row.size)} · ${row.packages} pkg${marker}`)
    }
  }

  const focused = options.by === 'type' || options.by === 'licenses' || options.licenses === true || (options.audit ?? null) !== null

  if (outcome.depsAudit !== null && (options.audit ?? null) !== null) {
    lines.push('')
    lines.push(renderDepsAudit(outcome.depsAudit, options.audit ?? 'both'))
  }

  const top = options.by === 'type' || focused ? [] : outcome.sizeGroups.slice(0, options.topN)
  if (top.length > 0) {
    lines.push('')
    lines.push(`━━━ ${colors.bold(`TOP ${options.topN} SIZE`)} ━━━`)
    top.forEach((group, index) => {
      const rank = String(index + 1).padStart(2)
      const copies = group.copies > 1 ? colors.yellow(`×${group.copies} copies`) : dim('×1 copy')
      const saving =
        group.dedupableSize !== undefined
          ? dim(`   ← dedup bisa hemat ${formatBytes(group.dedupableSize)}`)
          : ''
      lines.push(`${rank}. ${group.name}  ${copies}  ${formatBytes(group.totalSize)}${saving}`)
    })
    if (options.by === 'package' && outcome.sizeGroups.length > top.length) {
      const rest = outcome.sizeGroups.slice(options.topN)
      const restCount = rest.reduce((sum, group) => sum + group.copies, 0)
      const restSize = rest.reduce((sum, group) => sum + group.totalSize, 0)
      lines.push('')
      lines.push(`━━━ ${colors.bold('LONG TAIL')} ━━━`)
      lines.push(dim(`… plus ${rest.length} more package name(s) · ${restCount} instances · ${formatBytes(restSize)}`))
    }
  }

  if (!focused && outcome.dedupSuggestions.length > 0) {
    lines.push('')
    lines.push(`━━━ ${colors.bold('DEDUP SUGGESTION')} ━━━`)
    outcome.dedupSuggestions.forEach((suggestion, index) => {
      const rank = String(index + 1).padStart(2)
      const version = suggestion.version !== null ? `@${suggestion.version}` : ''
      lines.push(`${rank}. ${colors.bold(suggestion.name + version)}  ${dim(`×${suggestion.instances.length} copies`)}  ${colors.yellow(signedBytes(suggestion.save))}${dim(' bisa hemat')}`)
      for (const inst of suggestion.instances) {
        const declared =
          inst.projectName !== null && inst.declaredRange !== null
            ? `${inst.projectName} declared ${inst.declaredRange} (${inst.declaredField})`
            : 'transitive (tidak dideklarasi di manifest)'
        lines.push(`    · ${inst.displayPath} (${inst.pm}) · ${formatBytes(inst.size ?? 0)} · ${declared}`)
      }
      lines.push(`    ${dim(`↳ ${suggestion.hint}`)}`)
    })
  }

  if (outcome.permissionIssues.length > 0) {
    lines.push(colors.yellow(`⚠ ${outcome.permissionIssues.length} directory(ies) unreadable (permission denied) — exit code 4`))
  }
  return lines.join('\n')
}

export function renderStatsJson(
  outcome: StatsOutcome,
  request: { tree?: boolean; topN?: number; by?: 'package' | 'type' | 'size' | 'licenses'; licenses?: boolean },
  extra?: { baseline?: BaselineJsonExtra },
): string {
  const payload = {
    nmh: toolVersion(),
    command: 'stats',
    mode: request.tree === true ? 'tree' : request.by ?? (request.licenses === true ? 'licenses' : 'report'),
    baseline: extra?.baseline ?? null,
    overview: outcome.overview,
    permissionIssues: outcome.permissionIssues,
    sizeGroups: outcome.sizeGroups,
    dedupSuggestions: outcome.dedupSuggestions,
    typeBreakdown: outcome.typeBreakdown,
    licenseBreakdown: outcome.licenseBreakdown,
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
  lines.push(colors.cyan('🌐 nmh stats — global installation analysis'))
  lines.push(colors.dim('(⚠️ global mode — read-only; needs access to the PM prefixes — sudo is never auto-applied)'))
  lines.push('')
  const attempted = ['npm', 'pnpm', 'yarn', 'bun']
  lines.push(`PM detected      : ${outcome.reports.map((report) => report.pm).join(', ') || '—'}${skippedSuffix(outcome, attempted)}`)
  lines.push(`Total global     : ${outcome.totals.packages} packages — ${formatBytes(outcome.totals.size)}`)
  lines.push('')

  for (const report of outcome.reports) {
    lines.push(colors.bold(`${report.pm} · ${shortenPath(report.root, request.cwd)}`))
    lines.push(globalPackageTable(report, outcome.duplicates))
    if (report.dead.length > 0) {
      lines.push(colors.yellow(`⚠ dead globals in ${report.pm}: ${report.dead.length} (broken/missing bin symlink)`))
      for (const dead of report.dead.slice(0, 5)) {
        lines.push(colors.yellow(`  - ${dead.name} → ${dead.detail} (${dead.kind})`))
      }
      if (report.dead.length > 5) lines.push(colors.yellow(`  … plus ${report.dead.length - 5} more`))
    }
    lines.push('')
  }

  if (outcome.duplicates.length > 0) {
    const savings = outcome.duplicates.reduce((sum, dup) => sum + dup.savings, 0)
    lines.push(colors.yellow(`⚠ Cross-PM duplicates : ${outcome.duplicates.length} package(s) (~${formatBytes(savings)} could be saved — uninstall one of them)`))
    for (const dup of outcome.duplicates.slice(0, 8)) {
      lines.push(`  - ${dup.name}: ${dup.pms.join(' + ')}`)
    }
    if (outcome.duplicates.length > 8) lines.push(`  … plus ${outcome.duplicates.length - 8} more`)
    lines.push('')
  }
  if (outcome.permissionIssues.length > 0) {
    lines.push(colors.yellow(`⚠ ${outcome.permissionIssues.length} unreadable location(s) — exit code 4`))
  }
  return lines.join('\n')
}

function skippedSuffix(outcome: GlobalOutcome, attempted: string[]): string {
  const skipped = attempted.filter((pm) => !outcome.reports.some((report) => report.pm === pm))
  return skipped.length > 0 ? colors.dim(`  (not found: ${skipped.join(', ')})`) : ''
}

function globalPackageTable(report: GlobalPmReport, duplicates: GlobalDuplicate[]): string {
  const table = new Table({
    head: [colors.dim('Package'), colors.dim('Version'), colors.dim('Size'), colors.dim('PM')],
    style: { head: [], border: colorEnabled() ? ['gray'] : [] },
  })
  const dupNames = new Set(duplicates.map((dup) => dup.name))
  for (const pkg of report.packages) {
    table.push([
      colors.bold(pkg.name) + (dupNames.has(pkg.name) ? colors.dim(' ← in more than one PM') : ''),
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
  lines.push(`━━━ ${colors.bold('BASELINE COMPARE')} ━━━`)
  lines.push(`Baseline         : '${comp.baselineName}' saved ${comp.baselineCreatedAt}`)
  const pct =
    comp.totalDeltaPercent === null ? '' : ` (${comp.totalDeltaPercent > 0 ? '+' : comp.totalDeltaPercent < 0 ? '−' : '±'}${Math.abs(comp.totalDeltaPercent)}%)`
  lines.push(`Total size       : ${signedBytes(comp.totalDelta)}${pct} — was ${formatBytes(comp.totalBefore)}, now ${formatBytes(comp.totalAfter)}`)
  lines.push(`Packages         : ${signedBytes(comp.packagesDelta)}`)

  const changed = comp.deltas.filter((delta) => delta.kind !== 'same')
  if (changed.length > 0) {
    lines.push('')
    const table = new Table({
      head: [colors.dim('Path'), colors.dim('Before'), colors.dim('Now'), colors.dim('Δ')],
      style: { head: [], border: colorEnabled() ? ['gray'] : [] },
    })
    for (const delta of changed.slice(0, 15)) {
      const marker =
        delta.kind === 'new'
          ? colors.yellow('new')
          : delta.kind === 'gone'
            ? colors.dim('gone')
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
      lines.push(colors.dim(`… plus ${changed.length - 15} more changed path(s)`))
    }
  }

  if (comp.packageMovers.length > 0) {
    lines.push('')
    lines.push(`Package movers   :`)
    comp.packageMovers.slice(0, 5).forEach((mover, index) => {
      const rank = String(index + 1).padStart(2)
      const delta = mover.delta >= 0 ? colors.yellow(signedBytes(mover.delta)) : signedBytes(mover.delta)
      lines.push(`${rank}. ${mover.name}  ${delta}`)
    })
  }

  if (Math.abs(comp.totalDelta) > 0 && comp.totalBefore > 0 && comp.totalDeltaPercent !== null && comp.totalDeltaPercent > 30) {
    lines.push(colors.yellow('🚨 bloat growth detected — node_modules grew by more than 30% since the baseline'))
  }
  return lines.join('\n')
}

export function renderBaselineHistory(items: BaselineListItem[], cwd: string): string {
  const lines: string[] = []
  lines.push(colors.cyan(`⚖ nmh baselines — ${items.length} saved`))
  if (items.length === 0) {
    lines.push(colors.dim('save one with: nmh stats --save-baseline <name>'))
    return lines.join('\n')
  }
  const table = new Table({
    head: [colors.dim('Name'), colors.dim('Saved'), colors.dim('Size'), colors.dim('Node_modules'), colors.dim('Where')],
    style: { head: [], border: colorEnabled() ? ['gray'] : [] },
  })
  for (const item of items) {
    table.push([
      item.name + (item.cwd === cwd ? colors.yellow(' · this dir') : ''),
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
  lines.push(colors.cyan(`🔍 why '${outcome.pkg}' — ${outcome.instances.length} instance(s)`))
  for (const instance of outcome.instances) {
    lines.push('')
    const version = instance.version !== null ? `@${instance.version}` : ''
    const linked = instance.symlinked
    const size = linked ? colors.dim('linked') : formatBytes(instance.size ?? 0)
    lines.push(`${colors.bold(instance.displayPath)} · ${colors.bold(outcome.pkg + version)} · ${size}${instance.pm !== 'unknown' ? colors.dim(` · ${instance.pm}`) : ''}`)
    if (instance.declaredBy !== null) {
      lines.push(`  project              : ${instance.declaredBy.projectName ?? '(manifest tanpa nama)'} declares ${colors.yellow(instance.declaredBy.range)} (${instance.declaredBy.field})`)
    } else {
      lines.push(colors.dim('  project              : transitive — tidak dideklarasi di manifest manapun'))
    }
    if (instance.requiredBy.length > 0) {
      lines.push(`  required by          : ${instance.requiredBy.length} package(s)`)
      for (const req of instance.requiredBy.slice(0, 10)) {
        const reqVersion = req.version !== null ? `@${req.version}` : ''
        lines.push(`    · ${req.name}${reqVersion} → ${req.range} (${req.field})`)
      }
      if (instance.requiredBy.length > 10) {
        lines.push(colors.dim(`    … plus ${instance.requiredBy.length - 10} more requirer(s)`))
      }
    } else {
      lines.push(colors.dim('  required by          : no package manifest names it — orphan copy'))
    }
  }
  if (outcome.permissionIssues.length > 0) {
    lines.push(colors.yellow(`⚠ ${outcome.permissionIssues.length} directory(ies) unreadable (permission denied) — exit code 4`))
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
  lines.push(`━━━ ${colors.bold('DEPS AUDIT')} ━━━`)
  lines.push(colors.dim(`· best-effort regex scan — ${audit.scannedFiles} source file(s) (lockfile graph lands later)`))
  const showPhantom = focus === 'phantom' || focus === 'both'
  const showDead = focus === 'dead' || focus === 'both'
  if (showPhantom && audit.phantom.length === 0 && showDead && audit.dead.length === 0) {
    lines.push(colors.green('✓ no phantom imports and no dead declarations detected'))
  }
  if (showPhantom && audit.phantom.length > 0) {
    lines.push(`🧟 phantom imports — imported in code, declared nowhere (${audit.phantom.length})`)
    for (const hit of audit.phantom) {
      const sites = hit.sites.length > 0 ? colors.dim(` — ${hit.sites.join(', ')}`) : ''
      lines.push(`  · ${colors.bold(hit.name)}${sites}`)
    }
  }
  if (showDead && audit.dead.length > 0) {
    lines.push(`🪦 dead declarations — installed + declared, never imported (${audit.dead.length})`)
    for (const hit of audit.dead) {
      lines.push(`  · ${colors.bold(hit.name)} — ${hit.declaringProjects.join(', ')}`)
    }
  }
  return lines.join('\n')
}
