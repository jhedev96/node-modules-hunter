import { cac } from 'cac'
import path from 'node:path'
import { configureLogger, errorLog, warn, verboseLog } from './utils/logger.ts'
import { splitTargets } from './utils/paths.ts'
import { toolVersion } from './utils/version.ts'
import { detectFutureFlags } from './utils/future-flags.ts'
import { loadConfig, ConfigError } from './utils/config.ts'
import { setLogDirectory } from './utils/delete-log.ts'
import { REPORT_EXTENSIONS } from './utils/report.ts'
import { runScan } from './commands/scan.ts'
import { runSearch } from './commands/search.ts'
import { runMap } from './commands/map.ts'
import { runStats } from './commands/stats.ts'
import { runDelete } from './commands/delete.ts'
import { runClean } from './commands/clean.ts'
import { runWizard } from './commands/wizard.ts'
import { runGlobal } from './commands/global.ts'
import type { DeleteMode } from './core/result.ts'
import type { NmhConfig } from './utils/config.ts'

const cli = cac('nmh')

cli.option('-d, --dir <paths>', 'Target dir(s), comma separated or repeated; globs and ~ allowed')
cli.option('--delete [mode]', 'Delete found folders: hard | soft | trash (soft = trash; no value = pick interactively)')
cli.option('--dry-run', 'Preview what would be deleted — nothing is touched')
cli.option('-y, --yes', 'Answer yes to every prompt')
cli.option('-f, --force', 'Skip all confirmations (implies --yes)')
cli.option("--size <mode>", "'total' (just aggregate) or 'each' (default); numeric top-N lands later")
cli.option('--json', 'Machine-readable JSON output')
cli.option('-q, --quiet', 'Minimal output')
cli.option('--verbose', 'Debug chatter on stderr')
cli.option('--no-color', 'Disable ANSI colors')
cli.option('-r, --recursive', 'Also look INSIDE found node_modules (nested audit; totals stay top-level only)')
cli.option('--pm [family]', "Filter by detected PM: npm|pnpm|yarn|bun|vp — no value lists what was detected")
cli.option('--exclude <globs>', 'Exclude paths from results (comma list of globs, e.g. **/e2e/**)')
cli.option('--keep <pkgs>', 'Refuse to delete node_modules of these projects (comma list, glob ok)')
cli.option('--depth <n>', 'Max scan depth in levels below the target')
cli.option('--expand', 'Full absolute paths + extra detail in output')
cli.option('--search <pattern>', 'Search installed packages (substring, glob, or /regex/) — read-only')
cli.option('-m, --map', 'Map projects: PM, size, top-level packages, declared deps — read-only')
cli.option('--tree', "map/stats only: list per-project packages (tree view, with sizes)")
cli.option('--depend [pkg]', "map only: show declared deps; with a value, list who declares it")
cli.option('--stats', 'Stats report: overview + dup factor + waste + top sizes — read-only')
cli.option('--top <n>', 'stats only: rows in the focused size list (default 10)')
cli.option('--by <mode>', "stats only: breakdown mode — size (alias: package); 'type' lands in v0.4")
cli.option('--config <file>', 'Use this config file instead of the .nmhrc lookup (cwd → home)')
cli.option('-g, --global', 'stats only: analyze global installs (per-PM prefix scan; read-only)')
cli.option('--animate/--no-animate', 'Live size counter while measuring: --animate forces it on even when piped; --no-animate mutes it (auto = TTY only)')
cli.option('--save-report <file>', 'scan only: ALSO write the printed report to a file (.json/.md/.txt, format by extension)')
cli.option('--report <file>', 'alias of --save-report')

const PM_FAMILIES = new Set(['npm', 'pnpm', 'yarn', 'bun', 'vp'])

function looksLikePath(text: string): boolean {
  return (
    text.includes('/') ||
    text.includes('\\') ||
    text.startsWith('.') ||
    text.startsWith('~') ||
    /^[A-Za-z]:/.test(text)
  )
}

function normalizeDelete(value: unknown): { given: boolean; mode: DeleteMode | null } | 'invalid' {
  if (value === undefined || value === false) return { given: false, mode: null }
  if (value === true) return { given: true, mode: null }
  if (typeof value === 'string') {
    if (value === 'hard') return { given: true, mode: 'hard' }
    if (value === 'trash' || value === 'soft') return { given: true, mode: 'trash' }
    return 'invalid'
  }
  return 'invalid'
}

function normalizePm(value: unknown): { given: boolean; family: string | null } | 'invalid' {
  if (value === undefined) return { given: false, family: null }
  if (value === true) return { given: true, family: null } // bare --pm = list what was detected
  if (typeof value === 'string' && PM_FAMILIES.has(value)) return { given: true, family: value }
  return 'invalid'
}

