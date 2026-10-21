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
  /** Total size of scanned node_modules (top-level only — matches `--size total`). */
  totalSize: number
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

export interface StatsOutcome {
  /** 0 report produced, 2 nothing found, 4 partial permission issues. */
  code: number
  projects: MapProjectInfo[]
  overview: StatsOverview
  /** Groups sorted by totalSize desc. */
  sizeGroups: StatsPackageGroup[]
  permissionIssues: string[]
}

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
