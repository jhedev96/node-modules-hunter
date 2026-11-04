import { cac } from 'cac'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { configureLogger, errorLog, warn, verboseLog, note, isTTYOut, log } from './utils/logger.ts'
import { setLocale, resolveLocale, isLocale, t } from './i18n/index.ts'
import { splitTargets, isRootPath } from './utils/paths.ts'
import { versionDetail, renderVersionDetail } from './utils/version.ts'
import { printHelp } from './utils/help.ts'
import { detectFutureFlags } from './utils/future-flags.ts'
import { loadConfig, ConfigError } from './utils/config.ts'
import { setLogDirectory } from './utils/delete-log.ts'
import { REPORT_EXTENSIONS } from './utils/report.ts'
import { validateBaselineName } from './utils/baseline.ts'
import { runScan } from './commands/scan.ts'
import { runUpdate } from './commands/update.ts'
import { runConfigCommand, type ConfigCommandRequest, type ConfigOp } from './commands/config.ts'
import { runSearch } from './commands/search.ts'
import { runWhy } from './commands/why.ts'
import { checkForUpdate } from './utils/update-check.ts'
import { runMap } from './commands/map.ts'
import { runTreemap } from './commands/treemap.ts'
import { runStats } from './commands/stats.ts'
import { runDelete } from './commands/delete.ts'
import { runClean } from './commands/clean.ts'
import { runWizard } from './commands/wizard.ts'
import { renderFullBanner } from './utils/banner.ts'
import { runGlobal } from './commands/global.ts'
import type { DeleteMode } from './core/result.ts'
import type { NmhConfig } from './utils/config.ts'

const cli = cac('nmh')

cli.option('-h, --help', 'Show the full help screen (commands, options, examples)')
cli.option('-v, --version', 'Show the version banner (tool version, node+abi, OS/arch/kernel — --json for plain fields)')
cli.option('-d, --dir <paths>', 'Target dir(s), comma separated or repeated; globs and ~ allowed')
cli.option('--delete [mode]', 'Delete found folders: hard | soft | trash (soft = trash; no value = pick interactively)')
cli.option('--dry-run', 'Preview what would be deleted — nothing is touched')
cli.option('-y, --yes', 'Answer yes to every prompt')
cli.option('-f, --force', 'Skip all confirmations (implies --yes)')
cli.option("--size <mode>", "'total' (just aggregate) or 'each' (default); numeric top-N lands later")
cli.option('--stale <days>', 'v1.1: only projects idle >= <days> (git activity signal — last commit, else manifest, else folder mtime)')
cli.option('--fast-size', 'v1.1: measure with one `du -sk` per entry (KiB granularity) instead of walking every file')
cli.option('--sort <key>', "v1.1: order results — size (default, desc) | path | idle (oldest project first) | mtime (newest first)")
cli.option('--no-skip', 'v1.1: audit everything — stop hiding .Trash*, Library/, and *.app dirs during discovery (default: hidden)')
cli.option('--trash <mode>', "v1.1: trash mode for delete ops — 'system' (default: gio/Finder/Recycle Bin) or 'nmh' (restorable ~/.nmh/trash + manifest)")
cli.option('--json', 'Machine-readable JSON output')
cli.option('-q, --quiet', 'Minimal output — pretty tables/notes mute, but the --json payload still prints')
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
cli.option('--by <mode>', "stats only: breakdown mode — 'size' (alias: package), 'type', 'licenses'")
cli.option('--config <file>', 'Use this config file instead of the .nmhrc lookup (cwd → home)')
cli.option('-g, --global', 'stats only: analyze global installs (per-PM prefix scan; read-only)')
cli.option('--animate/--no-animate', 'Live size counter while measuring: --animate forces it on even when piped; --no-animate mutes it (auto = TTY only)')
cli.option('--save-report <file>', 'scan only: ALSO write the printed report to a file (.json/.md/.txt, format by extension)')
cli.option('--report <file>', 'alias of --save-report')
cli.option('--save-baseline <name>', 'stats only: save a metadata snapshot of this run to ~/.nmh/baselines/<name>.json')
cli.option('--compare <name>', 'stats only: diff this run against a stored baseline (totals, per-node_modules, package movers)')
cli.option('--history', 'stats only: list stored baselines — no scan at all')
cli.option('--why <pkg>', 'read-only: explain an installed package — instances, declaring manifest, which siblings require it')
cli.option('--phantom', 'stats only: imports found in project sources but declared nowhere (best-effort regex audit)')
cli.option('--dead', 'stats only: installed packages declared (outside peer) but never imported (best-effort regex audit)')
cli.option('--licenses', 'stats only: bucket installed instances by their license field; flags copyleft in production deps')
cli.option('--score', 'stats only: experimental composite bloat score 0-100 (waste % + dup factor + dead % + size)')
cli.option('--co2', 'stats only: experimental carbon estimate (storage-year + one redownload)')
cli.option('--online', 'stats only: deprecated scan — offline manifest data + lazy cached registry fallback for missing notes')
cli.option('--graph', 'stats only: dependency graph from the project lockfile (npm package-lock v2/v3) — direct/transitive, edges, depth')
cli.option('--reinstall', 'stats only: naive npm-ci-style estimate of the time to reinstall everything scanned')
cli.option('--treemap [file]', 'treemap export: single-file HTML (vanilla JS, no deps); default nmh-treemap.html in cwd')
cli.option('--out <file>', 'treemap only: where to write the HTML file (same as --treemap <file>)')
cli.option('--update-check', 'opt-in: peek npm for a newer release (non-blocking, 24 h cache; also settable in .nmhrc)')
cli.option('--check', 'update only: compare installed vs registry and exit — never installs')
cli.option('--info', 'update only: full registry detail (npm view style) — never installs')
cli.option('-n, --no', 'update only: decline the update on the command line (nothing installs)')
cli.option('--wizard', 'open the interactive wizard explicitly (same as the bare `nmh`); needs a TTY')
cli.option('--default-exclude <globs>', 'config family: manage the persisted exclude list (comma list; special value "self")')
cli.option('--default-keep <pkgs>', 'config family: manage the persisted keep list (comma list; special value "self")')
cli.option('--default-mode <mode>', 'config family: set the persisted defaultMode (hard | soft | trash)')
cli.option('--log-dir <dir>', 'config family: set the persisted recovery-log directory (logDir)')
cli.option('--language <lang>', 'UI language: en | id | zh | ru | es (also in .nmhrc / NMH_LANG; v1.3)')

