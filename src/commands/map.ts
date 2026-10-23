import { createLimiter } from '../utils/limit.ts'
import { log, progressLine, clearProgress, warn, verboseLog, note } from '../utils/logger.ts'
import { collectScan } from './scan.ts'
import { listTopLevelPackages, packageVersion, projectDepsFor, projectNameFor } from '../core/packages.ts'
import { measureEntry } from '../core/sizer.ts'
import { writeReportSnapshot } from '../utils/report.ts'
import { stripAnsi } from '../utils/format.ts'
import {
  renderMapDepend,
  renderMapDependReverse,
  renderMapJson,
  renderMapTable,
  renderMapTree,
} from '../core/render.ts'
import type { MapOutcome } from '../core/result.ts'

export interface MapRequest {
  targets: string[]
  cwd: string
  json?: boolean
  /** --tree: list package names per project (no per-package sizes until v0.3). */
  tree?: boolean
  /** --depend given at all. */
  depend?: boolean
  /** --depend <pkg>: reverse lookup — which projects declare this dependency. */
  dependPkg?: string | null
  maxDepth?: number
  recursive?: boolean
  excludes?: string[]
  keep?: string[]
  pmFilter?: string[]
  expand?: boolean
  /** --save-report: ALSO write the printed report to this file (.json/.md/.txt). */
  saveReport?: string
}

/**
 * Map (PRD §7.4): scan → per project: manifest name, PM, size, top-level
 * packages (+versions), declared dependencies. Rendering picks table/tree/depend/JSON.
 */
export async function collectMap(request: MapRequest): Promise<MapOutcome> {
  const scan = await collectScan({
    targets: request.targets,
    cwd: request.cwd,
    maxDepth: request.maxDepth,
    recursive: request.recursive,
    excludes: request.excludes,
    keep: request.keep,
    pmFilter: request.pmFilter,
  })

  const limiter = createLimiter(4)
  const entryCount = scan.result.entries.length
  let mapped = 0

  const projects = await Promise.all(
    scan.result.entries.map((entry) =>
      limiter(async () => {
        const [project, declared, refs] = await Promise.all([
          projectNameFor(entry.path),
          projectDepsFor(entry.path),
          listTopLevelPackages(entry.path),
        ])
        const pkgLimiter = createLimiter(8)
        const topPackages = await Promise.all(
          refs.map((ref) =>
            pkgLimiter(async () => {
              // version comes from the package's own manifest; size from a real-dir walk
              // (symlinked packages are never followed — they show as links, unsized).
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
        mapped += 1
        progressLine(`⠋ mapping ${mapped}/${entryCount} projects…`)
        return { entry, project, topPackages, declared }
      }),
    ),
  )
  clearProgress()

  let code = 0
  if (projects.length === 0) code = 2
  else if (scan.result.permissionIssues.length > 0) code = 4
  verboseLog(`map: ${projects.length} project(s)`)
  return { code, projects, permissionIssues: scan.result.permissionIssues }
}

/** Map + print (table / tree / depend / JSON). */
export async function runMap(request: MapRequest): Promise<number> {
  const outcome = await collectMap(request)
  const options = { cwd: request.cwd, expand: request.expand === true }

  // Reverse lookup (--depend <pkg>): keep only declaring projects.
  let projects = outcome.projects
  if (request.depend === true && request.dependPkg) {
    projects = projects.filter(
      (project) =>
        project.declared !== null &&
        (project.declared.dependencies.includes(request.dependPkg as string) ||
          project.declared.devDependencies.includes(request.dependPkg as string)),
    )
  }

  if (request.json) {
    const printed = renderMapJson({ ...outcome, projects }, request)
    log(printed)
    await writeReportSnapshot(request.saveReport, printed, { ok: note, fail: warn })
    return outcome.projects.length === 0 || projects.length === 0 ? 2 : outcome.code
  }

  if (outcome.projects.length === 0) {
    warn('no node_modules found — nothing to map here 🙃')
    return 2
  }
  if (projects.length === 0) {
    warn(`no project declares '${request.dependPkg}' in its manifest 🙃`)
    return 2
  }

  let printed: string
  if (request.depend === true && request.dependPkg) {
    printed = renderMapDependReverse(projects, request.dependPkg, options)
  } else if (request.depend === true) {
    printed = renderMapDepend(projects, options)
  } else if (request.tree === true) {
    printed = renderMapTree(projects, options)
  } else {
    printed = renderMapTable(projects, options)
  }
  log(printed)
  await writeReportSnapshot(request.saveReport, stripAnsi(printed), { ok: note, fail: warn })

  return outcome.code
}
