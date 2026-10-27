import type { LockGraph } from './lockfile.ts'

export type PMFamily = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown'

export interface PMInfo {
  family: PMFamily
  /** Evidence used for the call, e.g. ["packageManager"], ["pnpm-lock.yaml"], or []. */
  sources: string[]
  /** True when several package-manager families were detected at the same level. */
  multiple: boolean
  /** Nearest enclosing project/workspace root used for detection. */
  projectRoot: string
  /** True when the workspace declares the `vite-plus` wrapper (Vite+ / `vp`). */
  vp: boolean
}

export interface ScanEntry {
  /** Absolute real path of the node_modules folder. */
  path: string
  /** Shortened path for display (`~/…`, `./…`, middle-truncated). */
  displayPath: string
  /** Bytes summed from real files only — symlink targets are never followed/summed. */
  size: number
  /** Number of top-level packages in this node_modules (scopes expanded, dotdirs ignored). */
  packageCount: number
  pm: PMInfo
  mtimeMs: number | null
  /** True when discovered via -r INSIDE another entry; shown flagged, excluded from totals. */
  nested?: boolean
  /** Top-level owner entry (== path for top entries). */
  ownerPath?: string
}

export interface SearchMatch {
  name: string
  version: string | null
  /** Directory size of the matched package folder (bytes, real files only). */
  size: number
  path: string
  symlinked: boolean
}

export interface SearchEntryResult {
  entry: ScanEntry
  /** True when the pattern matched the node_modules path itself (even with no package hits). */
  pathMatch: boolean
  matches: SearchMatch[]
}

export interface SearchOutcome {
  /** 0 matches found, 2 nothing matched, 4 partial permission issues. */
  code: number
  pattern: string
  results: SearchEntryResult[]
  permissionIssues: string[]
}

export interface MapPackageRef {
  name: string
  version: string | null
  symlinked: boolean
  /** Directory size in bytes for real package dirs; null for symlinked packages / not requested. */
  size: number | null
  /** Normalized license field of the instance when stats measured it (stats-only byproduct). */
  license?: string | null
  /** Deprecated note in the installed manifest, if any (stats-only byproduct). */
  deprecated?: string | null
}

export interface MapDeclared {
  projectDir: string
  name: string | null
  dependencies: string[]
  devDependencies: string[]
}

export interface MapProjectInfo {
  entry: ScanEntry
  /** Manifest name of the nearest enclosing project (may be null). */
  project: string | null
  topPackages: MapPackageRef[]
  declared: MapDeclared | null
  /** Lockfile-grade graph when --graph ran (stats-only byproduct, like license above). */
  graph?: LockGraph | null
}

export interface MapOutcome {
  /** 0 mapped, 2 nothing found, 4 partial permission issues. */
  code: number
  projects: MapProjectInfo[]
  permissionIssues: string[]
}

export interface StatsPackageGroup {
  /** Package name (scope included, `@foo/bar`). */
  name: string
  /** Number of install instances found (copies across all scanned entries). */
  copies: number
  /** Sum of instance sizes, bytes. */
  totalSize: number
  /** Only meaningful when copies > 1: bytes recoverable by deduplicating identical versions. */
  dedupableSize?: number
}

export interface StatsOverview {
  /** Total size of scanned node_modules (top-level only — matches `--size total`). */  totalSize: number
  entryCount: number
  /** Installed package instances (= top-level dirs across entries, nested included when scanned). */
  instances: number
  /** Distinct name@version pairs. */
  unique: number
  /** instances / unique, rounded to 1 decimal. */
  dupFactor: number
  /** Bytes recoverable by deduplicating identical versions. */
  waste: number
  /** waste / totalSize of packages, % rounded to 1 decimal. */
  wastePercent: number
  /** Sum of declared dependencies+devDependencies across scanned projects (when manifests found). */
  declared: number | null
}

/** One physical copy inside a dup group (PRD §8.2 dedup suggestion). */
export interface DedupInstanceDetail {
  /** Display path of the hosting node_modules (`./api/node_modules`). */
  displayPath: string
  /** PM family of the hosting entry ('npm' | 'pnpm' | ...). */
  pm: string
  version: string | null
  /** Bytes for real dirs; null for symlinked instances. */
  size: number | null
  /** Manifest project that declares it (name), null when no manifest declares the name. */
  projectName: string | null
  /** Raw manifest value, e.g. `^4.17.0` — null when the copy arrives transitively. */
  declaredRange: string | null
  /** dependencies | devDependencies | optionalDependencies | peerDependencies. */
  declaredField: string | null
}

export interface DedupSuggestion {
  name: string
  /** The shared exact version of all copies in the group (dedup only merges identical versions). */
  version: string | null
  /** Bytes recoverable by keeping one copy (copies − 1 × median size). */
  save: number
  /** How a duplicate fold is suggested, based on the declared ranges of the copies. */
  hint: string
  instances: DedupInstanceDetail[]
}

