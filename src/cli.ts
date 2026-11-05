import path from 'node:path'
import { configureLogger, errorLog, warn, verboseLog, note } from './utils/logger.ts'
import { setLocale, resolveLocale, isLocale, t } from './i18n/index.ts'
import { splitTargets, isRootPath } from './utils/paths.ts'
import { detectFutureFlags } from './utils/future-flags.ts'
import { loadConfig, ConfigError, isValidDistTag } from './utils/config.ts'
import { printHelp } from './utils/help.ts'
import { setLogDirectory } from './utils/delete-log.ts'
import { REPORT_EXTENSIONS } from './utils/report.ts'
import { validateBaselineName } from './utils/baseline.ts'
import { runUpdate } from './commands/update.ts'
import { runScan } from './commands/scan.ts'
import { runWizard } from './commands/wizard.ts'
import { checkForUpdate } from './utils/update-check.ts'
import type { NmhConfig } from './utils/config.ts'
import { cli } from './cli/program.ts'
import { resolveSubcommand, normalizeDelete, normalizePm, normalizeDepth, normalizeAnimate, printVersion } from './cli/normalize.ts'
import { tryDispatchWizard, tryDispatchConfig, tryDispatchScan, tryDispatchClean, tryDispatchDelete } from './cli/dispatch-core.ts'
import { tryDispatchSearch, tryDispatchWhy, tryDispatchTreemap, tryDispatchMap, tryDispatchStats } from './cli/dispatch-views.ts'
import type { RunContext } from './cli/context.ts'

let updateNoticeShown = false

/**
 * Parse + dispatch one argv. `main()` enters with process.argv; the wizard `--` router
 * re-enters with the view segment only — that is the recursion this shape exists for.
 * v1.5 refactor: the option registry lives in ./cli/program.ts, the pure normalizers in
 * ./cli/normalize.ts, and the per-command dispatchers in ./cli/dispatch-*.ts — runCli
 * stays the single orchestrator so the guard/dispatch ORDER is preserved verbatim.
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

  // map & stats: subcommand ('nmh map [dirs]' / 'nmh stats [dirs]') or flags (--map/-m, --stats)
  const treeGiven = flags.tree === true
  const dependGiven = flags.depend !== undefined && flags.depend !== false
  const dependPkg = typeof flags.depend === 'string' ? flags.depend : null

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

  const mapGiven = flags.map === true || subcommand === 'map'
  // statsGiven early so read-only flag guards (below) cover every dispatch, not just stats itself.
  const statsGiven = flags.stats === true || subcommand === 'stats' || subcommand === 'analyze' || subcommand === 'info'

  const ctx: RunContext = {
    flags, positionals, rest, subcommand, routerTokens, config, configSource, json, cwd,
    sizeMode, stale, fastSize, sort, skipSystem, trashMode, deleted, pm, effectiveDepth,
    recursive, expand, excludes, keep, globalGiven, reportPath,
    baselineSave, baselineCompare, baselineHistory, baselineGiven, dryRun, assumeYes,
    targets, dirTargets, scanOptions, runCli,
    topN, by, treeGiven, dependGiven, dependPkg, statsGiven,
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
  if (flags.tag !== undefined && subcommand !== 'update') {
    errorLog(t('cli.err.tagOnlyUpdate'))
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
    if ((flags.check !== undefined && flags.check !== false) && flags.info === true) {
      errorLog(t('cli.err.checkInfoExclusive'))
      return 1
    }
    // v1.4 tag inputs: --tag must carry a value, and every tag name must look like a
    // dist-tag. --check <tag> is its own tag argument; bare --check reads --tag/rc/latest.
    if (flags.tag === true) {
      errorLog(t('cli.err.tagNeedsValue'))
      return 1
    }
    const flagTag = typeof flags.tag === 'string' ? flags.tag.trim() : undefined
    const checkTag = typeof flags.check === 'string' ? flags.check.trim() : undefined
    for (const candidate of [flagTag, checkTag]) {
      if (candidate !== undefined && !isValidDistTag(candidate)) {
        errorLog(t('cli.err.invalidTag', { value: candidate }))
        return 1
      }
    }
    const checkGiven = flags.check !== undefined && flags.check !== false
    const tag = flagTag ?? checkTag ?? config.updateTag ?? 'latest'
    return runUpdate({
      json,
      mode: checkGiven ? 'check' : flags.info === true ? 'info' : 'default',
      answer: flags.yes === true ? 'yes' : flags.no === true ? 'no' : 'none',
      force: flags.force === true,
      tag,
    })
  }

  const wizardCode = await tryDispatchWizard(ctx)
  if (wizardCode !== null) return wizardCode

  const configCode = await tryDispatchConfig(ctx)
  if (configCode !== null) return configCode

  if ((flags.phantom === true || flags.dead === true || flags.licenses === true || flags.score === true || flags.co2 === true || flags.online === true || flags.graph === true || flags.reinstall === true) && !statsGiven) {
    errorLog(t('cli.err.statsFlagsOnly'))
    return 1
  }

  const searchCode = await tryDispatchSearch(ctx)
  if (searchCode !== null) return searchCode

  const whyCode = await tryDispatchWhy(ctx)
  if (whyCode !== null) return whyCode

  const treemapCode = await tryDispatchTreemap(ctx)
  if (treemapCode !== null) return treemapCode

  // map & stats guards: tree/depend belong to map/stats runs only (topN/by/treeGiven/
  // dependGiven/dependPkg are computed above, before ctx assembly — pure flag reads)
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

  const mapCode = await tryDispatchMap(ctx)
  if (mapCode !== null) return mapCode

  const statsCode = await tryDispatchStats(ctx)
  if (statsCode !== null) return statsCode

  if (flags.top !== undefined || by !== null) {
    errorLog(t('cli.err.topByStats'))
    return 1
  }
  if (globalGiven) {
    errorLog(t('cli.err.globalOnlyStats'))
    return 1
  }

  const scanCode = await tryDispatchScan(ctx)
  if (scanCode !== null) return scanCode

  const cleanCode = await tryDispatchClean(ctx)
  if (cleanCode !== null) return cleanCode

  const deleteCode = await tryDispatchDelete(ctx)
  if (deleteCode !== null) return deleteCode

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
