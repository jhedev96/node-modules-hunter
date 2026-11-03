import path, { basename } from 'node:path'
import { createLimiter } from '../utils/limit.ts'
import { log, spinUpdate, spinClear, warn, verboseLog, note, payload } from '../utils/logger.ts'
import { formatBytes, stripAnsi } from '../utils/format.ts'
import { writeReportSnapshot } from '../utils/report.ts'
import { resolveRoots } from '../utils/paths.ts'
import { makeGlobMatcher } from '../utils/match.ts'
import { scanForNodeModules, type WalkEntry } from '../core/walker.ts'
import { measureEntries, type EntryMeasure } from '../core/sizer.ts'
import { measureEntryFast } from '../core/du-size.ts'
import { computeActivity, type Activity } from '../core/activity.ts'
import { createPmDetector } from '../core/pm-detect.ts'
import { projectNameFor } from '../core/packages.ts'
import { insideRoot, SELF_TOKEN } from '../core/guards.ts'
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
  /** --stale <days>: keep only entries whose project was idle >= <days> (v1.1 git activity signal). */
  stale?: number
  /** --fast-size: measure with one `du -sk` per entry (KiB granularity) instead of the file walker. */
  fastSize?: boolean
  /** --sort: result order. Default 'size' desc — the frozen v1.0 order. */
  sort?: SortKey
  /** --no-skip: don't hide .Trash*, Library/, and *.app dirs while discovering. Default: skip them (v1.1 default change). */
  skipSystem?: boolean
  /** --save-report: ALSO write the printed report to this file (.json/.md/.txt). */
  saveReport?: string
}

export interface ScanOutcome {
  /** 0 clean, 2 nothing found, 4 partial permission issues (results still listed). */
  code: number
  result: ScanCommandResult
}

/** v1.1 --sort keys: size (default, desc), path (asc), idle (desc, activity signal), mtime (newest first). */
export type SortKey = 'size' | 'path' | 'idle' | 'mtime'

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

  // "self" is a scan-level guard (protect the cwd subtree), not a glob — the walker
  // must never see it as a bare-name exclude (it would hide dirs literally named self).
  const walkExcludes = request.excludes?.filter((item) => item !== SELF_TOKEN)
  const walk = await scanForNodeModules(walkRoots, {
    maxDepth: request.maxDepth,
    recursive: request.recursive,
    excludes: walkExcludes,
    skipSystem: request.skipSystem,
  })
  const permIssues = [...walk.permissionIssues]
  collected.push(...walk.entries)

  // -r on a direct node_modules target: audit nested ones inside it.
  if (request.recursive) {
    for (const direct of directTargets) {
      const inner = await scanForNodeModules([direct], {
        maxDepth: request.maxDepth,
        recursive: true,
        excludes: walkExcludes,
        skipSystem: request.skipSystem,
        initialOwner: direct,
      })
      permIssues.push(...inner.permissionIssues)
      collected.push(...inner.entries)
    }
  }

  const metaByPath = new Map(collected.map((entry) => [entry.path, entry]))
  const entryPaths = [...metaByPath.keys()]
  verboseLog(`found ${entryPaths.length} node_modules — measuring`)

  const measures = await collectMeasures(entryPaths, request.fastSize === true, permIssues)
  spinClear()

  const detect = createPmDetector()
  const pmLimiter = createLimiter(8)
  const pmResults = await Promise.all(entryPaths.map((entryPath) => pmLimiter(() => detect(entryPath))))
  verboseLog(`scan finished in ${Date.now() - started} ms`)

  // --stale / --sort idle (v1.1): the git-activity signal costs one bounded git spawn per
  // project — only computed when asked, keyed by the entry's own dir (nested entries climb
  // to the same repo root as their owner, so the cache collapses the shared cost for free).
  const activityByPath = new Map<string, Activity>()
  if (request.stale !== undefined || request.sort === 'idle') {
    const activityLimiter = createLimiter(8)
    const cache = new Map<string, Promise<Activity | null>>()
    const activityFor = (entryPath: string): Promise<Activity | null> => {
      const startDir = path.dirname(entryPath)
      let pending = cache.get(startDir)
      if (pending === undefined) {
        pending = computeActivity(entryPath)
        cache.set(startDir, pending)
      }
      return pending
    }
    await Promise.all(
      entryPaths.map((entryPath) =>
        activityLimiter(async () => {
          const activity = await activityFor(entryPath)
          if (activity !== null) activityByPath.set(entryPath, activity)
        }),
      ),
    )
  }

  const cwd = request.cwd
  let entries: ScanEntry[] = entryPaths.map((entryPath, index) => {
    const measure = measures.get(entryPath) ?? { size: 0, packageCount: 0, mtimeMs: null }
    const meta = metaByPath.get(entryPath)
    const activity = activityByPath.get(entryPath)
    return {
      path: entryPath,
      displayPath: shortenPath(entryPath, cwd),
      size: measure.size,
      packageCount: measure.packageCount,
      pm: pmResults[index],
      mtimeMs: measure.mtimeMs,
      ...(activity !== undefined ? { idleDays: activity.idleDays, activitySource: activity.source } : {}),
      nested: meta?.nested,
      ownerPath: meta?.ownerPath,
    }
  })
  // v1.1 --sort: default stays size-desc (the v1.0 order). Ties fall back to a stable,
  // locale-free path compare; entries without the sorted datum sink to the bottom.
  const cmpStr = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0)
  const comparators: Record<SortKey, (a: ScanEntry, b: ScanEntry) => number> = {
    size: (a, b) => b.size - a.size || cmpStr(a.path, b.path),
    path: (a, b) => cmpStr(a.path, b.path) || b.size - a.size,
    idle: (a, b) => (b.idleDays ?? -1) - (a.idleDays ?? -1) || b.size - a.size,
    mtime: (a, b) => (b.mtimeMs ?? Number.NEGATIVE_INFINITY) - (a.mtimeMs ?? Number.NEGATIVE_INFINITY) || b.size - a.size,
  }
  entries.sort(comparators[request.sort ?? 'size'])

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
 * Measure every entry. Default: the exact file walker. With --fast-size (v1.1):
 * one `du -sk` per entry — KiB granularity, one syscall instead of thousands of
 * stat calls; anything du can't answer falls back silently to the walker
 * (Windows has no du, so it always walks). Progress keeps the same shape.
 */