function normalizeDepth(value: unknown): number | null | 'invalid' {
  if (value === undefined || value === false) return null
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10)
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  return 'invalid'
}

async function main(): Promise<number> {
  const parsed = cli.parse(process.argv, { run: false })
  const flags = parsed.options as Record<string, unknown>
  const positionals = (parsed.args ?? []).filter((token): token is string => typeof token === 'string')

  // run:false → built-ins handled manually for deterministic exit codes
  if (flags.version === true) {
    console.log(`${toolVersion()} (node ${process.version}, ${process.platform})`)
    return 0
  }
  if (flags.help === true || positionals[0] === 'help') {
    cli.outputHelp()
    return 0
  }

  // .nmhrc (PRD §10): loaded before anything reads its values; explicit --config replaces the lookup
  const explicitConfig = typeof flags.config === 'string' && flags.config.length > 0 ? flags.config : null
  if (explicitConfig === null && flags.config !== undefined && flags.config !== false) {
    errorLog('--config needs a file path — nmh --config <file> …')
    return 1
  }
  let config: Partial<NmhConfig> = {}
  try {
    const loaded = await loadConfig(explicitConfig, process.cwd())
    config = loaded.values
    if (loaded.source !== null) verboseLog(`config: ${loaded.source}`)
  } catch (err) {
    if (err instanceof ConfigError) {
      errorLog(err.message)
      return 1
    }
    throw err
  }
  if (config.logDir !== undefined) setLogDirectory(config.logDir)

  // cac defaults the --no-color negation to color:true even when nobody passed it,
  // so "explicit --color on the CLI" is detected from argv, not from flags.color.
  const cliColorExplicit = process.argv.includes('--color') || process.argv.includes('--color=true')
  const json = flags.json === true || (Array.isArray(flags.json) && flags.json.includes(true))
  // same story for --animate: argv is the only way to tell "flag given" from "cac default"
  const progress: 'auto' | 'on' | 'off' = normalizeAnimate(process.argv, config.animate)
  configureLogger({
    verbose: flags.verbose === true,
    quiet: flags.quiet === true,
    noColor:
      flags.noColor === true ||
      flags.color === false || // explicit CLI --no-color wins over config
      (config.color === false && !cliColorExplicit),
    // --json shares stdout with the live counter → counter must stay silent
    progress: json ? 'off' : progress,
  })

  for (const future of detectFutureFlags(Object.keys(flags))) {
    warn(`${future} lands in a later version (v0.2+) — ignored for now`)
  }

  let sizeMode: 'each' | 'total' = 'each'
  if (typeof flags.size === 'string') {
    if (flags.size === 'total') sizeMode = 'total'
    else if (flags.size === 'each') sizeMode = 'each'
    else if (/^\d+$/.test(flags.size)) {
      warn('--size <n> (top-N list) lands in a later version — listing every folder for now')
    } else {
      errorLog(`invalid --size: ${flags.size} (expected 'total' or 'each')`)
      return 1
    }
  }

  const deleted = normalizeDelete(flags.delete)
  if (deleted === 'invalid') {
    errorLog(`invalid --delete: ${String(flags.delete)} (expected 'hard' | 'soft' | 'trash')`)
    return 1
  }
  // .nmhrc defaultMode fills in a bare `--delete` (no explicit mode on the CLI)
  if (deleted.mode === null && deleted.given && config.defaultMode !== undefined) {
    deleted.mode = config.defaultMode
    verboseLog(`delete mode from .nmhrc: ${deleted.mode}`)
  }

  const pm = normalizePm(flags.pm)
  if (pm === 'invalid') {
    errorLog(`invalid --pm: ${String(flags.pm)} (expected npm | pnpm | yarn | bun | vp)`)
    return 1
  }

  const depth = normalizeDepth(flags.depth)
  if (depth === 'invalid') {
    errorLog(`invalid --depth: ${String(flags.depth)} (expected a non-negative integer)`)
    return 1
  }

  const recursive = flags.recursive === true
  const expand = flags.expand === true
  const excludes = [...(config.exclude ?? []), ...splitTargets(flags.exclude as string | string[] | undefined)]
  const keep = [...(config.keep ?? []), ...splitTargets(flags.keep as string | string[] | undefined)]
  const effectiveDepth = depth ?? config.depth ?? undefined
  const globalGiven = flags.global === true

  // --save-report / --report (PRD §5.4): scan rides along and writes a file copy; --report is the alias
  let reportPath: string | null = null
  if (typeof flags.saveReport === 'string' && flags.saveReport.length > 0) reportPath = flags.saveReport
  else if (flags.saveReport === true) {
    errorLog('--save-report needs a file path (.json/.md/.txt)')
    return 1
  }
  if (reportPath === null && flags.report !== undefined) {
    if (typeof flags.report === 'string' && flags.report.length > 0) reportPath = flags.report
    else {
      errorLog('--report needs a file path (.json/.md/.txt)')
      return 1
    }
  }
  if (reportPath !== null) {
    const ext = path.extname(reportPath).toLowerCase()
    if (!(REPORT_EXTENSIONS as readonly string[]).includes(ext)) {
      errorLog(`unknown report format: ${reportPath} (expected .json/.md/.txt)`)
      return 1
    }
  }

  const cwd = process.cwd()
  const dryRun = flags.dryRun === true
  const assumeYes = flags.yes === true || flags.force === true

  const subcommand = positionals[0] === undefined || looksLikePath(positionals[0]) ? null : positionals[0]
  const rest = subcommand ? positionals.slice(1) : positionals
  const dirTargets = splitTargets(flags.dir as string | string[] | undefined)
  const targets = [...rest, ...dirTargets]

  // `--pm` without a value is read-only reporting; a delete op needs an actual family to filter by.
  if (pm.given && pm.family === null && (subcommand === 'clean' || deleted.given || globalGiven)) {
    errorLog('--pm without a value only lists detected PMs — give a family (npm|pnpm|yarn|bun|vp) to filter a delete op or the --global analysis')
    return 1
  }

  // --save-report writes scan output; delete/clean runs are not scan reports
  if (reportPath !== null && (deleted.given || subcommand === 'clean')) {
    errorLog('--save-report rides along with scan — delete/clean runs are not scan reports')
    return 1
  }

  const scanOptions = {
    targets,
    cwd,
    json,
    sizeMode,
    maxDepth: effectiveDepth,
    recursive,
    excludes: excludes.length > 0 ? excludes : undefined,
    keep: keep.length > 0 ? keep : undefined,
    pmFilter: pm.family !== null ? [pm.family] : undefined,
    listPm: pm.given && pm.family === null,
    expand,
    saveReport: reportPath ?? undefined,
  }

  if (subcommand === 'version') {
    console.log(`${toolVersion()} (node ${process.version}, ${process.platform})`)
    return 0
  }

  // search: subcommand (`nmh search <pattern> [dirs]`) or flag (`--search <pattern>` on any read-only form)
  const searchPattern =
    typeof flags.search === 'string' && flags.search.length > 0
      ? flags.search
      : subcommand === 'search'
        ? (rest[0] ?? null)
        : null
  if (subcommand === 'search' || searchPattern !== null) {
    if (deleted.given || subcommand === 'clean') {
      errorLog('--search is read-only — combine it with scan, not with delete/clean')
      return 1
    }
    if (searchPattern === null) {
      errorLog('search needs a pattern — nmh search <pattern> [dirs]')
      return 1
    }
    const searchTargets =
      subcommand === 'search' ? [...rest.slice(1), ...dirTargets] : targets
    return runSearch({
      pattern: searchPattern,
      targets: searchTargets,
      cwd,
      json,
      maxDepth: effectiveDepth,
      recursive,
      excludes: excludes.length > 0 ? excludes : undefined,
      keep: keep.length > 0 ? keep : undefined,
      pmFilter: pm.family !== null ? [pm.family] : undefined,
      expand,
    })
  }

  // map & stats: subcommand ('nmh map [dirs]' / 'nmh stats [dirs]') or flags (--map/-m, --stats)
  const treeGiven = flags.tree === true
  const dependGiven = flags.depend !== undefined && flags.depend !== false
  const dependPkg = typeof flags.depend === 'string' ? flags.depend : null
  const mapGiven = flags.map === true || subcommand === 'map'
  const statsGiven =
    flags.stats === true || subcommand === 'stats' || subcommand === 'analyze' || subcommand === 'info'

  let topN: number | null | 'invalid' = null
  if (flags.top !== undefined) {
    if (typeof flags.top === 'string' && /^\d+$/.test(flags.top) && Number.parseInt(flags.top, 10) >= 1) {
      topN = Number.parseInt(flags.top, 10)
    } else if (typeof flags.top === 'number' && Number.isInteger(flags.top) && flags.top >= 1) {
      topN = flags.top
    } else {
      topN = 'invalid'
    }
  }

  let by: 'package' | 'type' | 'size' | null = null
  if (typeof flags.by === 'string') {
    if (flags.by === 'package' || flags.by === 'size' || flags.by === 'type') by = flags.by
    else {
      errorLog(`invalid --by: ${flags.by} (expected 'package' | 'size'; 'type' lands in v0.4 via a focused flag)`)
      return 1
    }
  }

  if ((treeGiven || dependGiven) && !mapGiven && !statsGiven) {
    errorLog('--tree/--depend only work with the map or stats command')
    return 1
  }
  if (dependGiven && !mapGiven) {
    errorLog('--depend only works with the map command (the stats view lands in v0.4)')
    return 1
  }
  if (mapGiven) {
    if (deleted.given || subcommand === 'clean') {
      errorLog('--map is read-only — combine it with scan, not with delete/clean')
      return 1
    }
    const mapTargets = subcommand === 'map' ? [...rest, ...dirTargets] : targets
    return runMap({
      targets: mapTargets,
      cwd,
      json,
      tree: treeGiven,
      depend: dependGiven,
      dependPkg,
      maxDepth: effectiveDepth,
      recursive,
      excludes: excludes.length > 0 ? excludes : undefined,
      keep: keep.length > 0 ? keep : undefined,
      pmFilter: pm.family !== null ? [pm.family] : undefined,
      expand,
    })
  }

  if (statsGiven) {
    if (deleted.given || subcommand === 'clean') {
      errorLog('--stats is read-only — combine it with scan, not with delete/clean')
      return 1
    }
    if (globalGiven) {
      if (treeGiven || flags.top !== undefined || by !== null) {
        errorLog('--tree/--top/--by shape per-project stats — global mode has its own table')
        return 1
      }
      const globalTargets = [...rest, ...dirTargets]
      if (globalTargets.length > 0) {
        errorLog('--global analyzes the PM global prefixes — no [dir] needed')
        return 1
      }
      return runGlobal({
        cwd,
        json,
        pmFilter: pm.family !== null ? [pm.family] : undefined,
      })
    }
    if (topN === 'invalid') {
      errorLog(`invalid --top: ${String(flags.top)} (expected a positive integer)`)
      return 1
    }
    const statsTargets = subcommand ? [...rest, ...dirTargets] : targets
    return runStats({
      targets: statsTargets,
      cwd,
      json,
      tree: treeGiven,
      topN: topN ?? undefined,
      by: by ?? undefined,
      maxDepth: effectiveDepth,
      recursive,
      excludes: excludes.length > 0 ? excludes : undefined,
      keep: keep.length > 0 ? keep : undefined,
      pmFilter: pm.family !== null ? [pm.family] : undefined,
      expand,
    })
  }
  if (flags.top !== undefined || by !== null) {
    errorLog('--top/--by only work with the stats command')
    return 1
  }
  if (globalGiven) {
    errorLog('--global only works with the stats command — nmh stats -g')
    return 1
  }

  if (subcommand === 'scan') {
    const outcome = await runScan(scanOptions)
    return outcome.code
  }

  if (subcommand === 'clean') {
    return runClean({
      targets,
      cwd,
      mode: deleted.mode,
      dryRun,
      assumeYes,
      json,
      recursive,
      excludes: excludes.length > 0 ? excludes : undefined,
      keep: keep.length > 0 ? keep : undefined,
      pmFilter: pm.family !== null ? [pm.family] : undefined,
      maxDepth: effectiveDepth,
    })
  }

  if (deleted.given) {
    // `nmh --dir=… --delete=hard` with NO command is the one-liner (PRD §1) — targets default to cwd.
    return runDelete({
      targets,
      cwd,
      mode: deleted.mode,
      dryRun,
      assumeYes,
      json,
      recursive,
      excludes: excludes.length > 0 ? excludes : undefined,
      keep: keep.length > 0 ? keep : undefined,
      pmFilter: pm.family !== null ? [pm.family] : undefined,
      maxDepth: effectiveDepth,
    })
  }

  if (positionals.length > 0 || dirTargets.length > 0) {
    // `nmh <path>` positional shortcut = scan (PRD §5.3)
    const outcome = await runScan(scanOptions)
    return outcome.code
  }

  // --save-report without any target still means "scan cwd" — the wizard would never write it
  if (reportPath !== null) {
    const outcome = await runScan(scanOptions)
    return outcome.code
  }

  // totally bare: wizard (TTY) / read-only scan (non-TTY, never hangs)
  return runWizard(cwd, { defaultMode: config.defaultMode })
}

/**
 * --animate is negatable, so cac reports flags.animate=true even when nobody passed it;
 * argv sniffing separates the explicit forms. .nmhrc animate:false mutes the default.
 */
function normalizeAnimate(argv: string[], configAnimate?: boolean): 'auto' | 'on' | 'off' {
  if (argv.includes('--no-animate') || argv.includes('--animate=false')) return 'off'
  if (argv.includes('--animate') || argv.includes('--animate=true')) return 'on'
  return configAnimate === false ? 'off' : 'auto'
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code
  })
  .catch((err: unknown) => {
    errorLog(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
