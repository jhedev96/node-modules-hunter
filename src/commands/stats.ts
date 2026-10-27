import { createLimiter } from '../utils/limit.ts'
import { log, progressLine, clearProgress, warn, verboseLog, note, errorLog, payload } from '../utils/logger.ts'
import { writeReportSnapshot } from '../utils/report.ts'
import { stripAnsi, formatBytes } from '../utils/format.ts'
import {
  snapshotFromStats,
  saveBaseline,
  loadBaseline,
  listBaselines,
  compareBaseline,
  validateBaselineName,
  type BaselineSnapshot,
  type BaselineComparison,
} from '../utils/baseline.ts'
import { toolVersion } from '../utils/version.ts'
import { collectDepsAudit } from '../core/deps-audit.ts'
import { readProjectLockGraph, type LockGraph } from '../core/lockfile.ts'
import path from 'node:path'
import { collectScan } from './scan.ts'
import { listTopLevelPackages, projectDepsFor, projectNameFor, depSpecFor, readPackageJson, licenseOf, deprecatedOf, createDepClassifier, isCopyleftLicense, type DepSpec } from '../core/packages.ts'
import { measureEntry } from '../core/sizer.ts'
import { renderMapTree, renderStatsJson, renderStatsReport, renderBaselineCompare, renderBaselineHistory } from '../core/render.ts'
import { registryDeprecated, registryDeprecatedCacheDir, MAX_REGISTRY_DEPRECATED_FETCHES } from '../utils/registry-deprecated.ts'
import type { BloatScore, Co2Estimate, DeprecatedRef, DeprecationsOutcome, DedupInstanceDetail, DedupSuggestion, GraphEntryRow, GraphOutcome, MapPackageRef, MapProjectInfo, ReinstallEstimate, StatsLicenseRow, StatsOutcome, StatsPackageGroup, StatsTypeBreakdown, StatsOverview } from '../core/result.ts'

export interface StatsRequest {
  targets: string[]
  cwd: string
  json?: boolean
  /** --tree: per-project package trees WITH sizes (reuses the map tree view). */
  tree?: boolean
  /** --top <n>: rows shown in the focused size list. Default 10. */
  topN?: number
  /** --by package|type|size|licenses — focused views per PRD §8.1. */
  by?: 'package' | 'type' | 'size' | 'licenses'
  maxDepth?: number
  recursive?: boolean
  excludes?: string[]
  keep?: string[]
  pmFilter?: string[]
  expand?: boolean
  /** --save-baseline <name>: store a metadata snapshot of this run (after comparing, when both are given). */
  saveBaseline?: string
  /** --compare <name>: diff this run against the stored baseline. */
  compareBaseline?: string
  /** --history: just list stored baselines (no scan at all). */
  history?: boolean
  /** --phantom: audit imports found in sources but declared in no manifest (best-effort). */
  phantom?: boolean
  /** --dead: audit installed+declared packages never imported (best-effort). */
  dead?: boolean
  /** --licenses: bucket instances by their (normalized) license field. */
  licenses?: boolean
  /** --score: composite bloat score 0–100 (runs the deps audit implicitly for the deadness component). */
  score?: boolean
  /** --co2: order-of-magnitude carbon estimate. */
  co2?: boolean
  /** --online: deprecated scan of installed manifests + lazy registry fallback for missing notes. */
  online?: boolean
  /** --graph: lockfile-grade dependency graph (npm package-lock v2/v3, per project). */
  graph?: boolean
  /** --reinstall: naive npm-ci-style time estimate to reinstall everything. */
  reinstall?: boolean
  /** --save-report: ALSO write the printed report to this file (.json/.md/.txt). */
  saveReport?: string
}

