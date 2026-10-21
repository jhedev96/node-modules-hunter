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

export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
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