async function collectMeasures(
  entryPaths: string[],
  fastSize: boolean,
  permIssues: string[],
): Promise<Map<string, EntryMeasure>> {
  const entryCount = entryPaths.length
  let measuredCount = 0
  let bytesSoFar = 0
  const bump = (): void => {
    spinUpdate(`measuring ${measuredCount}/${entryCount} folders · ${formatBytes(bytesSoFar)}`)
  }
  if (!fastSize) {
    return measureEntries(entryPaths, permIssues, {
      concurrency: 4,
      onProgress: (progress) => {
        measuredCount = progress.measuredEntries
        bytesSoFar = progress.bytesSoFar
        bump()
      },
    })
  }

  const measures = new Map<string, EntryMeasure>()
  const duLimiter = createLimiter(8)
  const fallbackPaths: string[] = []
  await Promise.all(
    entryPaths.map((entryPath) =>
      duLimiter(async () => {
        const fast = await measureEntryFast(entryPath)
        if (fast === null) {
          fallbackPaths.push(entryPath)
          return
        }
        measures.set(entryPath, fast)
        measuredCount += 1
        bytesSoFar += fast.size
        bump()
      }),
    ),
  )
  verboseLog(
    `fast-size: ${measures.size} entr${measures.size === 1 ? 'y' : 'ies'} via du, ${fallbackPaths.length} via walker fallback`,
  )
  if (fallbackPaths.length > 0) {
    const duBytes = bytesSoFar
    const duCount = measures.size
    const walked = await measureEntries(fallbackPaths, permIssues, {
      concurrency: 4,
      onProgress: (progress) => {
        spinUpdate(
          `measuring ${duCount + progress.measuredEntries}/${entryCount} folders · ${formatBytes(duBytes + progress.bytesSoFar)}`,
        )
      },
    })
    for (const [entryPath, measure] of walked) measures.set(entryPath, measure)
  }
  return measures
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

  // v0.9 "self": entries inside (or exactly at) the cwd subtree are dropped from scan
  // and delete flows alike — running nmh from a project protects that project wholesale.
  const selfGuard = (request.excludes?.includes(SELF_TOKEN) ?? false) || (request.keep?.includes(SELF_TOKEN) ?? false)
  const guardRoot = selfGuard ? path.resolve(request.cwd) : null

  // v1.1 --stale: entries without a readable activity signal are dropped too —
  // "cannot prove it's stale" is not a survivor in a stale-hunting run.
  const wantsStale = request.stale !== undefined
  const isStale = (entry: ScanEntry): boolean =>
    wantsStale && entry.idleDays !== undefined && entry.idleDays >= (request.stale ?? 0)

  if (!wantsPm && !keepMatcher && !excludeMatcher && !selfGuard && !wantsStale) return entries

  const survivingTops = new Set<string>()
  for (const entry of entries) {
    if (entry.nested) continue
    if (guardRoot !== null && insideRoot(entry.path, guardRoot)) continue
    if (wantsPm && !matchPm(entry)) continue
    if (wantsStale && !isStale(entry)) continue
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
    else payload(renderedScan(result, request, true))
    await writeReport(request, result)
    return outcome
  }

  if (request.json === true) payload(renderedScan(result, request, true))
  else log(renderedScan(result, request, false))
  await writeReport(request, result)
  return outcome
}

function renderedScan(result: ScanCommandResult, request: { cwd: string; sizeMode?: 'each' | 'total'; expand?: boolean; json?: boolean }, json: boolean): string {
  return renderScanResult(result, {
    cwd: request.cwd,
    json,
    sizeMode: request.sizeMode ?? 'each',
    expand: request.expand === true,
  })
}

/** --save-report: write the same report (stripped of ANSI for md/txt) alongside the screen print. */
async function writeReport(request: ScanRequest, result: ScanCommandResult): Promise<void> {
  if (!request.saveReport) return
  const ext = path.extname(request.saveReport).toLowerCase()
  const content =
    ext === '.json'
      ? renderedScan(result, request, true)
      : stripAnsi(renderedScan(result, request, false))
  // v0.9.3: one shared writer — save/notify/warn contract now identical to map/search/stats
  await writeReportSnapshot(request.saveReport, content, { ok: note, fail: warn })
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
