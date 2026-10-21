import { createLimiter } from '../utils/limit.ts'
import { log, progressLine, clearProgress, warn, verboseLog } from '../utils/logger.ts'
import { collectScan } from './scan.ts'
import { listTopLevelPackages, packageVersion, projectDepsFor, projectNameFor } from '../core/packages.ts'
import { measureEntry } from '../core/sizer.ts'
import { renderMapTree, renderStatsJson, renderStatsReport } from '../core/render.ts'
import type { MapProjectInfo, StatsOutcome, StatsPackageGroup } from '../core/result.ts'

export interface StatsRequest {
  targets: string[]
  cwd: string
  json?: boolean
  /** --tree: per-project package trees WITH sizes (reuses the map tree view). */
  tree?: boolean
  /** --top <n>: rows shown in the focused size list. Default 10. */
  topN?: number
  /** --by package|type|size — `type` warns (v0.4+) and falls back to package view. */
  by?: 'package' | 'type' | 'size'
  maxDepth?: number
  recursive?: boolean
  excludes?: string[]
  keep?: string[]
  pmFilter?: string[]
  expand?: boolean
}

const round1 = (n: number): number => Math.round(n * 10) / 10

/**
 * Stats (PRD §8, v0.3 slice): scan → per-package sizes across every entry →
 * overview (instances vs unique, dup factor, declared), dedup waste, size groups.
 * Focused view, full report — scores/licenses/phantom/co2 land later (v0.4+/v0.5).
 */
export async function collectStats(request: StatsRequest): Promise<StatsOutcome> {
  const scan = await collectScan({
    targets: request.targets,
    cwd: request.cwd,
    maxDepth: request.maxDepth,
    recursive: request.recursive,
    excludes: request.excludes,
    keep: request.keep,
    pmFilter: request.pmFilter,
  })

  const entryLimiter = createLimiter(4)
  const entryCount = scan.result.entries.length
  let measuredEntries = 0

  const projectsResults = await Promise.all(
    scan.result.entries.map((entry) =>
      entryLimiter(async () => {
        const [project, declared, refs] = await Promise.all([
          projectNameFor(entry.path),
          projectDepsFor(entry.path),
          listTopLevelPackages(entry.path),
        ])
        const pkgLimiter = createLimiter(8)
        const topPackages = await Promise.all(
          refs.map((ref) =>
            pkgLimiter(async () => {
              const [version, measure] = await Promise.all([
                packageVersion(ref.path),
                ref.symlinked ? Promise.resolve(null) : measureEntry(ref.path),
              ])
              return {
                name: ref.name,
                version,
                symlinked: ref.symlinked,
                size: measure === null ? null : measure.size,
              }
            }),
          ),
        )
        measuredEntries += 1
        progressLine(`⠋ analyzing ${measuredEntries}/${entryCount} node_modules…`)
        return { entry, project, topPackages, declared }
      }),
    ),
  )
  clearProgress()

  // Group by NAME across all scanned entries for the size ranking, then split
  // each name group by exact version to estimate dedup-able waste.
  const byName = new Map<string, StatsPackageGroup>()
  const versionsByName = new Map<string, Map<string, number[]>>()
  let pkgSizeTotal = 0
  let declaredSum = 0
  let projectsWithManifest = 0

  for (const project of projectsResults) {
    if (project.declared !== null) {
      projectsWithManifest += 1
      declaredSum += project.declared.dependencies.length + project.declared.devDependencies.length
    }
    for (const pkg of project.topPackages) {
      const group = byName.get(pkg.name) ?? { name: pkg.name, copies: 0, totalSize: 0 }
      group.copies += 1
      if (pkg.size != null) {
        group.totalSize += pkg.size
        pkgSizeTotal += pkg.size
        const versions = versionsByName.get(pkg.name) ?? new Map<string, number[]>()
        const sizes = versions.get(pkg.version ?? '(no version)') ?? []
        sizes.push(pkg.size)
        versions.set(pkg.version ?? '(no version)', sizes)
        versionsByName.set(pkg.name, versions)
      }
      byName.set(pkg.name, group)
    }
  }

  for (const [name, versions] of versionsByName) {
    let dedupable = 0
    for (const sizes of versions.values()) {
      if (sizes.length < 2) continue
      const sorted = [...sizes].sort((a, b) => a - b)
      const median = sorted[Math.floor((sorted.length - 1) / 2)]
      dedupable += (sizes.length - 1) * median
    }
    if (dedupable > 0) {
      const group = byName.get(name)
      if (group) group.dedupableSize = dedupable
    }
  }

  const sizeGroups = [...byName.values()].sort((a, b) => b.totalSize - a.totalSize || a.name.localeCompare(b.name))

  const instances = sizeGroups.reduce((sum, group) => sum + group.copies, 0)
  let unique = 0
  for (const versions of versionsByName.values()) unique += versions.size
  const waste = sizeGroups.reduce((sum, group) => sum + (group.dedupableSize ?? 0), 0)

  const overview = {
    totalSize: scan.result.totals.size,
    entryCount: scan.result.totals.folders,
    instances,
    unique,
    dupFactor: unique > 0 ? round1(instances / unique) : 0,
    waste,
    wastePercent: pkgSizeTotal > 0 ? round1((waste / pkgSizeTotal) * 100) : 0,
    declared: projectsWithManifest > 0 ? declaredSum : null,
  }

  let code = 0
  if (projectsResults.length === 0) code = 2
  else if (scan.result.permissionIssues.length > 0) code = 4
  verboseLog(`stats: ${projectsResults.length} entries, ${instances} instances, ${unique} unique`)
  return { code, projects: projectsResults, overview, sizeGroups, permissionIssues: scan.result.permissionIssues }
}

/** Stats + print (report / tree / JSON). */
export async function runStats(request: StatsRequest): Promise<number> {
  const outcome = await collectStats(request)

  if (outcome.projects.length === 0) {
    if (request.json) {
      log(renderStatsJson(outcome, request))
      return 2
    }
    warn('no node_modules found — nothing to analyze here 🙃')
    return 2
  }

  if (request.by === 'type') {
    warn("--by=type (breakdown by dependency group) lands with lockfile parsing (v0.4) — showing the size breakdown for now")
  }

  if (request.json) {
    log(renderStatsJson(outcome, request))
    return outcome.code
  }

  if (request.tree === true) {
    log(renderMapTree(outcome.projects, { cwd: request.cwd, expand: request.expand === true }))
    return outcome.code
  }

  log(renderStatsReport(outcome, {
    cwd: request.cwd,
    expand: request.expand === true,
    topN: request.topN ?? 10,
    by: request.by === 'type' ? 'package' : request.by ?? null,
  }))
  return outcome.code
}
