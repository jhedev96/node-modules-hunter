import pc from 'picocolors'

export interface LoggerOptions {
  verbose?: boolean
  quiet?: boolean
  noColor?: boolean
  /** live progress line: auto = TTY only (default), on = forced, off = muted. */
  progress?: 'auto' | 'on' | 'off'
  isTTY?: boolean
}

interface LoggerState {
  verbose: boolean
  quiet: boolean
  noColor: boolean
  isTTY: boolean
  progress: 'auto' | 'on' | 'off'
}

let state: LoggerState = {
  verbose: false,
  quiet: false,
  noColor: false,
  isTTY: process.stdout.isTTY === true,
  progress: 'auto',
}

export function configureLogger(options: LoggerOptions): void {
  state = {
    verbose: options.verbose ?? state.verbose,
    quiet: options.quiet ?? state.quiet,
    noColor: options.noColor ?? state.noColor,
    isTTY: options.isTTY ?? state.isTTY,
    progress: options.progress ?? state.progress,
  }
}

export function isSilent(): boolean {
  return state.quiet
}

export function isTTYOut(): boolean {
  return state.isTTY
}

/** Whether ANSI paint is currently enabled — cli-table3 borders honor this (its own colorizer ignores ours). */
export function colorEnabled(): boolean {
  return !state.noColor
}

const raw = (text: string): string => text
type Paint = (text: string) => string

function pick(painted: Paint): Paint {
  return state.noColor ? raw : painted
}

export const colors = {
  get bold() {
    return pick((t) => pc.bold(t))
  },
  get dim() {
    return pick((t) => pc.dim(t))
  },
  get red() {
    return pick((t) => pc.red(t))
  },
  get yellow() {
    return pick((t) => pc.yellow(t))
  },
  get green() {
    return pick((t) => pc.green(t))
  },
  get cyan() {
    return pick((t) => pc.cyan(t))
  },
  get magenta() {
    return pick((t) => pc.magenta(t))
  },
}

/** Normal line to stdout. */
export function log(message: string): void {
  if (!state.quiet) console.log(message)
}

/** Machine payload to stdout — --quiet never mutes it: scripts that asked for
 *  --json depend on receiving the data even in minimal-output mode (v0.9 audit fix). */
export function payload(message: string): void {
  console.log(message)
}

/** Warning to stderr (keeps stdout clean for JSON/table). */
export function warn(message: string): void {
  if (!state.quiet) console.error(colors.yellow(`⚠ ${message}`))
}

/** Error to stderr — always visible, even with --quiet. */
export function errorLog(message: string): void {
  console.error(colors.red(message))
}

/** Side-channel info (e.g. "report saved") — stderr, skipped in quiet mode. */
export function note(message: string): void {
  if (!state.quiet) console.error(colors.cyan(`ℹ ${message}`))
}

/** Debug detail to stderr. */
export function verboseLog(message: string): void {
  if (state.verbose && !state.quiet) console.error(colors.dim(`  · ${message}`))
}

const CLEAR_LINE = '\r\x1b[2K'

/** Whether the in-place progress line may print under the current mode. */
function progressAllowed(): boolean {
  if (state.progress === 'off') return false
  if (state.progress === 'on') return true
  return state.isTTY // 'auto'
}

/** In-place progress line (per progress mode; never in quiet mode). */
export function progressLine(message: string): void {
  if (state.quiet || !progressAllowed()) return
  process.stdout.write(CLEAR_LINE + colors.dim(message))
}

/** Clear the in-place progress line. */
export function clearProgress(): void {
  if (state.quiet || !progressAllowed()) return
  process.stdout.write(CLEAR_LINE)
}