const PM_FAMILIES = new Set(['npm', 'pnpm', 'yarn', 'bun', 'vp'])

/** Every dispatchable first-token (PRD §7 commands + analyze/info aliases + wizard v1.2). */
const KNOWN_SUBCOMMANDS = new Set([
  'scan', 'clean', 'search', 'map', 'why', 'treemap', 'stats',
  'analyze', 'info', 'config', 'update', 'version', 'help', 'wizard',
])

/** Read-only views the wizard `--` router may open before the menu (v1.2). */
const WIZARD_VIEWS = new Set(['stats', 'analyze', 'info', 'map', 'search', 'why', 'treemap'])

function looksLikePath(text: string): boolean {
  return (
    text.includes('/') ||
    text.includes('\\') ||
    text.startsWith('.') ||
    text.startsWith('~') ||
    /^[A-Za-z]:/.test(text)
  )
}

/**
 * Classify the first positional. Order matters:
 * 1. a registered subcommand always wins — `nmh scan` is the scan command even if a
 *    `scan/` directory happens to sit in the cwd;
 * 2. an existing cwd-relative path is a scan target — `nmh node_modules` from inside a
 *    project must hit the folder itself, not degenerate into a positional-less scan;
 * 3. path-like strings (absolute, ~/~, ./…, C:\…) are targets wherever they exist now or not
 *    (the scan reports unmatched patterns with honesty);
 * 4. anything else is an unknown command — a silent lapse; it used to fall back to a cwd scan.
 */