const round1 = (n: number): number => Math.round(n * 10) / 10
const round2 = (n: number): number => Math.round(n * 100) / 100

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
              const [manifest, measure] = await Promise.all([
                readPackageJson(ref.path),
                ref.symlinked ? Promise.resolve(null) : measureEntry(ref.path),
              ])
              return {
                name: ref.name,
                version: typeof manifest?.version === 'string' ? manifest.version : null,
                symlinked: ref.symlinked,
                size: measure === null ? null : measure.size,
                license: licenseOf(manifest),
                deprecated: deprecatedOf(manifest),
              }
            }),
          ),
        )
        measuredEntries += 1
        progressLine(`⠋ analyzing ${measuredEntries}/${entryCount} node_modules…`)
        const graph = request.graph === true
          ? await readProjectLockGraph(declared?.projectDir ?? path.dirname(entry.path))
          : undefined
        return { entry, project, topPackages, declared, graph }
      }),
    ),
  )
  clearProgress()

  // Group by NAME across all scanned entries for the size ranking, then split
  // each name group by exact version to estimate dedup-able waste.
  const byName = new Map<string, StatsPackageGroup>()
  const versionsByName = new Map<string, Map<string, number[]>>()
  const members = new Map<string, Map<string, MemberRef[]>>()
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
        // duplicate-suggestion members, per (name, exact version) — sized instances only
        const key = pkg.version ?? '(no version)'
        const nameMembers = members.get(pkg.name) ?? new Map<string, MemberRef[]>()
        const list = nameMembers.get(key) ?? []
        list.push({ ref: pkg, entryPath: project.entry.path, displayPath: project.entry.displayPath, pm: project.entry.pm.family })
        nameMembers.set(key, list)
        members.set(pkg.name, nameMembers)
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
  const dedupSuggestions = await buildSuggestions(members)

  // --by type: classify every installed instance by its declaring dep field (cached manifests)
  const typeBreakdown = request.by === 'type' ? await buildTypeBreakdown(projectsResults) : []

  // --licenses (flag or --by licenses): bucket instances by license field, production mixed in via the classifier
  const licenseBreakdown = request.licenses === true || request.by === 'licenses' ? await buildLicenseBreakdown(projectsResults) : []

  // --phantom/--dead: best-effort import audit over the enclosing project dirs
  // The audit runs for --phantom/--dead AND implicitly for --score (deadness component),
  // but is only exposed to the outcome when actually requested (depsAudit stays null otherwise).
  const requestedAudit = request.phantom === true || request.dead === true
  const needsAudit = requestedAudit || request.score === true
  const depsAudit = needsAudit
    ? await collectDepsAudit(
        projectsResults.map((project) => ({
          dir: project.declared?.projectDir ?? path.dirname(project.entry.path),
          projectName: project.declared?.name ?? null,
        })),
        new Set(projectsResults.flatMap((project) => project.topPackages.map((pkg) => pkg.name))),
      )
    : null

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

  const score = request.score === true ? buildScore(overview, depsAudit?.dead.length ?? 0) : null
  const co2 = request.co2 === true ? buildCo2(overview) : null
  const graph = request.graph === true ? buildGraphOutcome(projectsResults) : null
  const reinstall = request.reinstall === true ? buildReinstall(overview, sizeGroups.map((group) => group.name)) : null
  const deprecations = request.online === true
    ? await collectDeprecations(projectsResults, {
        cacheDir: registryDeprecatedCacheDir(),
        base: process.env.NMH_REGISTRY_URL,
      })
    : null

  let code = 0
  if (projectsResults.length === 0) code = 2
  else if (scan.result.permissionIssues.length > 0) code = 4
  verboseLog(`stats: ${projectsResults.length} entries, ${instances} instances, ${unique} unique`)
  return { code, projects: projectsResults, overview, sizeGroups, dedupSuggestions, typeBreakdown, licenseBreakdown, graph, score, co2, reinstall, deprecations, depsAudit: requestedAudit ? depsAudit : null, permissionIssues: scan.result.permissionIssues }
}

/**
 * --graph (PRD §8.2, v0.6): merge per-entry lockfile graphs into one focused
 * outcome. Entries without a usable lockfile keep row grade 'manifest' with
 * zeroed numbers, so the report can honestly say what is and is not covered.
 */
export function buildGraphOutcome(projects: MapProjectInfo[]): GraphOutcome {
  const entries: GraphEntryRow[] = projects.map((project) => {
    const graph = project.graph
    return {
      displayPath: project.entry.displayPath,
      pm: project.entry.pm.family,
      file: graph?.file ?? null,
      grade: graph !== null && graph !== undefined ? 'full' : 'manifest',
      rootDirect: graph?.rootDirect ?? 0,
      nodes: graph?.nodes ?? 0,
      edges: graph?.edges ?? 0,
    }
  })
  const histogram = new Map<number, number>()
  let unreachable = 0
  for (const project of projects) {
    if (project.graph === null || project.graph === undefined) continue
    for (const bucket of project.graph.depthHistogram) {
      histogram.set(bucket.depth, (histogram.get(bucket.depth) ?? 0) + bucket.packages)
    }
    unreachable += project.graph.unreachable
  }
  return {
    totalEntries: entries.length,
    fullEntries: entries.filter((row) => row.grade === 'full').length,
    rootDirect: entries.reduce((sum, row) => sum + row.rootDirect, 0),
    edges: entries.reduce((sum, row) => sum + row.edges, 0),
    nodes: entries.reduce((sum, row) => sum + row.nodes, 0),
    depthHistogram: [...histogram].sort((a, b) => a[0] - b[0]).map(([depth, packages]) => ({ depth, packages })),
    unreachable,
    entries,
  }
}

