import { colors } from './logger.ts'
import { toolVersion } from './version.ts'

/**
 * Terminal cell width, counting emoji as 2 cells (the common terminal behavior).
 * Applied to PLAIN text only — ANSI escape sequences must not run through this.
 */
function widthOf(plain: string): number {
  let cols = 0
  for (const ch of plain) {
    const code = ch.codePointAt(0) ?? 0
    // emoji + misc symbols/dingbats that terminals render double-width
    if ((code >= 0x1f300 && code <= 0x1faff) || (code >= 0x2700 && code <= 0x27bf) || code === 0x26a0) cols += 2
    else cols += 1
  }
  return cols
}

/**
 * The wizard banner (PRD §7.5 step 1, v0.7): a serious little box —
 * title on top, tagline under it, version right-aligned, dragon watching.
 * Hand-rolled instead of an art font: no new deps, honest glyph metrics.
 */
export function renderFullBanner(): string {
  const W = 46
  const border = (left: string, right: string): string => colors.magenta(`${left}${'─'.repeat(W)}${right}`)
  const row = (plainLeft: string, coloredLeft: string, plainRight: string, coloredRight: string): string => {
    const gap = Math.max(0, W - widthOf(plainLeft) - widthOf(plainRight) - 2)
    return `${colors.magenta('│')} ${coloredLeft}${' '.repeat(gap)}${coloredRight} ${colors.magenta('│')}`
  }
  const version = `v${toolVersion()}`
  return [
    border('╭', '╮'),
    row('🐉 nmh · node_modules hunter', `🐉 ${colors.bold('nmh')} · node_modules hunter`, version, colors.dim(version)),
    row('scan · measure · clean — safety rails on', colors.dim('scan · measure · clean — safety rails on'), '', ''),
    border('╰', '╯'),
  ].join('\n')
}

/** One quiet line for non-TTY runs — visible context, zero box-drawing noise in pipes. */
export function renderCompactBanner(): string {
  return `${colors.magenta('🐉')} ${colors.bold('node-modules-hunter')} v${toolVersion()} — read-only scan`
}
