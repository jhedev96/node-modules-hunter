import path from 'node:path'
import { createLimiter } from '../utils/limit.ts'
import { log, progressLine, clearProgress, warn, verboseLog, note, payload } from '../utils/logger.ts'
import { makeSearchMatcher } from '../utils/match.ts'
import { collectScan } from './scan.ts'
import { listTopLevelPackages, packageVersion } from '../core/packages.ts'
import { measureEntry } from '../core/sizer.ts'
import { renderSearchJson, renderSearchResults } from '../core/render.ts'
import { writeReportSnapshot } from '../utils/report.ts'
import { stripAnsi } from '../utils/format.ts'
import type { SearchOutcome } from '../core/result.ts'

export interface SearchRequest {
  /** User pattern: `/re/flags` → regex, glob chars → wildcard, else case-insensitive substring. */
  pattern: string
  targets: string[]
  cwd: string
  json?: boolean
  maxDepth?: number
  /** -r: also search inside nested node_modules (they appear as scan entries). */
  recursive?: boolean
  excludes?: string[]
  keep?: string[]
  pmFilter?: string[]
  expand?: boolean
  /** --save-report: ALSO write the printed report to this file (.json/.md/.txt). */
  saveReport?: string
}

/**
 * Search (PRD §7.3): filter scan results, then match (a) the node_modules path,
 * (b) installed top-level package names. Versions come from each package's own
 * manifest; per-package sizes are measured lazily for matched packages only.
 */
export async function collectSearch(request: SearchRequest): Promise<SearchOutcome> {
  const scan = await collectScan({
    targets: request.targets,
    cwd: request.cwd,
    maxDepth: request.maxDepth,
    recursive: request.recursive,
    excludes: request.excludes,
    keep: request.keep,
    pmFilter: request.pmFilter,
  })

  const match = makeSearchMatcher(request.pattern)
  const limiter = createLimiter(8)
  const entryCount = scan.result.entries.length
  let searched = 0

  const outcomes = await Promise.all(
    scan.result.entries.map((entry) =>
      limiter(async () => {
        const pathMatch =
          match(entry.path) || match(path.relative(request.cwd, entry.path))
        const packages = await listTopLevelPackages(entry.path)
        const matched = packages.filter((pkg) => match(pkg.name))
        const matches = await Promise.all(
          matched.map((pkg) =>
            limiter(async () => {
              const [version, measure] = await Promise.all([
                packageVersion(pkg.path),
                measureEntry(pkg.path),
              ])
              return {
                name: pkg.name,
                version,
                size: measure.size,
                path: pkg.path,
                symlinked: pkg.symlinked,
              }
            }),
          ),
        )
        searched += 1
        progressLine(`⠋ searching ${searched}/${entryCount} node_modules…`)
        return { entry, pathMatch, matches }
      }),
    ),
  )
  clearProgress()

  const results = outcomes.filter((outcome) => outcome.pathMatch || outcome.matches.length > 0)
  verboseLog(`search '${request.pattern}': ${results.length}/${entryCount} entries matched`)

  let code = 0
  if (results.length === 0) code = 2
  else if (scan.result.permissionIssues.length > 0) code = 4
  return { code, pattern: request.pattern, results, permissionIssues: scan.result.permissionIssues }
}

/** Search + print (list view / JSON). */
export async function runSearch(request: SearchRequest): Promise<number> {
  const outcome = await collectSearch(request)

  if (request.json) {
    const printed = renderSearchJson(outcome, request)
    payload(printed)
    await writeReportSnapshot(request.saveReport, printed, { ok: note, fail: warn })
    return outcome.code
  }

  if (outcome.results.length === 0) {
    warn(`no match for '${request.pattern}' in any scanned node_modules 🙃`)
    return outcome.code
  }

  const printed = renderSearchResults(outcome, request)
  log(printed)
  await writeReportSnapshot(request.saveReport, stripAnsi(printed), { ok: note, fail: warn })
  return outcome.code
}