/**
 * --graph (PRD §8.2, v0.6): per-entry graph rows from the project lockfile.
 * grade 'manifest' = no usable lockfile (or the flag never ran) — numbers stay 0.
 */
export interface GraphEntryRow {
  displayPath: string
  pm: string
  /** File part of the parsed lockfile, e.g. 'package-lock.json'; null = manifest-grade. */
  file: string | null
  grade: 'full' | 'manifest'
  rootDirect: number
  nodes: number
  edges: number
}

export interface GraphOutcome {  totalEntries: number
  /** Entries whose graph came from a real lockfile. */
  fullEntries: number
  /** Σ direct deps declared by every project root (lockfile view). */
  rootDirect: number
  /** Σ dependency edges across entries. */
  edges: number
  /** Σ distinct tree nodes across entries. */
  nodes: number
  /** Merged BFS depth histogram (hop counts summed per depth bucket). */
  depthHistogram: Array<{ depth: number; packages: number }>
  /** Σ tree nodes no edge path reaches (peers/optional pruning). */
  unreachable: number
  entries: GraphEntryRow[]
}

export interface StatsOutcome {
  /** 0 report produced, 2 nothing found, 4 partial permission issues. */
  code: number
  projects: MapProjectInfo[]
  overview: StatsOverview
  /** Groups sorted by totalSize desc. */
  sizeGroups: StatsPackageGroup[]
  /** Top identical-version dup groups with per-copy declared ranges (suggestion fuel). */
  dedupSuggestions: DedupSuggestion[]
  /** --by type: per dependency-field size/count buckets (empty on other modes). */
  typeBreakdown: StatsTypeBreakdown[]
  /** --licenses: per-license buckets (empty when the flag is absent). */
  licenseBreakdown: StatsLicenseRow[]
  /** --graph: lockfile-grade dependency graph (null when the flag is absent). */
  graph: GraphOutcome | null
  /** --score: composite bloat score (null when the flag is absent). */
  score: BloatScore | null
  /** --co2: order-of-magnitude carbon estimate (null when the flag is absent). */
  co2: Co2Estimate | null
  /** --reinstall: naive time estimate to re-install everything (null when absent). */
  reinstall: ReinstallEstimate | null
  /** deprecated sightings (null unless --deprecated/-d or --online ran). */
  deprecations: DeprecationsOutcome | null
  /** --phantom/--dead: best-effort import audit; null when the flags are absent. */
  depsAudit: DepsAudit | null
  permissionIssues: string[]
}

/**
 * --reinstall (PRD §8.2, v0.6): naive npm-ci-style re-install time estimate.
 * By contract NAIF: a fixed per-package overhead, a flat bytes-per-second
 * throughput and a name-based proxy for native builds — no real measurements.
 */
export interface ReinstallEstimate {
  seconds: number
  packages: number
  /** Distinct packages whose name hits a known native-heavy family (proxy). */
  nativePackages: number
  /** Human-readable component breakdown, e.g. '482 pkg × 60 ms + 1.2 GB / 50 MB/s + 2 native × 3 s'. */
  formula: string
  /** Assumption constants surfaced for JSON transparency. */
  msPerPackage: number
  bytesPerSecond: number
  nativeMs: number
}

export interface StatsTypeBreakdown {
  /** dependencies | devDependencies | optionalDependencies | peerDependencies | transitive */
  field: string
  /** Sum of instance sizes in this bucket (symlinked instances are sizeless). */
  size: number
  packages: number
}

/** One license bucket (PRD §8.2 license summary). */
/** Composite bloat score (PRD §8.2, experimental): waste% + dup factor + dead% + size. */
export interface BloatScoreComponents {
  /** Overview wastePercent (dedup-able bytes / package bytes). */
  wastePercent: number
  /** 0–40: waste% × 2, capped. */
  wastePoints: number
  /** Overview dupFactor (1 deprecated× = flat install). */
  dupFactor: number
  /** 0–20: (dupFactor−1) × 60, capped. */
  dupPoints: number
  /** dead declarations / instances, % when the audit ran (--dead or implicit via --score). */
  deadPercent: number
  /** 0–20: dead% × 2, capped. */
  deadPoints: number
  /** Absolute count fed into deadPercent (0 when no audit ran). */
  deadPackages: number
  /** 0–20: totalSize linear vs 512 MB reference, capped. */
  sizePoints: number
}

/** Total composite score 0–100 (higher = more bloated) + rank grade. */
export interface BloatScore {
  score: number
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  components: BloatScoreComponents
}

/** Order-of-magnitude carbon estimate (PRD §8.2, experimental — clearly labeled rough). */
export interface Co2Estimate {
  /** Package bytes / node_modules size the estimate covers. */
  totalSize: number
  /** Idle storage for one year, grams CO2e (constants in stats.ts). */
  storageGrams: number
  /** One full redownload of the same bytes, grams CO2e. */
  transferGrams: number
}

