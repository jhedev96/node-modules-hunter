import { colors } from './logger.ts'
import { t } from '../i18n/index.ts'

/**
 * Own help renderer (v1.1.1, i18n v1.3.0). `cac`'s builtin output lists only the
 * global flags table — every command (scan/clean/search/map/stats/why/treemap/
 * config/update…) is dispatched manually from positionals, so it never appeared
 * in `nmh help`. This module owns the full map: commands, one-liner flag actions,
 * and every option grouped by family. Usage strings are CLI grammar and stay
 * untranslated; every description/title/footer goes through the catalog.
 */

export interface HelpCommand {
  usage: string
  desc: string
}

export interface HelpFlag {
  usage: string
  desc: string
}

export interface HelpGroup {
  title: string
  flags: HelpFlag[]
}

/** Built per-call: the locale resolves at run time, not at import time. */
const COMMANDS = (): HelpCommand[] => [
  { usage: 'nmh', desc: t('help.cmd.bare') },
  { usage: 'nmh <path> [path…]', desc: t('help.cmd.paths') },
  { usage: 'nmh wizard [--dir …]', desc: t('help.cmd.wizard') },
  { usage: 'nmh scan [dir]', desc: t('help.cmd.scan') },
  { usage: 'nmh clean [dir]', desc: t('help.cmd.clean') },
  { usage: 'nmh search <pattern> [dir…]', desc: t('help.cmd.search') },
  { usage: 'nmh map [dir]', desc: t('help.cmd.map') },
  { usage: 'nmh stats [dir]', desc: t('help.cmd.stats') },
  { usage: 'nmh why <pkg> [dir…]', desc: t('help.cmd.why') },
  { usage: 'nmh treemap [dir]', desc: t('help.cmd.treemap') },
  { usage: 'nmh stats -g', desc: t('help.cmd.global') },
  { usage: 'nmh config <op>', desc: t('help.cmd.config') },
  { usage: 'nmh update', desc: t('help.cmd.update') },
  { usage: 'nmh version', desc: t('help.cmd.version') },
  { usage: 'nmh help', desc: t('help.cmd.help') },
]

const STAT_SUBCOMMANDS = (): HelpCommand[] => [
  { usage: 'stats --by type [dir]', desc: t('help.statsSub.byType') },
  { usage: 'stats --licenses [dir]', desc: t('help.statsSub.licenses') },
  { usage: 'stats --score / --co2', desc: t('help.statsSub.score') },
  { usage: 'stats --graph [dir]', desc: t('help.statsSub.graph') },
  { usage: 'stats --reinstall [dir]', desc: t('help.statsSub.reinstall') },
]

const GROUPS = (): HelpGroup[] => [
  {
    title: t('help.group.actions'),
    flags: [
      { usage: '--delete [mode]', desc: t('help.flag.delete') },
      { usage: '--trash system|nmh', desc: t('help.flag.trash') },
      { usage: '--dry-run', desc: t('help.flag.dryRun') },
      { usage: '-y, --yes', desc: t('help.flag.yes') },
      { usage: '-f, --force', desc: t('help.flag.force') },
      { usage: '--search <pattern>', desc: t('help.flag.search') },
      { usage: '-m, --map', desc: t('help.flag.map') },
      { usage: '--depend [pkg]', desc: t('help.flag.depend') },
      { usage: '--tree', desc: t('help.flag.tree') },
      { usage: '--why <pkg>', desc: t('help.flag.why') },
      { usage: '--stats', desc: t('help.flag.stats') },
      { usage: '--treemap [file]', desc: t('help.flag.treemap') },
      { usage: '-d, --dir <paths>', desc: t('help.flag.dir') },
      { usage: '--size <mode>', desc: t('help.flag.size') },
      { usage: '--save-report <file>', desc: t('help.flag.saveReport') },
      { usage: '--wizard', desc: t('help.flag.wizard') },
      { usage: 'update: --check · --info · -y · -n · -f', desc: t('help.flag.updateFamily') },
      { usage: '--update-check', desc: t('help.flag.updateCheck') },
    ],
  },
  {
    title: t('help.group.stale'),
    flags: [
      { usage: '--stale <days>', desc: t('help.flag.stale') },
      { usage: '--fast-size', desc: t('help.flag.fastSize') },
      { usage: '--sort <key>', desc: t('help.flag.sort') },
      { usage: '--no-skip', desc: t('help.flag.noSkip') },
      { usage: '--animate / --no-animate', desc: t('help.flag.animate') },
      { usage: '--json', desc: t('help.flag.json') },
      { usage: '-q, --quiet', desc: t('help.flag.quiet') },
      { usage: '--verbose', desc: t('help.flag.verbose') },
      { usage: '--no-color', desc: t('help.flag.noColor') },
      { usage: '--color', desc: t('help.flag.color') },
    ],
  },
  {
    title: t('help.group.scoping'),
    flags: [
      { usage: '-r, --recursive', desc: t('help.flag.recursive') },
      { usage: '--pm [family]', desc: t('help.flag.pm') },
      { usage: '--exclude <globs>', desc: t('help.flag.exclude') },
      { usage: '--keep <pkgs>', desc: t('help.flag.keep') },
      { usage: '--depth <n>', desc: t('help.flag.depth') },
      { usage: '--expand', desc: t('help.flag.expand') },
    ],
  },
  {
    title: t('help.group.stats'),
    flags: [
      { usage: '--top <n>', desc: t('help.flag.top') },
      { usage: '--by <mode>', desc: t('help.flag.by') },
      { usage: '-g, --global', desc: t('help.flag.global') },
      { usage: '--config <file>', desc: t('help.flag.config') },
      { usage: '--save-baseline <name>', desc: t('help.flag.saveBaseline') },
      { usage: '--compare <name>', desc: t('help.flag.compare') },
      { usage: '--history', desc: t('help.flag.history') },
      { usage: '--phantom', desc: t('help.flag.phantom') },
      { usage: '--dead', desc: t('help.flag.dead') },
      { usage: '--licenses', desc: t('help.flag.licenses') },
      { usage: '--score', desc: t('help.flag.score') },
      { usage: '--co2', desc: t('help.flag.co2') },
      { usage: '--online', desc: t('help.flag.online') },
      { usage: '--graph', desc: t('help.flag.graph') },
      { usage: '--reinstall', desc: t('help.flag.reinstall') },
      { usage: '--out <file>', desc: t('help.flag.out') },
    ],
  },
  {
    title: t('help.group.config'),
    flags: [
      { usage: '--default-exclude <globs>', desc: t('help.flag.defaultExclude') },
      { usage: '--default-keep <pkgs>', desc: t('help.flag.defaultKeep') },
      { usage: '--default-mode <mode>', desc: t('help.flag.defaultMode') },
      { usage: '--log-dir <dir>', desc: t('help.flag.logDir') },
    ],
  },
]

