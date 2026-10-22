import { log, warn, verboseLog } from '../utils/logger.ts'
import { collectScan } from './scan.ts'
import { listTopLevelPackages, createDepClassifier, ownManifestRequires, packageVersion } from '../core/packages.ts'
import { measureEntry } from '../core/sizer.ts'
import { renderWhyReport, renderWhyJson } from '../core/render.ts'
import type { WhyInstanceInfo, WhyOutcome } from '../core/result.ts'

export interface WhyRequest {
  /** Installed package name to explain (@scope ok, exact match). */
  pkg: string
  targets: string[]
  cwd: string
  json?: boolean
  maxDepth?: number
  recursive?: boolean
  excludes?: string[]
  keep?: string[]
  pmFilter?: string[]
  expand?: boolean
}

/**
 * --why <pkg> (PRD §8.6 #5 / §8.2 reverse depend): for every installed instance of
 * the target, report the owning node_modules, the project/manifest declaration and
 * which sibling packages' manifests mention it. Manifest-level best-effort —
 * lockfile graphs land later; symlinks are never followed.
 */
export async function runWhy(request: WhyRequest): Promise<number> {
  const scan = await collectScan({
    targets: request.targets,
    cwd: request.cwd,
    maxDepth: request.maxDepth,
    recursive: request.recursive,
    excludes: request.excludes,
    keep: request.keep,
    pmFilter: request.pmFilter,
  })

  const classify = createDepClassifier()
  const instances: WhyInstanceInfo[] = []

  for (const entry of scan.result.entries) {
    const refs = await listTopLevelPackages(entry.path)
    const target = refs.find((ref) => ref.name === request.pkg)
    if (target === undefined) continue

    const declaredBy = await classify(entry.path, request.pkg)
    const targetVersion = await packageVersion(target.path)
    const requiredByList = await Promise.all(
      refs
        .filter((ref) => ref.name !== request.pkg)
        .map(async (ref) => {
          const hit = await ownManifestRequires(ref.path, request.pkg)
          if (hit === null) return null
          const reqVersion = await packageVersion(ref.path)
          return { name: ref.name, version: reqVersion, range: hit.range, field: hit.field }
        }),
    )

    let size: number | null = null
    if (!target.symlinked) {
      const measured = await measureEntry(target.path)
      size = measured.size
    }
    instances.push({
      displayPath: entry.displayPath,
      pm: entry.pm.family,
      version: targetVersion,
      symlinked: target.symlinked,
      size,
      declaredBy: declaredBy === null ? null : { projectName: declaredBy.projectName, range: declaredBy.range, field: declaredBy.field },
      requiredBy: requiredByList.flatMap((hit) => (hit === null ? [] : [hit])),
    })
    verboseLog(`why: ${request.pkg} in ${entry.displayPath} — ${instances[instances.length - 1]!.requiredBy.length} requirer(s)`)
  }

  let code = 0
  if (instances.length === 0) code = 2
  else if (scan.result.permissionIssues.length > 0) code = 4

  if (code === 2) {
    if (request.json) {
      log(renderWhyJson({ pkg: request.pkg, instances, permissionIssues: scan.result.permissionIssues, code }, request))
      return 2
    }
    warn(`no instance of '${request.pkg}' in the scanned node_modules — nmh why <pkg> [dirs]`)
    return 2
  }

  if (request.json) log(renderWhyJson({ pkg: request.pkg, instances, permissionIssues: scan.result.permissionIssues, code }, request))
  else log(renderWhyReport({ pkg: request.pkg, instances, permissionIssues: scan.result.permissionIssues, code }, { cwd: request.cwd, expand: request.expand === true }))
  return code
}
