import { errorLog, log, isTTYOut } from '../utils/logger.ts'
import { t } from '../i18n/index.ts'
import { renderFullBanner } from '../utils/banner.ts'
import { runWizard } from '../commands/wizard.ts'
import { runConfigCommand, type ConfigCommandRequest, type ConfigOp } from '../commands/config.ts'
import { runScan } from '../commands/scan.ts'
import { runClean } from '../commands/clean.ts'
import { runDelete } from '../commands/delete.ts'
import { WIZARD_VIEWS } from './normalize.ts'
import type { RunContext } from './context.ts'

 /** wizard (v1.2): command or `--wizard` flag — router view first, then the menu.
  * Returns null when the run is not a wizard intent (fall through to the next dispatcher). */
export async function tryDispatchWizard(ctx: RunContext): Promise<number | null> {
  const { flags, subcommand, routerTokens, rest, deleted, cwd, config, configSource, json, excludes, keep, dirTargets, runCli } = ctx
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
  return null
}

 /** config: persisted .nmhrc management (v0.9) — info · set · add · remove · unset, prompt-free. */
export async function tryDispatchConfig(ctx: RunContext): Promise<number | null> {
  const { flags, subcommand, rest, deleted, cwd, json } = ctx
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
      updateTag: flags.updateTag as ConfigCommandRequest['updateTag'],
    })
  }
  return null
}

 /** scan: explicit subcommand — the plain scan dispatch. */
export async function tryDispatchScan(ctx: RunContext): Promise<number | null> {
  const { subcommand, scanOptions } = ctx
  if (subcommand === 'scan') {
    const outcome = await runScan(scanOptions)
    return outcome.code
  }
  return null
}

 /** clean: sweep with a delete mode chosen at runtime (prompt or rc). */
export async function tryDispatchClean(ctx: RunContext): Promise<number | null> {
  const { targets, cwd, deleted, dryRun, assumeYes, json, recursive, excludes, keep, pm, effectiveDepth, stale, skipSystem, trashMode, subcommand } = ctx
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
  return null
}

 /** delete: an explicit --delete op (one-liner or with a mode). */
export async function tryDispatchDelete(ctx: RunContext): Promise<number | null> {
  const { flags, targets, cwd, deleted, dryRun, assumeYes, json, recursive, excludes, keep, pm, effectiveDepth, stale, skipSystem, trashMode } = ctx
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
  return null
}