const EXAMPLES = (): Array<[string, string]> => [
  ['nmh', t('help.ex.bare')],
  ['nmh wizard --dir=./repo1,./repo2', t('help.ex.wizardDir')],
  ['nmh wizard -- stats --dir=./repo1', t('help.ex.wizardRouter')],
  ['nmh --dir=./proj,~/code/*/node_modules', t('help.ex.multiTarget')],
  ['nmh . --stale 90 --delete=trash -y', t('help.ex.stale')],
  ['nmh why react --expand', t('help.ex.why')],
  ['nmh stats --by type --json', t('help.ex.byType')],
  ['nmh stats -g --top 20', t('help.ex.globalTop')],
  ['nmh update --check', t('help.ex.updateCheck')],
  ['nmh config set default-mode trash', t('help.ex.configSet')],
]

const flagWidth = (groups: HelpGroup[]): number => {
  let width = 0
  for (const group of groups) for (const item of group.flags) width = Math.max(width, item.usage.length)
  return width
}

const commandWidth = (items: HelpCommand[]): number => {
  let width = 0
  for (const item of items) width = Math.max(width, item.usage.length)
  return width
}

function renderSection(title: string, items: Array<{ usage: string; desc: string }>, width: number): string[] {
  const lines: string[] = [colors.bold(title)]
  for (const item of items) {
    lines.push(colors.cyan(item.usage.padEnd(width + 2)) + colors.dim(item.desc))
  }
  return lines
}

/** Full help text: usage synopsis, commands, one-liner flag actions, every option, examples. */
export function renderHelp(): string {
  const lines: string[] = []
  lines.push(colors.bold('nmh') + colors.dim(` — ${t('help.tagline')}`))
  lines.push('')
  lines.push(colors.bold(t('help.usage.title')))
  lines.push(`  ${colors.cyan(t('help.usage.line'))}`)
  lines.push('')
  lines.push(...renderSection(t('help.commands.title'), COMMANDS(), commandWidth(COMMANDS())))
  lines.push('')
  lines.push(...renderSection(t('help.statsSub.title'), STAT_SUBCOMMANDS(), Math.max(commandWidth(STAT_SUBCOMMANDS()), commandWidth(COMMANDS()))))
  lines.push('')
  const width = flagWidth(GROUPS())
  for (const group of GROUPS()) {
    lines.push(...renderSection(t('help.options.title', { group: group.title }), group.flags, width))
    lines.push('')
  }
  lines.push(colors.bold(t('help.examples.title')))
  for (const [cmd, note] of EXAMPLES()) {
    lines.push(`  ${colors.cyan(cmd.padEnd(40))}${colors.dim(note)}`)
  }
  lines.push('')
  lines.push(colors.dim(t('help.footer.safety')))
  lines.push(colors.dim(t('help.footer.exitCodes')))
  lines.push(colors.dim(t('help.footer.docs')))
  return lines.join('\n') + '\n'
}

/** Render the full help to stdout (used by `nmh help` and `--help`). */
export function printHelp(): void {
  process.stdout.write(renderHelp())
}
