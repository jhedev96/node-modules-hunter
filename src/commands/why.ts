import { log, warn, verboseLog, payload } from '../utils/logger.ts'
import path from 'node:path'
import { createLimiter } from '../utils/limit.ts'
import { collectScan } from './scan.ts'
import { listTopLevelPackages, createDepClassifier, ownManifestRequires, packageVersion } from '../core/packages.ts'
import { readProjectLockGraph } from '../core/lockfile.ts'
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
 * who requires it. Required-by is lockfile-grade when the project carries a
 * parseable lockfile (npm v2/v3, yarn v1 — see core/lockfile.ts) — full transitive
 * requirers, field 'lockfile' — otherwise a best-effort sibling-manifest scan.
 * Symlinks are never followed.
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

  // v0.9.4: bounded concurrency instead of one slow sequential pass — read-only work
  // (locks, manifests, sizes); output order is preserved (Promise.all keeps input order)
  const whyLimiter = createLimiter(4)
  const instances = (
    await Promise.all(
      scan.result.entries.map((entry) =>
        whyLimiter(async (): Promise<WhyInstanceInfo | null> => {
          const refs = await listTopLevelPackages(entry.path)
          const target = refs.find((ref) => ref.name === request.pkg)
          if (target === undefined) return null

          const declaredBy = await classify(entry.path, request.pkg)
          const targetVersion = await packageVersion(target.path)

          // Lockfile-grade required-by (PRD §8.2, v0.6): dependency edges cover every
          // requirer in the project, not just top-level siblings. Names-only edges →
          // requirer version stays null; falls back to sibling manifests with no
          // lockfile (grade 'manifest').
          const lock = await readProjectLockGraph(path.dirname(entry.path))
          let requiredBy: WhyInstanceInfo['requiredBy']
          let requiredByGrade: WhyInstanceInfo['requiredByGrade']
          if (lock !== null) {
            const seen = new Set<string>()
            requiredBy = lock.dependencyEdges
              .filter((edge) => edge.to === request.pkg && edge.from !== '«root»' && edge.from !== request.pkg)
              .filter((edge) => {
                if (seen.has(edge.from)) return false
                seen.add(edge.from)
                return true
              })
              .sort((a, b) => a.from.localeCompare(b.from))
              .map((edge) => ({ name: edge.from, version: null, range: edge.range, field: 'lockfile' }))
            requiredByGrade = 'lockfile'
          } else {
            requiredByGrade = 'manifest'
            requiredBy = await Promise.all(
              refs
                .filter((ref) => ref.name !== request.pkg)
                .map(async (ref) => {
                  const hit = await ownManifestRequires(ref.path, request.pkg)
                  if (hit === null) return null
                  const reqVersion = await packageVersion(ref.path)
                  return { name: ref.name, version: reqVersion, range: hit.range, field: hit.field }
                }),
            ).then((hits) => hits.flatMap((hit) => (hit === null ? [] : [hit])))
          }

          let size: number | null = null
          if (!target.symlinked) {
            const measured = await measureEntry(target.path)
            size = measured.size
          }
          verboseLog(`why: ${request.pkg} in ${entry.displayPath} — ${requiredBy.length} requirer(s) (${requiredByGrade})`)
          return {
            displayPath: entry.displayPath,
            pm: entry.pm.family,
            version: targetVersion,
            symlinked: target.symlinked,
            size,
            declaredBy: declaredBy === null ? null : { projectName: declaredBy.projectName, range: declaredBy.range, field: declaredBy.field },
            requiredBy,
            requiredByGrade,
          }
        }),
      ),
    )
  ).flatMap((item) => (item === null ? [] : [item]))

  let code = 0
  if (instances.length === 0) code = 2
  else if (scan.result.permissionIssues.length > 0) code = 4

  if (code === 2) {
    if (request.json) {
      payload(renderWhyJson({ pkg: request.pkg, instances, permissionIssues: scan.result.permissionIssues, code }, request))
      return 2
    }
    warn(`no instance of '${request.pkg}' in the scanned node_modules — nmh why <pkg> [dirs]`)
    return 2
  }

  if (request.json) payload(renderWhyJson({ pkg: request.pkg, instances, permissionIssues: scan.result.permissionIssues, code }, request))
  else log(renderWhyReport({ pkg: request.pkg, instances, permissionIssues: scan.result.permissionIssues, code }, { cwd: request.cwd, expand: request.expand === true }))
  return code
}