function resolveSubcommand(
  positionals: string[],
  cwd: string,
): { subcommand: string | null; unknown: string | null } {
  if (positionals.length === 0) return { subcommand: null, unknown: null }
  const first = positionals[0]
  if (KNOWN_SUBCOMMANDS.has(first)) return { subcommand: first, unknown: null }
  if (existsSync(path.resolve(cwd, first)) || looksLikePath(first)) {
    return { subcommand: null, unknown: null }
  }
  return { subcommand: null, unknown: first }
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

let updateNoticeShown = false

/**
 * Parse + dispatch one argv. `main()` enters with process.argv; the wizard `--` router
 * re-enters with the view segment only — that is the recursion this shape exists for.
 */
async function runCli(userArgs: string[]): Promise<number> {
  // The standalone `--` token is reserved for the wizard router (v1.2): everything after
  // it belongs to the view command. Split BEFORE cac parses so the flags of both segments
  // stay independent (`nmh wizard --dir=a -- stats --dir=b --top 5`).
  const dd = userArgs.indexOf('--')
  const routerTokens = dd >= 0 ? userArgs.slice(dd + 1) : null
  const headArgs = dd >= 0 ? userArgs.slice(0, dd) : userArgs

  const parsed = cli.parse(['node', 'nmh', ...headArgs], { run: false })
  const flags = parsed.options as Record<string, unknown>
  const positionals = (parsed.args ?? []).filter((token): token is string => typeof token === 'string')

  // i18n (v1.3): the CLI flag and the process env resolve FIRST (the config file is not
  // read yet); the loud rejection covers the flag only — env values silently fall back.
  // Pre-resolution output (early version/help, config load errors) renders English.
  const langFlag = typeof flags.language === 'string' && flags.language.length > 0 ? flags.language : undefined
  if (typeof flags.language === 'string' && flags.language.length === 0) {
    errorLog(t('cli.err.languageNeedsValue'))
    return 1
  }
  if (langFlag !== undefined && !isLocale(langFlag.trim().toLowerCase())) {
    errorLog(t('cli.err.invalidLanguage', { value: langFlag }))
    return 1
  }
  setLocale(resolveLocale(langFlag, process.env.NMH_LANG, process.env.LC_ALL, process.env.LANG))

  // run:false → built-ins handled manually for deterministic exit codes
  if (flags.version === true) {
    printVersion(flags.json === true)
    return 0
  }
  if (flags.help === true || positionals[0] === 'help') {
    printHelp()
    return 0
  }

  // .nmhrc (PRD §10): loaded before anything reads its values; explicit --config replaces the lookup
  const explicitConfig = typeof flags.config === 'string' && flags.config.length > 0 ? flags.config : null
  if (explicitConfig === null && flags.config !== undefined && flags.config !== false) {
    errorLog(t('cli.err.configNeedsPath'))
    return 1
  }
  let config: Partial<NmhConfig> = {}
  let configSource: string | null = null
  try {
    const loaded = await loadConfig(explicitConfig, process.cwd())
    config = loaded.values
    configSource = loaded.source
    if (loaded.source !== null) verboseLog(t('cli.verbose.configSource', { file: loaded.source }))
  } catch (err) {
    if (err instanceof ConfigError) {
      // `nmh config` manages the file itself: a to-be-created --config target only exists
      // AFTER a write, so the read-phase lookup must not 404 on it (invalid JSON still fails).
      const configFamilyBypass = positionals[0] === 'config' && err.code === 'file-not-found'
      if (!configFamilyBypass) {
        errorLog(err.message)
        return 1
      }
      verboseLog(t('cli.verbose.configFamilySkip'))
    } else {
      throw err
    }
  }
  if (config.logDir !== undefined) setLogDirectory(config.logDir)

  // i18n (v1.3): the config file sits above the env in the chain — re-resolve with it.
  setLocale(resolveLocale(langFlag, config.language, process.env.NMH_LANG, process.env.LC_ALL, process.env.LANG))

  // cac defaults the --no-color negation to color:true even when nobody passed it,
  // so "explicit --color on the CLI" is detected from argv, not from flags.color.
  const cliColorExplicit = process.argv.includes('--color') || process.argv.includes('--color=true')
  const json = flags.json === true || (Array.isArray(flags.json) && flags.json.includes(true))
  // same story for --animate: argv is the only way to tell "flag given" from "cac default"
  const progress: 'auto' | 'on' | 'off' = normalizeAnimate(process.argv, config.animate)
  // ANSI policy (v1.1.1): paint only where it has value — a real TTY, or an explicit
  // opt-in (`--color` flag, FORCE_COLOR env). Piped/CI runs print plain text:
  // picocolors itself enables color inside ANY CI environment (its `!!env.CI`
  // heuristic) even on a pipe, which once broke greppable output and the whole
  // CI test matrix; the TTY rule makes output deterministic everywhere.
  const isTTY = process.stdout.isTTY === true
  const colorForced =
    cliColorExplicit ||
    (process.env.FORCE_COLOR !== undefined &&
      process.env.FORCE_COLOR !== '0' &&
      process.env.FORCE_COLOR !== 'false')
  configureLogger({
    verbose: flags.verbose === true,
    quiet: flags.quiet === true,
    noColor:
      flags.noColor === true ||
      flags.color === false || // explicit CLI --no-color wins over config
      (config.color === false && !cliColorExplicit) ||
      (!isTTY && !colorForced),
    // --json shares stdout with the live counter → counter must stay silent
    progress: json ? 'off' : progress,
  })

  // --update-check (PRD §5.5): opt-in, 24 h cache, failures stay silent — never on a JSON note.
  // The wizard router re-enters runCli: the notice must print once per process, not per dispatch.
  if (!updateNoticeShown && (flags.updateCheck === true || config.updateCheck === true)) {
    updateNoticeShown = true
    const notice = await checkForUpdate().catch(() => null)
    if (notice !== null) note(notice)
  }

  for (const future of detectFutureFlags(Object.keys(flags))) {
    warn(t('cli.warn.futureFlag', { flag: future }))
  }

  let sizeMode: 'each' | 'total' = 'each'
  if (typeof flags.size === 'string') {
    if (flags.size === 'total') sizeMode = 'total'
    else if (flags.size === 'each') sizeMode = 'each'
    else if (/^\d+$/.test(flags.size)) {
      warn(t('cli.warn.sizeTopN'))
    } else {
      errorLog(t('cli.err.invalidSize', { value: flags.size }))
      return 1
    }
  } else if (flags.size === true) {
    // v0.9.2: a value-less --size used to fall through silently (rc 0, default mode) —
    // every sibling guard (--pm/--depth/--delete) refuses loud
    errorLog(t('cli.err.sizeNeedsValue'))
    return 1
  } else if (Array.isArray(flags.size)) {
    errorLog(t('cli.err.sizeTwice'))
    return 1
  }

  // --stale (v1.1): whole days; guards mirror the sibling --size family (loud, exit 1)
  let stale: number | undefined
  if (flags.stale !== undefined) {
    if (flags.stale === true) {
      errorLog(t('cli.err.staleNeedsValue'))
      return 1
    }
    if (Array.isArray(flags.stale)) {
      errorLog(t('cli.err.staleTwice'))
      return 1
    }
    const days = Number(flags.stale)
    if (!Number.isInteger(days) || days < 1 || days > 365_000) {
      errorLog(t('cli.err.invalidStale', { value: String(flags.stale) }))
      return 1
    }
    stale = days
  }

  // --fast-size (v1.1): plain boolean — duplicated flags are tolerated like --json/--recursive
  const fastSize = flags.fastSize === true || (Array.isArray(flags.fastSize) && flags.fastSize.includes(true))

  // --sort (v1.1): guards mirror the --size family — bare/multi/unknown are loud, exit 1
  let sort: 'size' | 'path' | 'idle' | 'mtime' | undefined
  if (flags.sort !== undefined) {
    if (flags.sort === true) {
      errorLog(t('cli.err.sortNeedsValue'))
      return 1
    }
    if (Array.isArray(flags.sort)) {
      errorLog(t('cli.err.sortTwice'))
      return 1
    }
    const key = String(flags.sort)
    if (key !== 'size' && key !== 'path' && key !== 'idle' && key !== 'mtime') {
      errorLog(t('cli.err.invalidSort', { key }))
      return 1
    }
    sort = key
  }

  // --no-skip (v1.1): cac maps a registered negation to skip:false (default true) —
  // same mechanics as --no-color (see cliColorExplicit above). There is no flags.noSkip.
  // Deliberate default flip: v1.0 walked everywhere; v1.1 hides system noise unless
  // this flag says otherwise (.git stays skipped always — pure cost, zero yield).
  const skipSystem = flags.skip !== false

  // --trash=system|nmh (v1.1): guards mirror the --size / --stale value-flag family.
  let trashMode: 'system' | 'nmh' | undefined
  if (flags.trash !== undefined) {
    if (flags.trash === true) {
      errorLog(t('cli.err.trashNeedsValue'))
      return 1
    }
    if (Array.isArray(flags.trash)) {
      errorLog(t('cli.err.trashTwice'))
      return 1
    }
    const mode = String(flags.trash)
    if (mode !== 'system' && mode !== 'nmh') {
      errorLog(t('cli.err.invalidTrash', { mode }))
      return 1
    }
    trashMode = mode
  }

  const deleted = normalizeDelete(flags.delete)
  if (deleted === 'invalid') {
    errorLog(t('cli.err.invalidDelete', { value: String(flags.delete) }))
    return 1
  }
  // .nmhrc defaultMode fills in a bare `--delete` (no explicit mode on the CLI)
  if (deleted.mode === null && deleted.given && config.defaultMode !== undefined) {
    deleted.mode = config.defaultMode
    verboseLog(t('cli.verbose.deleteModeFromRc', { mode: deleted.mode }))
  }

  const pm = normalizePm(flags.pm)
  if (pm === 'invalid') {
    errorLog(t('cli.err.invalidPm', { value: String(flags.pm) }))
    return 1
  }

  const depth = normalizeDepth(flags.depth)
  if (depth === 'invalid') {
    // in the config family a bare `--depth` is a KEY to unset, not a scan cap —
    // the numeric validation belongs to scan/delete flows only
    if (positionals[0] !== 'config') {
      // cac swallows `--depth -2` (the bare flag loses its value) — say so instead of printing `true`
      if (flags.depth === true) {
        errorLog(t('cli.err.depthNeedsValue'))
      } else {
        errorLog(t('cli.err.invalidDepth', { value: String(flags.depth) }))
      }
      return 1
    }
  }

  const recursive = flags.recursive === true
  const expand = flags.expand === true
  const excludes = [...(config.exclude ?? []), ...splitTargets(flags.exclude as string | string[] | undefined)]
  const keep = [...(config.keep ?? []), ...splitTargets(flags.keep as string | string[] | undefined)]
  // 'invalid' is unreachable here for scan/delete flows (returned 1 above); the config family
  // passes the raw flags.depth through untouched (line below the config dispatch), and this
  // value is never read by config — so collapse the sentinel instead of shipping the union type
  const effectiveDepth: number | undefined = typeof depth === 'number' ? depth : (config.depth ?? undefined)
  const globalGiven = flags.global === true

  // --save-report / --report (PRD §5.4): scan rides along and writes a file copy; --report is the alias
  let reportPath: string | null = null
  if (typeof flags.saveReport === 'string' && flags.saveReport.length > 0) reportPath = flags.saveReport
  else if (flags.saveReport === true) {
    errorLog(t('cli.err.saveReportNeedsValue'))
    return 1
  }
  if (reportPath === null && flags.report !== undefined) {
    if (typeof flags.report === 'string' && flags.report.length > 0) reportPath = flags.report
    else {
      errorLog(t('cli.err.reportNeedsValue'))
      return 1
    }
  }
  if (reportPath !== null) {
    const ext = path.extname(reportPath).toLowerCase()
    if (!(REPORT_EXTENSIONS as readonly string[]).includes(ext)) {
      errorLog(t('cli.err.invalidReportExt', { file: reportPath }))
      return 1
    }
  }

  // baseline trio (PRD §8.3): names validated before any scan writes happen
  if (flags.saveBaseline === true) {
    errorLog(t('cli.err.baselineNeedsName'))
    return 1
  }
  if (flags.compare === true) {
    errorLog(t('cli.err.compareNeedsName'))
    return 1
  }
  const baselineSave = typeof flags.saveBaseline === 'string' ? flags.saveBaseline : null
  const baselineCompare = typeof flags.compare === 'string' ? flags.compare : null
  const baselineHistory = flags.history === true
  if (baselineSave !== null && !validateBaselineName(baselineSave)) {
    errorLog(t('cli.err.invalidBaseline', { name: baselineSave }))
    return 1
  }
  if (baselineCompare !== null && !validateBaselineName(baselineCompare)) {
    errorLog(t('cli.err.invalidBaseline', { name: baselineCompare }))
    return 1
  }
  const baselineGiven = baselineSave !== null || baselineCompare !== null || baselineHistory

  const cwd = process.cwd()
  const dryRun = flags.dryRun === true
  const assumeYes = flags.yes === true || flags.force === true

  const resolvedSub = resolveSubcommand(positionals, cwd)
  if (resolvedSub.unknown !== null) {
    errorLog(t('cli.err.unknownCommand', { cmd: resolvedSub.unknown }))
    return 1
  }
  const subcommand = resolvedSub.subcommand
  const rest = subcommand ? positionals.slice(1) : positionals
  const dirTargets = splitTargets(flags.dir as string | string[] | undefined)
  const targets = [...rest, ...dirTargets]

  // `--pm` without a value is read-only reporting; a delete op needs an actual family to filter by.
  if (pm.given && pm.family === null && (subcommand === 'clean' || deleted.given || globalGiven)) {
    errorLog(t('cli.err.pmBare'))
    return 1
  }

  // --save-report writes scan output; delete/clean runs are not scan reports
  if (reportPath !== null && (deleted.given || subcommand === 'clean')) {
    errorLog(t('cli.err.reportNotDelete'))
    return 1
  }

  // --trash (v1.1) is a delete-op knob — harmless elsewhere, but say so
  if (trashMode !== undefined && !deleted.given && subcommand !== 'clean') {
    warn(t('cli.warn.trashOnly'))
  }

  // v0.9.4: a delete op aimed at the filesystem root is always a mistake — the scan would
  // wander every mount to find victims; point --dir at the project instead
  if (deleted.given || subcommand === 'clean') {
    for (const candidate of targets.length > 0 ? targets : ['']) {
      if (isRootPath(path.resolve(cwd, candidate))) {
        errorLog(t('cli.err.rootRefusal'))
        return 1
      }
    }
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
    stale,
    fastSize,
    sort,
    skipSystem,
  }

  if (subcommand === 'version') {
    printVersion(json)
    return 0
  }

  // --check/--info are update-only knobs — anywhere else they are a mistake, say so loud
  if ((flags.check !== undefined && flags.check !== false) && subcommand !== 'update') {
    errorLog(t('cli.err.checkOnlyUpdate'))
    return 1
  }
  if ((flags.info !== undefined && flags.info !== false) && subcommand !== 'update') {
    errorLog(t('cli.err.infoOnlyUpdate'))
    return 1
  }

  // update (v1.1 explicit, v1.2 consented): --check/--info are read-only views; the plain
  // run shows facts and asks before installing (-y installs, -n declines, --force skips
  // the ask). No scan/delete flags apply.
  if (subcommand === 'update') {
    if (deleted.given || rest.length > 0) {
      errorLog(t('cli.err.updateArgs'))
      return 1
    }
    if (flags.check === true && flags.info === true) {
      errorLog(t('cli.err.checkInfoExclusive'))
      return 1
    }
    return runUpdate({
      json,
      mode: flags.check === true ? 'check' : flags.info === true ? 'info' : 'default',
      answer: flags.yes === true ? 'yes' : flags.no === true ? 'no' : 'none',
      force: flags.force === true,
    })
  }

  // wizard (v1.2): a registered command at last. Explicit targets ride --dir (no
  // auto-climb); `nmh --wizard` is the flag form; the `--` router opens a read-only
  // view first, then drops into the menu. All of it needs a TTY — pipes get rc 1
  // with directions (the bare `nmh` fallback scan keeps its own non-TTY path below).
  const wizardIntent = subcommand === 'wizard' || flags.wizard === true
  if (routerTokens !== null && !wizardIntent) {
    errorLog(t('cli.err.routerOrphan'))
    return 1
  }
  let routerView: string[] | null = null
  if (routerTokens !== null) {
    const view = routerTokens[0]
    if (typeof view !== 'string' || !WIZARD_VIEWS.has(view)) {
      errorLog(t('cli.err.unknownWizardView', { view: String(view ?? '') }))
      return 1
    }
    routerView = routerTokens
  }
  if (wizardIntent) {
    // positional targets are the scan shortcut's syntax — the wizard scopes via --dir only
    // (rest, not positionals: for `nmh wizard …` the command token itself sits in positionals)
    if (rest.length > 0) {
      errorLog(t('cli.err.wizardPositional'))
      return 1
    }
    if (deleted.given) {
      errorLog(t('cli.err.wizardDelete'))
      return 1
    }
    if (!isTTYOut()) {
      errorLog(t('cli.err.wizardNeedsTTY'))
      return 1
    }
    if (routerView !== null) {
      // banner first, then the view as a plain one-shot run (its own flags & targets),
      // then the menu — a rc 1 from the view (usage error) ends the whole run
      log(renderFullBanner())
      const viewCode = await runCli(routerView)
      if (viewCode === 1) return 1
    }
    return runWizard(cwd, {
      defaultMode: config.defaultMode,
      json,
      settings: { source: configSource, values: config },
      excludes: excludes.length > 0 ? excludes : undefined,
      keep: keep.length > 0 ? keep : undefined,
      targets: dirTargets.length > 0 ? dirTargets : undefined,
      banner: routerView === null,
    })
  }

  // config: persisted .nmhrc management (v0.9) — info · set · add · remove · unset, prompt-free
  if (subcommand === 'config') {
    const ops = new Set<ConfigOp>(['info', 'set', 'add', 'remove', 'unset'])
    const opRaw = rest[0]
    if (typeof opRaw !== 'string' || !ops.has(opRaw as ConfigOp)) {
      errorLog(t('cli.err.configOp'))
      return 1
    }
    if (rest.length > 1) {
      errorLog(t('cli.err.configPositional', { op: opRaw }))
      return 1
    }
    if (deleted.given) {
      errorLog(t('cli.err.configDelete'))
      return 1
    }
    // cac negation pairs (lines 37/53) default to `true` in flags even when untouched —
    // argv sniffing is the only honest "was this flag actually given?" (same as normalizeAnimate).
    const colorGiven =
      process.argv.includes('--no-color') ||
      process.argv.includes('--color') ||
      process.argv.includes('--color=true') ||
      process.argv.includes('--color=false')
    const animateGiven =
      process.argv.includes('--no-animate') ||
      process.argv.includes('--animate') ||
      process.argv.includes('--animate=true') ||
      process.argv.includes('--animate=false')
    return runConfigCommand({
      op: opRaw as ConfigOp,
      cwd,
      json,
      explicitFile: typeof flags.config === 'string' && flags.config.length > 0 ? flags.config : undefined,
      defaultExclude: flags.defaultExclude as ConfigCommandRequest['defaultExclude'],
      defaultKeep: flags.defaultKeep as ConfigCommandRequest['defaultKeep'],
      defaultMode: flags.defaultMode as ConfigCommandRequest['defaultMode'],
      logDir: flags.logDir as ConfigCommandRequest['logDir'],
      depth: flags.depth as ConfigCommandRequest['depth'],
      animate: animateGiven ? (flags.animate as ConfigCommandRequest['animate']) : undefined,
      color: colorGiven ? (flags.color as ConfigCommandRequest['color']) : undefined,
      updateCheck: flags.updateCheck as ConfigCommandRequest['updateCheck'],
      language: flags.language as ConfigCommandRequest['language'],
    })
  }

  // search: subcommand (`nmh search <pattern> [dirs]`) or flag (`--search <pattern>` on any read-only form)
  const searchPattern =
    typeof flags.search === 'string' && flags.search.length > 0
      ? flags.search
      : subcommand === 'search'
        ? (rest[0] ?? null)
        : null
  // statsGiven early so read-only flag guards (below) cover every dispatch, not just stats itself.
  const statsGiven = flags.stats === true || subcommand === 'stats' || subcommand === 'analyze' || subcommand === 'info'
  if ((flags.phantom === true || flags.dead === true || flags.licenses === true || flags.score === true || flags.co2 === true || flags.online === true || flags.graph === true || flags.reinstall === true) && !statsGiven) {
    errorLog(t('cli.err.statsFlagsOnly'))
    return 1
  }
  if (subcommand === 'search' || searchPattern !== null) {
    if (deleted.given || subcommand === 'clean') {
      errorLog(t('cli.err.searchReadOnly'))
      return 1
    }
    if (searchPattern === null) {
      errorLog(t('cli.err.searchNeedsPattern'))
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
      saveReport: reportPath ?? undefined,
    })
  }

  // why: subcommand (`nmh why <pkg> [dirs]`) or flag (`--why <pkg>` on any read-only form)
  const whyGiven = typeof flags.why === 'string' && flags.why.length > 0
  if (subcommand === 'why' || whyGiven) {
    if (deleted.given || subcommand === 'clean') {
      errorLog(t('cli.err.whyReadOnly'))
      return 1
    }
    const pkg = subcommand === 'why' ? rest[0] : flags.why
    if (typeof pkg !== 'string' || pkg.length === 0) {
      errorLog(t('cli.err.whyNeedsPkg'))
      return 1
    }
    if (typeof flags.why === 'string' && subcommand === 'why' && rest.length > 1 && flags.why !== rest[0]) {
      errorLog(t('cli.err.whyConflict', { why: flags.why, pkg: rest[0] }))
      return 1
    }
    const whyTargets = subcommand === 'why' ? [...rest.slice(1), ...dirTargets] : targets
    return runWhy({
      pkg,
      targets: whyTargets,
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
  if (flags.why !== undefined) {
    errorLog(t('cli.err.whyFlagNeedsPkg'))
    return 1
  }

  // treemap (PRD §8.6 #1): `nmh treemap [dirs]` or `--treemap [file]` — single-file HTML export.
  // The flag value doubles as the output file; --out overrides it. Read-only otherwise.
  const treemapGiven = subcommand === 'treemap' || (flags.treemap !== undefined && flags.treemap !== false)
  if (treemapGiven) {
    if (deleted.given || subcommand === 'clean') {
      errorLog(t('cli.err.treemapReadOnly'))
      return 1
    }
    if (reportPath !== null) {
      errorLog(t('cli.err.reportNotTreemap'))
      return 1
    }
    const flagFile = typeof flags.treemap === 'string' ? flags.treemap : null
    const outFlag = typeof flags.out === 'string' && flags.out.length > 0 ? flags.out : null
    if (outFlag === null && flags.out !== undefined) {
      errorLog(t('cli.err.outNeedsValue'))
      return 1
    }
    const treemapTargets = subcommand === 'treemap' ? [...rest, ...dirTargets] : targets
    return runTreemap({
      targets: treemapTargets,
      cwd,
      maxDepth: effectiveDepth,
      recursive,
      excludes: excludes.length > 0 ? excludes : undefined,
      keep: keep.length > 0 ? keep : undefined,
      pmFilter: pm.family !== null ? [pm.family] : undefined,
      out: outFlag ?? flagFile ?? 'nmh-treemap.html',
      json,
    })
  }
  if (flags.out !== undefined) {
    errorLog(t('cli.err.outOnlyTreemap'))
    return 1
  }

  // map & stats: subcommand ('nmh map [dirs]' / 'nmh stats [dirs]') or flags (--map/-m, --stats)
  const treeGiven = flags.tree === true
  const dependGiven = flags.depend !== undefined && flags.depend !== false
  const dependPkg = typeof flags.depend === 'string' ? flags.depend : null
  const mapGiven = flags.map === true || subcommand === 'map'

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

  let by: 'package' | 'type' | 'size' | 'licenses' | null = null
  if (typeof flags.by === 'string') {
    if (flags.by === 'package' || flags.by === 'size' || flags.by === 'type' || flags.by === 'licenses') by = flags.by
    else {
      errorLog(t('cli.err.invalidBy', { value: flags.by }))
      return 1
    }
  }

  if ((treeGiven || dependGiven) && !mapGiven && !statsGiven) {
    if (dependGiven && !treeGiven) {
      errorLog(t('cli.err.dependOnlyMap'))
    } else {
      errorLog(t('cli.err.treeMapStats'))
    }
    return 1
  }
  if (dependGiven && !mapGiven) {
    errorLog(t('cli.err.dependOnlyMap'))
    return 1
  }
  if (mapGiven) {
    if (deleted.given || subcommand === 'clean') {
      errorLog(t('cli.err.mapReadOnly'))
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
      saveReport: reportPath ?? undefined,
    })
  }

  if (baselineGiven && !statsGiven) {
    errorLog(t('cli.err.baselineOnlyStats'))
    return 1
  }
  if (statsGiven) {
    if (deleted.given || subcommand === 'clean') {
      errorLog(t('cli.err.statsReadOnly'))
      return 1
    }
    if (globalGiven) {
      if (treeGiven || flags.top !== undefined || by !== null || flags.graph === true || flags.reinstall === true) {
        errorLog(t('cli.err.globalShapeFlags'))
        return 1
      }
      const globalTargets = [...rest, ...dirTargets]
      if (globalTargets.length > 0) {
        errorLog(t('cli.err.globalNoDir'))
        return 1
      }
      return runGlobal({
        cwd,
        json,
        pmFilter: pm.family !== null ? [pm.family] : undefined,
      })
    }
    if (topN === 'invalid') {
      errorLog(t('cli.err.invalidTop', { value: String(flags.top) }))
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
      saveBaseline: baselineSave ?? undefined,
      compareBaseline: baselineCompare ?? undefined,
      history: baselineHistory,
      phantom: flags.phantom === true,
      dead: flags.dead === true,
      licenses: flags.licenses === true,
      score: flags.score === true,
      co2: flags.co2 === true,
      online: flags.online === true,
      graph: flags.graph === true,
      reinstall: flags.reinstall === true,
      saveReport: reportPath ?? undefined,
    })
  }
  if (flags.top !== undefined || by !== null) {
    errorLog(t('cli.err.topByStats'))
    return 1
  }
  if (globalGiven) {
    errorLog(t('cli.err.globalOnlyStats'))
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
      stale,
      skipSystem,
      trashMode,
    })
  }

  if (deleted.given) {
    // `nmh --dir=… --delete=hard` with NO command is the one-liner (PRD §1) — targets default to cwd.
    if (trashMode !== undefined && deleted.mode === 'hard') {
      errorLog(t('cli.err.trashNotHard'))
      return 1
    }
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
      stale,
      skipSystem,
      trashMode,
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

  // totally bare: wizard (TTY) / compact banner + read-only scan (non-TTY, never hangs)
  return runWizard(cwd, {
    defaultMode: config.defaultMode,
    json,
    settings: { source: configSource, values: config },
    excludes: excludes.length > 0 ? excludes : undefined,
    keep: keep.length > 0 ? keep : undefined,
  })
}

/**
 * `nmh version` / `--version`: rich banner by default (v0.7 — runtime/system/io),
 * `--json` prints the same payload machine-readable.
 */
function printVersion(json: boolean): void {
  if (json) {
    console.log(JSON.stringify(versionDetail(), null, 2))
    return
  }
  console.log(renderVersionDetail(versionDetail()))
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

function main(): Promise<number> {
  return runCli(process.argv.slice(2))
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code
  })
  .catch((err: unknown) => {
    errorLog(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
