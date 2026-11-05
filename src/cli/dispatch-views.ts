import { errorLog } from '../utils/logger.ts'
import { t } from '../i18n/index.ts'
import { runSearch } from '../commands/search.ts'
import { runWhy } from '../commands/why.ts'
import { runTreemap } from '../commands/treemap.ts'
import { runMap } from '../commands/map.ts'
import { runGlobal } from '../commands/global.ts'
import { runStats } from '../commands/stats.ts'
import type { RunContext } from './context.ts'

 /** search: subcommand (`nmh search <pattern> [dirs]`) or flag (`--search <pattern>`). Returns null when not a search run. */
export async function tryDispatchSearch(ctx: RunContext): Promise<number | null> {
  const { flags, subcommand, rest, deleted, targets, dirTargets, json, effectiveDepth, recursive, excludes, keep, pm, expand, reportPath, cwd } = ctx
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
  return null
}
 /** why: subcommand (`nmh why <pkg> [dirs]`) or flag (`--why <pkg>`). Returns null when not a why run. */
export async function tryDispatchWhy(ctx: RunContext): Promise<number | null> {
  const { flags, subcommand, rest, deleted, targets, dirTargets, json, effectiveDepth, recursive, excludes, keep, pm, expand, cwd } = ctx
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
  return null
}
 /** treemap: `nmh treemap [dirs]` or `--treemap [file]` — single-file HTML export. Returns null when not a treemap run. */
export async function tryDispatchTreemap(ctx: RunContext): Promise<number | null> {
  const { flags, subcommand, deleted, reportPath, targets, dirTargets, json, effectiveDepth, recursive, excludes, keep, pm, rest, cwd } = ctx
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
  return null
}
 /** map: `nmh map [dirs]` or `--map/-m`. Returns null when not a map run. */
export async function tryDispatchMap(ctx: RunContext): Promise<number | null> {
  const { flags, subcommand, deleted, rest, dirTargets, targets, json, effectiveDepth, recursive, excludes, keep, pm, expand, reportPath, dependGiven, dependPkg, treeGiven, cwd } = ctx
  const mapGiven = flags.map === true || subcommand === 'map'
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
  return null
}
 /** stats (and its -g global view): `nmh stats [dirs]` or `--stats`/aliases. Returns null when not a stats run. */
export async function tryDispatchStats(ctx: RunContext): Promise<number | null> {
  const { flags, subcommand, deleted, rest, dirTargets, targets, json, effectiveDepth, recursive, excludes, keep, pm, expand, reportPath, globalGiven, treeGiven, by, topN, baselineSave, baselineCompare, baselineHistory, baselineGiven, cwd, statsGiven } = ctx
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
  return null
}
