/** Format a byte count as a human string — 1024-based, one decimal (PRD §11). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'] as const
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

/** Compact relative time for table output: now / 5m ago / 2h ago / 3d ago / 7mo ago / 2y ago. */
export function formatAge(mtimeMs: number | null, now = Date.now()): string {
  if (mtimeMs == null) return '—'
  const diff = Math.max(0, now - mtimeMs)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return 'now'
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`
  if (diff < day) return `${Math.floor(diff / hour)}h ago`
  const days = Math.floor(diff / day)
  if (days < 60) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 24) return `${months}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g

/** Strip ANSI escapes (and stray carriage returns) for file-based report copies. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '').replace(/\r/g, '')
}

/** Human CO2 mass: kg at ≥1 kg, otherwise grams with enough decimals to stay honest. */
export function formatCo2(grams: number): string {
  if (Math.abs(grams) >= 1000) return `${(grams / 1000).toFixed(2)} kg CO2e`
  if (Math.abs(grams) >= 10) return `${grams.toFixed(1)} g CO2e`
  if (Math.abs(grams) >= 0.1) return `${grams.toFixed(2)} g CO2e`
  return `${grams.toFixed(3)} g CO2e`
}

/** Durations: sub-minute keeps one decimal, then m/h. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  if (minutes < 60) return `${minutes}m ${rest}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