/**
 * --score (PRD §8.2, experimental): composite 0–100 bloat score.
 * Deterministic weights — waste% dominates (0–40), dup factor (0–20), dead
 * declarations (0–20, only when the audit data exists) and absolute size vs a
 * 512 MB reference (0–20). Higher = more bloated; grades at 20-point steps.
 */
export function buildScore(overview: StatsOverview, deadPackages: number): BloatScore {
  const wastePoints = clampPts(overview.wastePercent * 2, 40)
  const dupPoints = clampPts((overview.dupFactor - 1) * 60, 20)
  const deadPercent = overview.instances > 0 ? (deadPackages / overview.instances) * 100 : 0
  const deadPoints = clampPts(deadPercent * 2, 20)
  const sizePoints = clampPts((overview.totalSize / (512 * 1024 * 1024)) * 20, 20)
  const score = Math.min(100, wastePoints + dupPoints + deadPoints + sizePoints)
  const grade = score < 20 ? 'A' : score < 40 ? 'B' : score < 60 ? 'C' : score < 80 ? 'D' : 'F'
  return {
    score,
    grade,
    components: {
      wastePercent: overview.wastePercent,
      wastePoints,
      dupFactor: overview.dupFactor,
      dupPoints,
      deadPercent: round1(deadPercent),
      deadPoints,
      deadPackages,
      sizePoints,
    },
  }
}

/** cap a weighted component at maxPoints, rounded. */
function clampPts(value: number, max: number): number {
  return Math.min(max, Math.max(0, Math.round(value)))
}

/** --co2 (PRD §8.2, experimental): order-of-magnitude carbon estimate.
 * Storage: ~2 g CO2e per GB idle per year (grid intensity + embodied amortization —
 * published LCAs vary ~0.7–5 g; we pick the middle). Transfer: ~10 g per GB moved
 * (one redownload; quoted range 5–50). Clearly labeled rough estimates. */
export const STORAGE_GCO2_PER_GB_YEAR = 2
export const TRANSFER_GCO2_PER_GB = 10

export function buildCo2(overview: StatsOverview): Co2Estimate {
  const gb = overview.totalSize / (1024 * 1024 * 1024)
  return {
    totalSize: overview.totalSize,
    storageGrams: round2(gb * STORAGE_GCO2_PER_GB_YEAR),
    transferGrams: round2(gb * TRANSFER_GCO2_PER_GB),
  }
}

/** --reinstall (PRD §8.2, v0.6): naive re-install model. 60 ms/package covers
 * registry bookkeeping + tarball unpack on a warm SSD; 50 MB/s is a flat
 * download+extract throughput; 3 s per native-family install proxies
 * postinstall gyp/bindings builds. Published numbers vary ±2× per machine —
 * labeled naif on purpose, useful for "is touching this worth it" scaling. */
export const REINSTALL_MS_PER_PACKAGE = 60
export const REINSTALL_BYTES_PER_SECOND = 50 * 1024 * 1024
export const REINSTALL_NATIVE_MS = 3000
export const REINSTALL_NATIVE_FAMILIES = [
  'sharp', 'grpc', 'better-sqlite3', 'sqlite3', 'canvas', 'bcrypt',
  'node-pty', 'tree-sitter', 'fsevents', 'fibers', 'node-sass', 'oracledb',
]

export function buildReinstall(overview: StatsOverview, packageNames: Iterable<string>): ReinstallEstimate {
  const nativePackages = buildReinstallNativeCount(packageNames)
  const bytesPerSecond = REINSTALL_BYTES_PER_SECOND
  const packageMs = overview.instances * REINSTALL_MS_PER_PACKAGE
  const readMs = overview.totalSize / bytesPerSecond * 1000
  const nativeMs = nativePackages * REINSTALL_NATIVE_MS
  const seconds = round1((packageMs + readMs + nativeMs) / 1000)
  const formula =
    `${overview.instances} pkg × 60 ms + ${formatBytes(overview.totalSize)} / 50 MB/s + ${nativePackages} native × 3 s`
  return {
    seconds,
    packages: overview.instances,
    nativePackages,
    formula,
    msPerPackage: REINSTALL_MS_PER_PACKAGE,
    bytesPerSecond,
    nativeMs: REINSTALL_NATIVE_MS,
  }
}

