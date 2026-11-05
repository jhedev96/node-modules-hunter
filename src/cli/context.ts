import type { DeleteMode } from '../core/result.ts'
import type { NmhConfig } from '../utils/config.ts'
import type { runScan } from '../commands/scan.ts'

/**
 * Everything the per-command dispatchers need (v1.5 refactor): the parsed argv
 * pieces plus the fully-normalized flag/config values runCli assembled. The
 * `runCli` reference lets the wizard `--` router re-enter the parser without a
 * circular module import.
 */
export interface RunContext {
  flags: Record<string, unknown>
  positionals: string[]
  /** positionals minus the subcommand token (empty when none was given). */
  rest: string[]
  subcommand: string | null
  /** flags.stats / subcommand stats|analyze|info — computed once, guards + dispatcher share it. */
  statsGiven: boolean
  /** Tokens after a standalone `--` (the wizard router segment), if any. */
  routerTokens: string[] | null
  config: Partial<NmhConfig>
  configSource: string | null
  json: boolean
  cwd: string
  sizeMode: 'each' | 'total'
  stale: number | undefined
  fastSize: boolean
  sort: 'size' | 'path' | 'idle' | 'mtime' | undefined
  skipSystem: boolean
  trashMode: 'system' | 'nmh' | undefined
  deleted: { given: boolean; mode: DeleteMode | null }
  pm: { given: boolean; family: string | null }
  effectiveDepth: number | undefined
  recursive: boolean
  expand: boolean
  excludes: string[]
  keep: string[]
  globalGiven: boolean
  reportPath: string | null
  baselineSave: string | null
  baselineCompare: string | null
  baselineHistory: boolean
  baselineGiven: boolean
  dryRun: boolean
  assumeYes: boolean
  targets: string[]
  dirTargets: string[]
  /** map/stats knobs — 'invalid' topN is reported by the stats dispatcher. */
  topN: number | null | 'invalid'
  by: 'package' | 'type' | 'size' | 'licenses' | null
  treeGiven: boolean
  dependGiven: boolean
  dependPkg: string | null
  scanOptions: Parameters<typeof runScan>[0]
  /** The parser entry point — wizard router re-enters it with the view segment. */
  runCli: (args: string[]) => Promise<number>
}
