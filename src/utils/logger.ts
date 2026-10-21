import pc from 'picocolors'

export interface LoggerOptions {
  verbose?: boolean
  quiet?: boolean
  noColor?: boolean
  isTTY?: boolean
}

interface LoggerState {
  verbose: boolean
  quiet: boolean
  noColor: boolean
  isTTY: boolean
}

let state: LoggerState = {
  verbose: false,
  quiet: false,
  noColor: false,
  isTTY: process.stdout.isTTY === true,
}

export function configureLogger(options: LoggerOptions): void {
  state = {
    verbose: options.verbose ?? state.verbose,
    quiet: options.quiet ?? state.quiet,
    noColor: options.noColor ?? state.noColor,
    isTTY: options.isTTY ?? state.isTTY,
  }
}

export function isSilent(): boolean {
  return state.quiet
}

export function isTTYOut(): boolean {
  return state.isTTY
}

export function isVerbose(): boolean {
  return state.verbose
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

/** Warning to stderr (keeps stdout clean for JSON/table). */
export function warn(message: string): void {
  if (!state.quiet) console.error(colors.yellow(`⚠ ${message}`))
}

/** Error to stderr — always visible, even with --quiet. */
export function errorLog(message: string): void {
  console.error(colors.red(message))
}

/** Debug detail to stderr. */
export function verboseLog(message: string): void {
  if (state.verbose && !state.quiet) console.error(colors.dim(`  · ${message}`))
}

const CLEAR_LINE = '\r\x1b[2K'

/** In-place progress line (TTY only, never in quiet mode). */
export function progressLine(message: string): void {
  if (state.quiet || !state.isTTY) return
  process.stdout.write(CLEAR_LINE + colors.dim(message))
}

/** Clear the in-place progress line. */
export function clearProgress(): void {
  if (state.quiet || !state.isTTY) return
  process.stdout.write(CLEAR_LINE)
}
