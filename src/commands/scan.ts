import path, { basename } from 'node:path'
import { createLimiter } from '../utils/limit.ts'
import { log, progressLine, clearProgress, warn, verboseLog } from '../utils/logger.ts'
import { formatBytes } from '../utils/format.ts'
import { resolveRoots } from '../utils/paths.ts'
import { scanForNodeModules } from '../core/walker.ts'
import { measureEntries } from '../core/sizer.ts'
import { createPmDetector } from '../core/pm-detect.ts'
import { renderScanResult, shortenPath } from '../core/render.ts'
import type { ScanCommandResult, ScanEntry, ScanTotals } from '../core/result.ts'

export interface ScanRequest {
  /** Patterns / paths as typed by the user (not yet expanded). */
  targets: string[]
  cwd: string
  json?: boolean
  sizeMode?: 'each' | 'total'
  /** Depth cap for finding node_modules below each root (wizard uses 3). Default: unlimited. */
  maxDepth?: number
}

export interface ScanOutcome {
  /** 0 clean, 2 nothing found, 4 partial permission issues (results still listed). */
  code: number
  result: ScanCommandResult
}

/**
 * Core scan: expand targets → walk → measure → detect PM → sort.
 * No printing besides progress/warnings; commands decide how to render.
 */
export async function collectScan(request: ScanRequest): Promise<ScanOutcome> {
  const started = Date.now()
  const targets = request.targets.length > 0 ? request.targets : ['.']
  verboseLog(`targets: ${targets.join(', ')}`)

  const { roots, unmatched, unresolvable } = await resolveRoots(targets, request.cwd)
  for (const pattern of unmatched) warn(`no match for pattern: ${pattern}`)
  for (const suspect of unresolvable) warn(`cannot resolve real path (symlink loop?): ${suspect}`)

  if (roots.length === 0 && unmatched.length + unresolvable.length > 0) {
    return { code: 2, result: emptyResult(targets, unresolvable) }
  }

  // Targets that already ARE a node_modules folder are measured directly, not searched.
  const directTargets = roots.filter((root) => basename(root) === 'node_modules')
  const walkRoots = roots.filter((root) => basename(root) !== 'node_modules')
  verboseLog(`walk roots: ${walkRoots.length}, direct node_modules: ${directTargets.length}`)

  const walk = await scanForNodeModules(walkRoots, { maxDepth: request.maxDepth })
  const permIssues = [...walk.permissionIssues]

  const entryPaths = [...new Set([...directTargets, ...walk.entries])]
  verboseLog(`found ${entryPaths.length} node_modules — measuring`)

  const entryCount = entryPaths.length
  let bytesSoFar = 0
  let measuredCount = 0
  const measures = await measureEntries(entryPaths, permIssues, {
    concurrency: 4,
    onProgress: (progress) => {
      measuredCount = progress.measuredEntries
      bytesSoFar = progress.bytesSoFar
      progressLine(
        `⠋ measuring ${measuredCount}/${entryCount} folders · ${formatBytes(bytesSoFar)}`,
      )
    },
  })
  clearProgress()

  const detect = createPmDetector()
  const pmLimiter = createLimiter(8)
  const pmResults = await Promise.all(entryPaths.map((entryPath) => pmLimiter(() => detect(entryPath))))
  verboseLog(`scan finished in ${Date.now() - started} ms`)

  const cwd = request.cwd
  const entries: ScanEntry[] = entryPaths.map((entryPath, index) => {
    const measure = measures.get(entryPath) ?? { size: 0, packageCount: 0, mtimeMs: null }
    return {
      path: entryPath,
      displayPath: shortenPath(entryPath, cwd),
      size: measure.size,
      packageCount: measure.packageCount,
      pm: pmResults[index],
      mtimeMs: measure.mtimeMs,
    }
  })
  entries.sort((a, b) => b.size - a.size)

  const totals: ScanTotals = {
    folders: entries.length,
    size: entries.reduce((sum, entry) => sum + entry.size, 0),
    packages: entries.reduce((sum, entry) => sum + entry.packageCount, 0),
  }

  const result: ScanCommandResult = {
    roots,
    entries,
    totals,
    permissionIssues: permIssues,
    unmatchedPatterns: unmatched,
    unresolvable,
  }

  let code = 0
  if (entries.length === 0) code = 2
  else if (permIssues.length > 0) code = 4
  return { code, result }
}

/** Scan + print (table / totals line / JSON). */
export async function runScan(request: ScanRequest): Promise<ScanOutcome> {
  const outcome = await collectScan(request)
  const { result } = outcome

  if (result.entries.length === 0) {
    if (!request.json) warn('no node_modules found — nothing to hunt here 🙃')
    else log(renderScanResult(result, { cwd: request.cwd, json: true, sizeMode: request.sizeMode ?? 'each' }))
    return outcome
  }

  log(renderScanResult(result, {
    cwd: request.cwd,
    json: request.json === true,
    sizeMode: request.sizeMode ?? 'each',
  }))
  return outcome
}

function emptyResult(targets: string[], unresolvable: string[] = []): ScanCommandResult {
  return {
    roots: [],
    entries: [],
    totals: { folders: 0, size: 0, packages: 0 },
    permissionIssues: [],
    unmatchedPatterns: targets,
    unresolvable,
  }
}
