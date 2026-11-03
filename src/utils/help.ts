import { colors } from './logger.ts'

/**
 * Own help renderer (v1.1.1). `cac`'s builtin output lists only the global flags
 * table — every command (scan/clean/search/map/stats/why/treemap/config/update…)
 * is dispatched manually from positionals, so it never appeared in `nmh help`.
 * This module owns the full map: commands, one-liner flag actions, and every
 * option grouped by family, so `nmh help` / `--help` shows what nmh can do.
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

const COMMANDS: HelpCommand[] = [
  { usage: 'nmh', desc: 'interactive wizard: arrow menu (delete all / pick / search / map / report / settings)' },
  { usage: 'nmh <path> [path…]', desc: 'shortcut: scan given path(s); one-liner actions via flags (--delete, --search, …)' },
  { usage: 'nmh scan [dir]', desc: 'full scan across targets (default: cwd)' },
  { usage: 'nmh clean [dir]', desc: 'scan + delete everything safe (trash by default)' },
  { usage: 'nmh search <pattern> [dir…]', desc: 'find installed packages by name (+ versions & sizes) — read-only' },
  { usage: 'nmh map [dir]', desc: 'project → PM → size → top packages → declared deps — read-only' },
  { usage: 'nmh stats [dir]', desc: 'size analytics: dup factor, waste, top-N, per-package tree (aliases: analyze, info)' },
  { usage: 'nmh why <pkg> [dir…]', desc: 'reverse depend: where is <pkg> and who requires it — read-only' },
  { usage: 'nmh treemap [dir]', desc: 'single-file interactive HTML treemap → nmh-treemap.html' },
  { usage: 'nmh stats -g', desc: 'global installs across npm/pnpm/yarn/bun — read-only' },
  { usage: 'nmh config <op>', desc: 'manage .nmhrc from the CLI: info · set · add · remove · unset' },
  { usage: 'nmh update', desc: 'self-update: compare installed vs npm latest, install if global' },
  { usage: 'nmh version', desc: 'banner: tool version, node+abi, OS/arch/kernel, tty (alias: -v / --version)' },
  { usage: 'nmh help', desc: 'this help (alias: -h / --help)' },
]

const STAT_SUBCOMMANDS: HelpCommand[] = [
  { usage: 'stats --by type [dir]', desc: 'breakdown per dependency field (dep/dev/optional/peer/transitive)' },
  { usage: 'stats --licenses [dir]', desc: 'license buckets (+ ⚠ copyleft inside production deps)' },
  { usage: 'stats --score / --co2', desc: 'experimental: composite bloat score 0-100 / rough CO2 estimate' },
  { usage: 'stats --graph [dir]', desc: 'dependency graph from the lockfile — npm/yarn/pnpm/bun, no extra deps' },
  { usage: 'stats --reinstall [dir]', desc: 'naive npm-ci-style "how long would reinstalling everything take"' },
]

const GROUPS: HelpGroup[] = [
  {
    title: 'Actions',
    flags: [
      { usage: '--delete [mode]', desc: 'delete found folders: hard | trash (soft alias) — no value = pick interactively' },
      { usage: '--trash system|nmh', desc: 'v1.1: whose trash takes victims — system backend (default) or restorable ~/.nmh/trash' },
      { usage: '--dry-run', desc: 'preview what would be deleted — nothing is touched' },
      { usage: '-y, --yes', desc: 'answer yes to every prompt (required for non-TTY deletes)' },
      { usage: '-f, --force', desc: 'skip all confirmations (implies --yes)' },
      { usage: '--search <pattern>', desc: 'search installed packages (substring, glob, or /regex/) — read-only' },
      { usage: '-m, --map', desc: 'map projects: PM, size, top packages, declared deps — read-only' },
      { usage: '--depend [pkg]', desc: 'map only: show declared deps; with a value, list who declares it' },
      { usage: '--tree', desc: 'map/stats only: list per-project packages (tree view, with sizes)' },
      { usage: '--why <pkg>', desc: 'read-only: explain an installed package — instances and requirers' },
      { usage: '--stats', desc: 'stats report: overview + dup factor + waste + top sizes — read-only' },
      { usage: '--treemap [file]', desc: 'treemap export: single-file HTML (default nmh-treemap.html; --out is an alias)' },
      { usage: '-d, --dir <paths>', desc: 'target dir(s), comma separated or repeated; globs and ~ allowed' },
      { usage: '--size <mode>', desc: "output shape: 'total' (just aggregate) or 'each' (default: per-folder table)" },
      { usage: '--save-report <file>', desc: 'also write the printed report to a file (.json/.md/.txt; --report <file> aliases it)' },
      { usage: '--update-check', desc: 'peek npm for a newer release (non-blocking, 24 h cache; also settable in .nmhrc)' },
    ],
  },
  {
    title: 'Stale hunting & output shape (v1.1)',
    flags: [
      { usage: '--stale <days>', desc: 'keep only projects idle >= <days>; ladder = git commit → manifest → folder mtime; no evidence = dropped' },
      { usage: '--fast-size', desc: 'measure with one `du -sk` per entry (KiB granularity) instead of walking every file' },
      { usage: '--sort <key>', desc: 'order results: size (default, desc) | path | idle (oldest project first) | mtime (newest first)' },
      { usage: '--no-skip', desc: 'stop hiding system noise (.Trash*, Library/, *.app) during discovery — default: hidden' },
      { usage: '--animate / --no-animate', desc: 'live size counter while measuring: auto = real TTY only' },
      { usage: '--json', desc: 'machine-readable payload (pipe into jq); additive-only keys — v1.0 keys stay frozen' },
      { usage: '-q, --quiet', desc: 'minimal output — pretty tables/notes mute, the --json payload still prints' },
      { usage: '--verbose', desc: 'debug chatter on stderr' },
      { usage: '--no-color', desc: 'disable ANSI colors (auto: colors only on a real TTY or with --color / FORCE_COLOR)' },
      { usage: '--color', desc: 'force ANSI colors even on a piped run (wins over a config color:false)' },
    ],
  },
  {
    title: 'Scoping & filters',
    flags: [
      { usage: '-r, --recursive', desc: 'also look INSIDE found node_modules (nested audit; totals stay top-level only)' },
      { usage: '--pm [family]', desc: 'filter by detected PM: npm|pnpm|yarn|bun|vp — no value lists what was detected' },
      { usage: '--exclude <globs>', desc: 'exclude paths from results (comma list of globs, e.g. **/e2e/**)' },
      { usage: '--keep <pkgs>', desc: 'refuse to delete node_modules of these projects (comma list, glob ok; "self" works)' },
      { usage: '--depth <n>', desc: 'max scan depth in levels below the target' },
      { usage: '--expand', desc: 'full absolute paths + extra detail in output' },
    ],
  },
  {
    title: 'Stats suite',
    flags: [
      { usage: '--top <n>', desc: 'rows in the focused size list (default 10)' },
      { usage: '--by <mode>', desc: "breakdown mode — 'size' (alias: package), 'type', 'licenses'" },
      { usage: '-g, --global', desc: 'analyze global installs (per-PM prefix scan; read-only)' },
      { usage: '--config <file>', desc: 'use this config file instead of the .nmhrc lookup (cwd → home)' },
      { usage: '--save-baseline <name>', desc: 'save a metadata snapshot of this run to ~/.nmh/baselines/<name>.json' },
      { usage: '--compare <name>', desc: 'diff this run against a stored baseline (totals, per-folder, package movers)' },
      { usage: '--history', desc: 'list stored baselines — no scan at all' },
      { usage: '--phantom', desc: 'stats only: imports found in sources but declared nowhere (best-effort regex audit)' },
      { usage: '--dead', desc: 'stats only: installed + declared but never imported (best-effort regex audit)' },
      { usage: '--licenses', desc: 'stats only: bucket instances by license field; flags copyleft in production deps' },
      { usage: '--score', desc: 'stats only: experimental composite bloat score 0-100' },
      { usage: '--co2', desc: 'stats only: experimental carbon estimate (storage-year + one redownload)' },
      { usage: '--online', desc: 'stats only: deprecated scan — offline manifests + lazy cached registry fallback' },
      { usage: '--graph', desc: 'stats only: dependency graph from the lockfile (npm/yarn/pnpm/bun) with BFS depth' },
      { usage: '--reinstall', desc: 'stats only: naive npm-ci-style estimate of the time to reinstall everything' },
      { usage: '--out <file>', desc: 'treemap only: where to write the HTML file (same as --treemap <file>)' },
    ],
  },
  {
    title: 'Config family',
    flags: [
      { usage: '--default-exclude <globs>', desc: 'manage the persisted exclude list (comma list; special value "self")' },
      { usage: '--default-keep <pkgs>', desc: 'manage the persisted keep list (comma list; special value "self")' },
      { usage: '--default-mode <mode>', desc: 'set the persisted delete default (hard | soft | trash)' },
      { usage: '--log-dir <dir>', desc: 'set the persisted recovery-log directory (logDir)' },
    ],
  },
]

const EXAMPLES = [
  ['nmh', 'wizard; the no-args menu auto-climbs to the nearest project root'],
  ['nmh --dir=./proj,~/code/*/node_modules', 'multi-target scan'],
  ['nmh . --stale 90 --delete=trash -y', 'bury the stale boneyard, restorable trash'],
  ['nmh why react --expand', 'reverse-depend: who declares + who requires'],
  ['nmh stats --by type --json', 'dep-field breakdown as a machine payload'],
  ['nmh stats -g --top 20', 'the 20 biggest global installs across PMs'],
  ['nmh config set default-mode trash', 'persist a default delete mode in .nmhrc'],
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
  lines.push(colors.bold('nmh') + colors.dim(' — hunt bloated node_modules folders: scan, measure, clean safely (npm/pnpm/yarn/bun)'))
  lines.push('')
  lines.push(colors.bold('Usage'))
  lines.push(`  ${colors.cyan('nmh <command|targets> [options]')}`)
  lines.push('')
  lines.push(...renderSection('Commands', COMMANDS, commandWidth(COMMANDS)))
  lines.push('')
  lines.push(...renderSection('Stats subcommands', STAT_SUBCOMMANDS, Math.max(commandWidth(STAT_SUBCOMMANDS), commandWidth(COMMANDS))))
  lines.push('')
  const width = flagWidth(GROUPS)
  for (const group of GROUPS) {
    lines.push(...renderSection(`Options — ${group.title}`, group.flags, width))
    lines.push('')
  }
  lines.push(colors.bold('Examples'))
  for (const [cmd, note] of EXAMPLES) {
    lines.push(`  ${colors.cyan(cmd.padEnd(40))}${colors.dim(note)}`)
  }
  lines.push('')
  lines.push(colors.dim('Safety first: guards refuse dangerous targets (exit 3), deletes confirm unless --yes/--force, symlinks never get followed.'))
  lines.push(colors.dim('Exit codes: 0 ok · 1 usage error · 2 nothing found · 3 guard refused · 4 permission denied.'))
  lines.push(colors.dim('Everything is documented in depth at: https://github.com/jhedev96/node-modules-hunter'))
  return lines.join('\n') + '\n'
}

/** Render the full help to stdout (used by `nmh help` and `--help`). */
export function printHelp(): void {
  process.stdout.write(renderHelp())
}