/** Distinct names hitting a native-heavy family substring (case-insensitive proxy). */
export function buildReinstallNativeCount(packageNames: Iterable<string>): number {
  const native = new Set<string>()
  for (const name of packageNames) {
    const lower = name.toLowerCase()
    if (REINSTALL_NATIVE_FAMILIES.some((family) => lower.includes(family))) native.add(name)
  }
  return native.size
}

/**
 * --online (PRD §5.4/§8.2): deprecated check. Installed manifests carry npm's
 * `deprecated` note offline; instances without one get a lazy, cached registry
 * lookup (capped per run) — silent on network failures, never blocks the scan.
 */
async function collectDeprecations(
  projectsResults: MapProjectInfo[],
  options: { cacheDir: string; base?: string },
): Promise<DeprecationsOutcome> {
  const refs: DeprecatedRef[] = []
  const missing: Array<{ pkg: MapPackageRef; displayPath: string }> = []
  // v0.9.4: `truncated` means "a 201st item arrived and was refused", not "exactly at the cap"
  let overflowed = false
  for (const project of projectsResults) {
    for (const pkg of project.topPackages) {
      if (typeof pkg.deprecated === 'string') {
        if (refs.length < 200) {
          refs.push({
            name: pkg.name,
            version: pkg.version,
            displayPath: project.entry.displayPath,
            source: 'manifest',
            // ANSI escape bytes in a manifest note would paint the terminal once rendered
            message: stripAnsi(pkg.deprecated).length > 200 ? `${stripAnsi(pkg.deprecated).slice(0, 197)}…` : stripAnsi(pkg.deprecated),
          })
        } else {
          overflowed = true
        }
      } else if (pkg.deprecated === null && pkg.symlinked === false && pkg.version !== null) {
        missing.push({ pkg, displayPath: project.entry.displayPath })
      }
    }
  }
  // lazy registry fill for the blanks — unique asks, capped per run, silently best-effort
  if (missing.length > 0) {
    const unique = new Map<string, { pkg: MapPackageRef; displayPath: string }>()
    for (const hit of missing) {
      const key = `${hit.pkg.name}@${hit.pkg.version}`
      if (!unique.has(key)) unique.set(key, hit)
      if (unique.size >= MAX_REGISTRY_DEPRECATED_FETCHES) break
    }
    const fetchLimiter = createLimiter(6)
    await Promise.all(
      [...unique.values()].map((hit) =>
        fetchLimiter(async () => {
          const answer = await registryDeprecated(hit.pkg.name, hit.pkg.version ?? '', options.cacheDir, options.base)
          const message = answer?.message
          if (answer !== null && typeof message === 'string') {
            if (refs.length < 200) {
              refs.push({
                name: hit.pkg.name,
                version: hit.pkg.version,
                displayPath: hit.displayPath,
                source: 'registry',
                message: stripAnsi(message).length > 200 ? `${stripAnsi(message).slice(0, 197)}…` : stripAnsi(message),
              })
            } else {
              overflowed = true
            }
          }
        }),
      ),
    )
  }
  return { count: refs.length, refs, truncated: overflowed, online: true }
}

/**
 * --licenses (PRD §8.2): one bucket per license type across all instances.
 * Instance size sums exclude symlinks; `production` = declared in `dependencies`;
 * missing/unrecognizable fields land in the `unknown` bucket, sorted last.
 */
async function buildLicenseBreakdown(projectsResults: MapProjectInfo[]): Promise<StatsLicenseRow[]> {
  const classify = createDepClassifier()
  const buckets = new Map<string, { packages: number; size: number; production: boolean; copyleft: boolean }>()
  await Promise.all(
    projectsResults.map(async (project) => {
      for (const pkg of project.topPackages) {
        const type = pkg.license ?? 'unknown'
        const hit = await classify(project.entry.path, pkg.name)
        const production = hit?.field === 'dependencies'
        let bucket = buckets.get(type)
        if (bucket === undefined) {
          bucket = { packages: 0, size: 0, production: false, copyleft: isCopyleftLicense(type) }
          buckets.set(type, bucket)
        }
        bucket.packages += 1
        if (pkg.size != null) bucket.size += pkg.size
        bucket.production = bucket.production || production
      }
    }),
  )
  return [...buckets]
    .map(([type, agg]) => ({ type, ...agg }))
    .sort((a, b) => (a.type === 'unknown' ? 1 : b.type === 'unknown' ? -1 : b.packages - a.packages || a.type.localeCompare(b.type)))
}

