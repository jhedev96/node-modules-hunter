import { cac } from 'cac'
import { configureLogger, errorLog, warn } from './utils/logger.ts'
import { splitTargets } from './utils/paths.ts'
import { toolVersion } from './utils/version.ts'
import { detectFutureFlags } from './utils/future-flags.ts'
import { runScan } from './commands/scan.ts'
import { runDelete } from './commands/delete.ts'
import { runClean } from './commands/clean.ts'
import { runWizard } from './commands/wizard.ts'
import type { DeleteMode } from './core/result.ts'

const cli = cac('nmh')

cli.option('-d, --dir <paths>', 'Target dir(s), comma separated or repeated; globs and ~ allowed')
cli.option('--delete [mode]', 'Delete found folders: hard | soft | trash (soft = trash; no value = pick interactively)')
cli.option('--dry-run', 'Preview what would be deleted — nothing is touched')
cli.option('-y, --yes', 'Answer yes to every prompt')
cli.option('-f, --force', 'Skip all confirmations (implies --yes)')
cli.option("--size <mode>", "'total' (just aggregate) or 'each' (default); numeric top-N is v0.2")
cli.option('--json', 'Machine-readable JSON output')
cli.option('-q, --quiet', 'Minimal output')
cli.option('--verbose', 'Debug chatter on stderr')
cli.option('--no-color', 'Disable ANSI colors')

interface NormalizedFlags {
  dirTargets: string[]
  deleteGiven: boolean
  deleteMode: DeleteMode | null
  dryRun: boolean
  assumeYes: boolean
  json: boolean
  sizeMode: 'each' | 'total'
}

const COMMAND_WORDS = new Set(['scan', 'clean', 'help', 'version'])

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

  configureLogger({
    verbose: flags.verbose === true,
    quiet: flags.quiet === true,
    noColor: flags.noColor === true || flags.color === false,
  })

  for (const future of detectFutureFlags(Object.keys(flags))) {
    warn(`${future} lands in a later version (v0.2+) — ignored for now`)
  }

  let sizeMode: 'each' | 'total' = 'each'
  if (typeof flags.size === 'string') {
    if (flags.size === 'total') sizeMode = 'total'
    else if (flags.size === 'each') sizeMode = 'each'
    else if (/^\d+$/.test(flags.size)) {
      warn('--size <n> (top-N list) comes with v0.2 — listing every folder for now')
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

  const cwd = process.cwd()
  const json = flags.json === true
  const dryRun = flags.dryRun === true
  const assumeYes = flags.yes === true || flags.force === true

  const subcommand = positionals[0] === undefined || looksLikePath(positionals[0]) ? null : positionals[0]
  const rest = subcommand ? positionals.slice(1) : positionals
  const dirTargets = splitTargets(flags.dir as string | string[] | undefined)
  const targets = [...rest, ...dirTargets]

  if (subcommand === 'version') {
    console.log(`${toolVersion()} (node ${process.version}, ${process.platform})`)
    return 0
  }

  if (subcommand === 'scan') {
    const outcome = await runScan({ targets, cwd, json, sizeMode })
    return outcome.code
  }

  if (subcommand === 'clean') {
    return runClean({ targets, cwd, mode: deleted.mode, dryRun, assumeYes, json })
  }

  if (deleted.given) {
    // `nmh --dir=… --delete=hard` with NO command is the one-liner (PRD §1) — targets default to cwd.
    return runDelete({ targets, cwd, mode: deleted.mode, dryRun, assumeYes, json })
  }

  if (positionals.length > 0 || dirTargets.length > 0) {
    // `nmh <path>` positional shortcut = scan (PRD §5.3)
    const outcome = await runScan({ targets, cwd, json, sizeMode })
    return outcome.code
  }

  // totally bare: wizard (TTY) / read-only scan (non-TTY, never hangs)
  return runWizard(cwd)
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code
  })
  .catch((err: unknown) => {
    errorLog(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
