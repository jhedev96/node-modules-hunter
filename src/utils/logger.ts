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

// ── time-driven spinner ─────────────────────────────────────────────────────
// A loader must rotate on its own clock (70 ms/braille step), not on scan
// progress — a frozen percentage must NOT look like a hung scan. When the
// rotation is muted (non-TTY with `--animate on`), the last-known message
// still paints once per update, like the old static line.
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPIN_MS = 70

let spinTimer: NodeJS.Timeout | null = null
let spinFrame = 0
let spinMsg = ''

function spinPaint(): void {
  process.stdout.write(CLEAR_LINE + colors.dim(`${SPIN_FRAMES[spinFrame]} ${spinMsg}`))
}

function startSpin(): void {
  spinFrame = 0
  spinPaint()
  const timer = setInterval(() => {
    spinFrame = (spinFrame + 1) % SPIN_FRAMES.length
    spinPaint()
  }, SPIN_MS)
  spinTimer = timer
  if (typeof timer.unref === 'function') timer.unref() // never hold the process open
}

/** Rotating loader: first call spins up the clock, later calls refresh the label. */
export function spinUpdate(message: string): void {
  spinMsg = message
  if (state.quiet || !progressAllowed() || spinTimer !== null) return
  if (!state.isTTY) {
    // forced pipe mode: no timer flood — one paint per update, like a static line
    spinPaint()
    return
  }
  startSpin()
}

/** Stop the rotation and clear the in-place line. */
export function spinClear(): void {
  if (spinTimer !== null) {
    clearInterval(spinTimer)
    spinTimer = null
  }
  if (state.quiet || !progressAllowed()) return
  process.stdout.write(CLEAR_LINE)
}
