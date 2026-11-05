import Table from 'cli-table3'
import { colors, colorEnabled } from '../../utils/logger.ts'
import { t } from '../../i18n/index.ts'
import { formatBytes } from '../../utils/format.ts'
import { pmLabel, shortenPath } from './shared.ts'
import { toolVersion } from '../../utils/version.ts'
import type { MapOutcome, MapProjectInfo, PMInfo } from '../result.ts'

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