/** One deprecated instance sighting (PRD §8.2 deprecated check). */
export interface DeprecatedRef {
  name: string
  version: string | null
  /** Display path of the hosting node_modules entry. */
  displayPath: string
  /** Where the deprecation info came from: the installed manifest or the registry (--online). */
  source: 'manifest' | 'registry'
  /** Deprecation note (truncated to 200 chars). */
  message?: string
}

/** --deprecated scan outcome (null unless the stats run flagged deprecations). */
export interface DeprecationsOutcome {
  /** Instances flagged (= refs length). */
  count: number
  /** Per-instance sighting list (capped at 200 + truncated flag). */
  refs: DeprecatedRef[]
  /** True when the list exceeds the JSON cap. */
  truncated: boolean
  /** True when --online consulted the registry for missing local data. */
  online: boolean
}

/** One license bucket (PRD §8.2 license summary). */
export interface StatsLicenseRow {
  /** Normalized license type string; 'unknown' when no usable field. */
  type: string
  /** Instances carrying this license. */
  packages: number
  /** Σ sizes of those instances (symlinked sizeless). */
  size: number
  /** True when at least one instance is declared in production dependencies. */
  production: boolean
  /** True when the type looks like a copyleft family (GPL/LGPL/AGPL/MPL share-alike). */
  copyleft: boolean
}

/** One installed copy of the `--why` target. */
export interface WhyInstanceInfo {
  displayPath: string
  pm: string
  version: string | null
  symlinked: boolean
  size: number | null
  /** Project-manifest declaration around the hosting entry, null when transitive. */
  declaredBy: { projectName: string | null; range: string; field: string } | null
  /** Sibling packages whose manifests name the target (best-effort required-by). */
  requiredBy: Array<{ name: string; version: string | null; range: string; field: string }>
  /**
   * Where requiredBy came from: 'lockfile' = dependency-graph edges (richer, covers
   * transitive requirers), 'manifest' = top-level sibling manifests only.
   */
  requiredByGrade: 'manifest' | 'lockfile'
}

export interface WhyOutcome {
  /** 0 found, 2 nothing found, 4 partial permission issues. */
  code: number
  pkg: string
  instances: WhyInstanceInfo[]
  permissionIssues: string[]
}

// single canonical definition lives next to the audit implementation (deps-audit.ts);
// re-exported here so every payload consumer keeps importing from result.ts
export type { DepsAudit, DepsAuditHit } from './deps-audit.ts'
import type { DepsAudit } from './deps-audit.ts'

export interface GlobalBinIssue {
  /** package that declares the bin */
  name: string
  kind: 'broken bin symlink' | 'missing bin symlink'
  /** bin name (file name inside the PM's bin dir) */
  detail: string
}

export interface GlobalPackageInfo {
  name: string
  version: string | null
  symlinked: boolean
  /** Bytes for real package dirs; null for symlinked (never followed). */
  size: number | null
}

export interface GlobalPmReport {
  pm: string
  /** The global node_modules dir found for this PM. */
  root: string
  /** Global bin dir when discoverable; null = dead-glob checks skipped. */
  binDir: string | null
  source: 'pm' | 'fallback'
  packages: GlobalPackageInfo[]
  dead: GlobalBinIssue[]
}

export interface GlobalDuplicate {
  name: string
  pms: string[]
  /** Smallest instance size — uninstalling one PM's copy recovers at least this. */
  savings: number
}

export interface GlobalOutcome {
  /** 0 report produced, 2 nothing found. */
  code: number
  reports: GlobalPmReport[]
  skippedPms: string[]
  duplicates: GlobalDuplicate[]
  totals: { packages: number; size: number }
  permissionIssues: string[]
}

export interface ScanTotals {
  folders: number
  size: number
  packages: number
}

export interface ScanCommandResult {
  roots: string[]
  /** Sorted by size, descending. */
  entries: ScanEntry[]
  totals: ScanTotals
  permissionIssues: string[]
  unmatchedPatterns: string[]
  /** Target paths the user named that exist but have unresolvable real paths (symlink loop). */
  unresolvable: string[]
}

/** Modes for deleting. `soft` is an alias of `trash` (PRD §5.4). */
export type DeleteMode = 'hard' | 'trash'

export interface DeleteOutcomeRow {
  path: string
  size: number
  /** 'deleted' (hard) | 'trashed' | 'failed' | 'blocked' */
  status: 'deleted' | 'trashed' | 'failed' | 'blocked'
  error?: string
}

export interface DeleteOutcome {
  results: DeleteOutcomeRow[]
  freed: number
  deleted: number
  failed: number
  permissionDenied: boolean
}