/**
 * --by type (PRD §8.1): bucket every installed instance by the dep field declaring it —
 * undeclared instances fold into `transitive`. Fixed canonical bucket order.
 */
async function buildTypeBreakdown(projectsResults: MapProjectInfo[]): Promise<StatsTypeBreakdown[]> {
  const classify = createDepClassifier()
  const buckets = new Map<string, { size: number; packages: number }>()
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'transitive']) {
    buckets.set(field, { size: 0, packages: 0 })
  }
  await Promise.all(
    projectsResults.map(async (project) => {
      for (const pkg of project.topPackages) {
        const hit = await classify(project.entry.path, pkg.name)
        const bucket = buckets.get(hit?.field ?? 'transitive')!
        bucket.packages += 1
        if (pkg.size != null) bucket.size += pkg.size
      }
    }),
  )
  return [...buckets].map(([field, agg]) => ({ field, size: agg.size, packages: agg.packages }))
}

/** Enough to find an instance's hosting entry + manifest again when building suggestions. */
interface MemberRef {
  ref: MapPackageRef
  entryPath: string
  displayPath: string
  pm: string
}

/** Identical-version groups ≥2 copies, ranked by save (PRD §8.2 dedup suggestion), top 5. */
async function buildSuggestions(members: Map<string, Map<string, MemberRef[]>>): Promise<DedupSuggestion[]> {
  const specCache = new Map<string, DepSpec | null>()
  const suggestions: DedupSuggestion[] = []
  for (const [name, byVersion] of members) {
    for (const [key, list] of byVersion) {
      if (list.length < 2) continue
      const sizes = list.map((member) => member.ref.size ?? 0).sort((a, b) => a - b)
      const median = sizes[Math.floor((sizes.length - 1) / 2)]
      const save = (sizes.length - 1) * median
      if (save <= 0) continue
      const instances = await Promise.all(
        list.map(async (member): Promise<DedupInstanceDetail> => {
          const cacheKey = `${member.entryPath}\u0000${name}`
          let spec = specCache.get(cacheKey)
          if (spec === undefined) {
            spec = await depSpecFor(member.entryPath, name)
            specCache.set(cacheKey, spec)
          }
          return {
            displayPath: member.displayPath,
            pm: member.pm,
            version: member.ref.version,
            size: member.ref.size,
            projectName: spec?.projectName ?? null,
            declaredRange: spec?.range ?? null,
            declaredField: spec?.field ?? null,
          }
        }),
      )
      suggestions.push({ name, version: key === '(no version)' ? null : key, save, hint: dedupHint(instances), instances })
    }
  }
  suggestions.sort((a, b) => b.save - a.save || a.name.localeCompare(b.name))
  return suggestions.slice(0, 5)
}

function dedupHint(instances: DedupInstanceDetail[]): string {
  const declared = instances.filter((inst) => inst.declaredRange !== null)
  if (declared.length === 0) {
    return 'copies resolusinya ikut parent masing-masing — tidak ada knob langsung di project level'
  }
  const ranges = [...new Set(declared.map((inst) => inst.declaredRange))].filter((range) => range !== null)
  if (ranges.length === 1) {
    const tail = ` (declared ${ranges[0]})`
    return instances.some((inst) => inst.pm === 'pnpm')
      ? `range declared identik — pnpm virtual store melipat copy hoisted; cukup satu versi di workspace root${tail}`
      : `range declared identik — jalankan install ulang / npm dedupe · yarn dedupe melipat copy hoisted${tail}`
  }
  return `range declared beda (${ranges.join(' vs ')}) — samakan dulu di package.json, lalu install ulang`
}

