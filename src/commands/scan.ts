import path, { basename } from 'node:path'
import { createLimiter } from '../utils/limit.ts'
import { log, progressLine, clearProgress, warn, verboseLog } from '../utils/logger.ts'
import { formatBytes } from '../utils/format.ts'
import { resolveRoots } from '../utils/paths.ts'
import { makeGlobMatcher } from '../utils/match.ts'
import { scanForNodeModules, type WalkEntry } from '../core/walker.ts'
import { measureEntries } from '../core/sizer.ts'
import { createPmDetector } from '../core/pm-detect.ts'
import { projectNameFor } from '../core/packages.ts'
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
  /** -r: also discover node_modules nested INSIDE found entries. Totals stay top-level only. */
  recursive?: boolean
  /** Exclude globs applied to traversal and results. */
  excludes?: string[]
  /** --keep: never treat node_modules of these projects (glob-capable names) as victims. */
  keep?: string[]
  /** --pm: families and/or 'vp'. */
  pmFilter?: string[]
  /** --pm without value → just list what was detected. */
  listPm?: boolean
  /** --expand: show full absolute paths instead of shortened ones. */
  expand?: boolean
}

export interface ScanOutcome {
  /** 0 clean, 2 nothing found, 4 partial permission issues (results still listed). */
  code: number
  result: ScanCommandResult
}

/**
 * Core scan: expand targets → walk → measure → detect PM → filters → sort.
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

  const collected: WalkEntry[] = directTargets.map((target) => ({
    path: target,
    ownerPath: target,
    nested: false,
  }))

  const walk = await scanForNodeModules(walkRoots, {
    maxDepth: request.maxDepth,
    recursive: request.recursive,
    excludes: request.excludes,
  })
  const permIssues = [...walk.permissionIssues]
  collected.push(...walk.entries)

  // -r on a direct node_modules target: audit nested ones inside it.
  if (request.recursive) {
    for (const direct of directTargets) {
      const inner = await scanForNodeModules([direct], {
        maxDepth: request.maxDepth,
        recursive: true,
        excludes: request.excludes,
        initialOwner: direct,
      })
      permIssues.push(...inner.permissionIssues)
      collected.push(...inner.entries)
    }
  }

  const metaByPath = new Map(collected.map((entry) => [entry.path, entry]))
  const entryPaths = [...metaByPath.keys()]
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
  let entries: ScanEntry[] = entryPaths.map((entryPath, index) => {
    const measure = measures.get(entryPath) ?? { size: 0, packageCount: 0, mtimeMs: null }
    const meta = metaByPath.get(entryPath)
    return {
      path: entryPath,
      displayPath: shortenPath(entryPath, cwd),
      size: measure.size,
      packageCount: measure.packageCount,
      pm: pmResults[index],
      mtimeMs: measure.mtimeMs,
      nested: meta?.nested,
      ownerPath: meta?.ownerPath,
    }
  })
  entries.sort((a, b) => b.size - a.size)

  entries = await applyFilters(entries, request)

  const topEntries = entries.filter((entry) => !entry.nested)
  const totals: ScanTotals = {
    folders: topEntries.length,
    size: topEntries.reduce((sum, entry) => sum + entry.size, 0),
    packages: topEntries.reduce((sum, entry) => sum + entry.packageCount, 0),
  }

  const result: ScanCommandResult = {
    roots,
    entries,
    totals,
    permissionIssues: permIssues,
    unmatchedPatterns: unmatched,
    unresolvable,
  }

  if (request.listPm && !request.json && topEntries.length > 0) {
    log(`detected PMs: ${describeDetectedPms(topEntries)}`)
  }

  let code = 0
  if (entries.length === 0) code = 2
  else if (permIssues.length > 0) code = 4
  return { code, result }
}

/**
 * Filter cascade (PRD §5.5). Top entries are filtered directly; nested rows live or
 * die with their owner (and, for pm/exclude, with their own verdict too).
 */
async function applyFilters(entries: ScanEntry[], request: ScanRequest): Promise<ScanEntry[]> {
  const wantsPm = request.pmFilter !== undefined && request.pmFilter.length > 0
  const wantedFamilies = new Set(request.pmFilter ?? [])
  const matchPm = (entry: ScanEntry): boolean =>
    wantedFamilies.has(entry.pm.family) || (wantedFamilies.has('vp') && entry.pm.vp === true)

  const keepMatcher =
    request.keep !== undefined && request.keep.length > 0
      ? makeGlobMatcher(request.keep, { caseInsensitive: true })
      : null

  const excludeMatcher =
    request.excludes !== undefined && request.excludes.length > 0 ? makeGlobMatcher(request.excludes) : null

  if (!wantsPm && !keepMatcher && !excludeMatcher) return entries

  const survivingTops = new Set<string>()
  for (const entry of entries) {
    if (entry.nested) continue
    if (wantsPm && !matchPm(entry)) continue
    if (excludeMatcher && excludeMatcher(entry.path)) continue
    if (keepMatcher) {
      const name = await projectNameFor(entry.path)
      if (name && keepMatcher(name)) continue
    }
    survivingTops.add(entry.path)
  }

  return entries.filter((entry) =>
    entry.nested
      ? entry.ownerPath !== undefined &&
        survivingTops.has(entry.ownerPath) &&
        !(wantsPm && !matchPm(entry)) &&
        !(excludeMatcher && excludeMatcher(entry.path))
      : survivingTops.has(entry.path),
  )
}

function describeDetectedPms(entries: ScanEntry[]): string {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const label = entry.pm.family === 'unknown' ? 'unknown' : entry.pm.family + (entry.pm.vp ? ' [vp]' : '')
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts.entries()].map(([label, count]) => `${label}×${count}`).join(', ')
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
    expand: request.expand === true,
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
