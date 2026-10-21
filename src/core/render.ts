import Table from 'cli-table3'
import path from 'node:path'
import { homedir } from 'node:os'
import { colors, isSilent } from '../utils/logger.ts'
import { formatBytes, formatAge } from '../utils/format.ts'
import { toolVersion } from '../utils/version.ts'
import type {
  DeleteMode,
  DeleteOutcome,
  MapOutcome,
  MapProjectInfo,
  PMInfo,
  ScanCommandResult,
  ScanEntry,
  SearchOutcome,
  ScanTotals,
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
    style: { head: [], border: ['gray'] },
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
    style: { head: [], border: ['gray'] },
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
      lines.push(`  ${branch} ${pkg.name}${version}${link}`)
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
    command: 'map',
    mode:
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
