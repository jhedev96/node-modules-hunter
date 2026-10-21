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