/** Stats + print (report / tree / JSON), with optional baseline save/compare/history (PRD §8.3). */
export async function runStats(request: StatsRequest): Promise<number> {
  // --history needs no scan at all — the listing is the whole job
  if (request.history === true) {
    const items = await listBaselines()
    if (request.json) {
      payload(JSON.stringify({ nmh: toolVersion(), command: 'stats', mode: 'baseline-history', baselines: items }, null, 2))
      return 0
    }
    log(renderBaselineHistory(items, request.cwd))
    return items.length > 0 ? 0 : 2
  }

  // save/compare names are validated & the comparison baseline loaded BEFORE scanning —
  // both are usage errors (exit 1) if the name is bad or unknown
  let baseForCompare: BaselineSnapshot | null = null
  if (request.saveBaseline !== undefined) {
    if (!validateBaselineName(request.saveBaseline)) {
      errorLog(`invalid baseline name: '${request.saveBaseline}' (expected letters/digits/._-, max 64)`)
      return 1
    }
  }
  if (request.compareBaseline !== undefined) {
    if (!validateBaselineName(request.compareBaseline)) {
      errorLog(`invalid baseline name: '${request.compareBaseline}' (expected letters/digits/._-, max 64)`)
      return 1
    }
    baseForCompare = await loadBaseline(request.compareBaseline)
    if (baseForCompare === null) {
      const names = (await listBaselines()).map((item) => item.name)
      errorLog(
        `no baseline named '${request.compareBaseline}' — ${
          names.length > 0 ? `saved: ${names.join(', ')}` : 'save one first with nmh stats --save-baseline <name>'
        }`,
      )
      return 1
    }
  }

  const outcome = await collectStats(request)

  if (outcome.projects.length === 0) {
    // an empty scan is still an honest snapshot ("dir was clean at T0")
    const fresh = snapshotFromStats(request.cwd, outcome)
    let savedFile: string | null = null
    if (request.saveBaseline !== undefined) {
      savedFile = await saveBaselineQuiet(request.saveBaseline, fresh)
      if (savedFile !== null) note(`💾 baseline saved → ${request.saveBaseline} (empty snapshot — no node_modules yet)`)
    }
    if (request.compareBaseline !== undefined) {
      warn(`nothing to compare — no node_modules scanned; baseline '${request.compareBaseline}' kept as-is`)
    }
    if (request.json) {
      const baselineExtra = { saved: savedFile !== null ? { name: request.saveBaseline!, createdAt: fresh.createdAt, file: savedFile } : undefined, compare: null }
      payload(renderStatsJson(outcome, request, { baseline: baselineExtra }))
      return 2
    }
    warn('no node_modules found — nothing to analyze here 🙃')
    return 2
  }

  const fresh = snapshotFromStats(request.cwd, outcome)
  const comparison = baseForCompare !== null ? compareBaseline(request.compareBaseline!, baseForCompare, fresh) : null

  let savedFile: string | null = null
  if (request.saveBaseline !== undefined) {
    savedFile = await saveBaselineQuiet(request.saveBaseline, fresh)
    if (savedFile !== null) note(`💾 baseline saved → ${request.saveBaseline}`)
  }

  if (request.json) {
    const baselineExtra = {
      saved: savedFile !== null ? { name: request.saveBaseline!, createdAt: fresh.createdAt, file: savedFile } : undefined,
      compare: comparison,
    }
    const printed = renderStatsJson(outcome, request, { baseline: baselineExtra })
    payload(printed)
    await writeReportSnapshot(request.saveReport, printed, { ok: note, fail: warn })
    return outcome.code
  }

  let printed: string
  if (request.tree === true) {
    printed = renderMapTree(outcome.projects, { cwd: request.cwd, expand: request.expand === true })
    if (comparison !== null) printed += '\n' + renderBaselineCompare(comparison)
  } else {
    printed = renderStatsReport(outcome, {
      cwd: request.cwd,
      expand: request.expand === true,
      topN: request.topN ?? 10,
      by: request.by ?? null,
      licenses: request.licenses === true || request.by === 'licenses',
      audit: auditFocus(request),
    })
    if (comparison !== null) printed += '\n' + renderBaselineCompare(comparison)
  }
  log(printed)
  await writeReportSnapshot(request.saveReport, stripAnsi(printed), { ok: note, fail: warn })
  return outcome.code
}

/** which halves of the deps audit to show for this run (PRD §8.1 focused flags). */
export function auditFocus(request: { phantom?: boolean; dead?: boolean }): 'phantom' | 'dead' | 'both' | null {
  const phantom = request.phantom === true
  const dead = request.dead === true
  if (phantom && dead) return 'both'
  if (phantom) return 'phantom'
  if (dead) return 'dead'
  return null
}

/** Baseline write failures are surfaced non-fatally: the report itself already printed. */
async function saveBaselineQuiet(name: string, snapshot: BaselineSnapshot): Promise<string | null> {
  try {
    return await saveBaseline(name, snapshot)
  } catch (err) {
    warn(`could not save baseline '${name}': ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
