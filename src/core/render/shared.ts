import path from 'node:path'
import { homedir } from 'node:os'
import { colors } from '../../utils/logger.ts'
import { formatBytes } from '../../utils/format.ts'
import type { PMInfo, ScanTotals } from '../result.ts'

/** Absolute path → short display path: `~/…` for the home tree, `./…` for subpaths of cwd, middle-truncated. */
export function shortenPath(absolute: string, cwd: string, max = 56): string {
  let display = absolute
  const home = homedir()
  if (display === home) display = '~'
  else if (display.startsWith(home + path.sep)) display = '~' + display.slice(home.length)
  else if (display.startsWith(cwd + path.sep)) display = './' + display.slice(cwd.length + 1)
  else if (display === cwd) display = '.'

  const sep = display.includes('\\') ? '\\' : path.sep
  if (display.length > max) {
    const segments = display.split(sep)
    const tailMatters = segments.slice(-2).join(sep)
    const headStays = display.slice(0, Math.max(1, max - tailMatters.length - 1))
    display = `${headStays}${sep}…${sep}${tailMatters}`
  }
  return display
}

export function pmLabel(pm: PMInfo): string {
  if (pm.family === 'unknown') {
    const tag = pm.vp ? colors.magenta(' [vp]') : ''
    return (pm.multiple ? colors.yellow('[multiple]') : '—') + tag
  }
  const vpTag = pm.vp ? colors.magenta(' [vp]') : ''
  const multiTag = pm.multiple ? colors.yellow(' [multiple]') : ''
  return pm.family + vpTag + multiTag
}
const BAR_CELLS = 12

export function renderBar(size: number, max: number): string {
  if (max <= 0 || size <= 0) return colors.dim('·')
  const cells = Math.max(1, Math.round((size / max) * BAR_CELLS))
  return colors.cyan('█'.repeat(Math.min(cells, BAR_CELLS)))
}
export function totalsJson(totals: ScanTotals) {
  return {
    folders: totals.folders,
    packages: totals.packages,
    size: totals.size,
    sizeFormatted: formatBytes(totals.size),
  }
}
/** Signed delta for baseline compare: +before, −after, ± equal. */
export const signedBytes = (n: number): string => (n > 0 ? '+' : n < 0 ? '−' : '±') + formatBytes(Math.abs(n))
