/**
 * Treemap export (PRD §8.6 #1): single-file interactive HTML, vanilla JS, no deps.
 * Level 1 = each node_modules entry, level 2 = its top-level packages, sized via the
 * squarified treemap layout (Bruls et al.). Hover shows path+size; the data itself
 * is embedded as JSON — the file stays self-contained (no external fetches ever).
 */

export interface TreemapPackage {
  name: string
  version: string | null
  /** Bytes for real dirs; null for symlinks / unmeasured. */
  size: number | null
  symlinked: boolean
}

export interface TreemapEntry {
  /** Project manifest name when found, else the display path. */
  label: string
  displayPath: string
  pm: string
  size: number
  packages: TreemapPackage[]
}

export interface TreemapData {
  generatedAt: string
  cwd: string
  totalSize: number
  entries: TreemapEntry[]
}

export interface TreemapRect {
  x: number
  y: number
  w: number
  h: number
  label: string
}

/** A padded inset of a parent rect (keeps child grids from touching borders). */
function inset(rect: { x: number; y: number; w: number; h: number }, pad: number): { x: number; y: number; w: number; h: number } {
  return { x: rect.x + pad, y: rect.y + pad, w: Math.max(0, rect.w - pad * 2), h: Math.max(0, rect.h - pad * 2) }
}

/** worst aspect ratio of cells in a row of fixed thickness. */
function worstAspect(cells: number[], rowThickness: number): number {
  if (rowThickness <= 0 || cells.length === 0) return Infinity
  let worst = 0
  for (const cellArea of cells) {
    const along = cellArea / rowThickness
    worst = Math.max(worst, along / rowThickness, rowThickness / along)
  }
  return worst
}

/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk) into (x, y, w, h).
 * Deterministic: stable order on ties. Zero-weight cells still get tiny slivers.
 * Every rect carries `item` — the original input object (with any extra fields).
 */
export function squarify<T extends { label: string; weight: number }>(
  sized: T[],
  x: number,
  y: number,
  w: number,
  h: number,
): Array<TreemapRect & { weight: number; item: T }> {
  const rects: Array<TreemapRect & { weight: number; item: T }> = []
  const go = (items: T[], bx: number, by: number, bw: number, bh: number): void => {
    if (items.length === 0 || bw <= 0.05 || bh <= 0.05) return
    const total = items.reduce((sum, item) => sum + item.weight, 0)
    const boxArea = bw * bh
    const scaled = items
      .map((item) => ({ item, cellArea: (item.weight / (total || 1)) * boxArea }))
      .sort((a, b) => b.cellArea - a.cellArea || a.item.label.localeCompare(b.item.label))

    // build the first row along the shorter edge: keep growing while the worst
    // aspect ratio does not get worse
    const shortSide = Math.min(bw, bh)
    const row: Array<{ item: (typeof scaled)[number]['item']; cellArea: number }> = [scaled[0]]
    let idx = 1
    let rowArea = scaled[0].cellArea
    while (idx < scaled.length) {
      const candidate = scaled[idx]
      const nextRow = [...row, candidate]
      const nextArea = rowArea + candidate.cellArea
      const currentWorst = worstAspect(row.map((slot) => slot.cellArea), rowArea / (shortSide || 1))
      const nextWorst = worstAspect(nextRow.map((slot) => slot.cellArea), nextArea / (shortSide || 1))
      if (nextWorst > currentWorst) break
      row.push(candidate)
      rowArea = nextArea
      idx += 1
    }

    const rowThickness = rowArea / (shortSide || 1)
    let offset = 0
    let placed = 0
    for (const slot of row) {
      const along = slot.cellArea / (rowThickness || 1)
      if (bw >= bh) {
        rects.push({ x: bx, y: by + offset, w: rowThickness, h: along, label: slot.item.label, weight: slot.item.weight, item: slot.item })
      } else {
        rects.push({ x: bx + offset, y: by, w: along, h: rowThickness, label: slot.item.label, weight: slot.item.weight, item: slot.item })
      }
      placed += 1
      offset += along
    }

    // recurse into the leftover box with the remaining items — even a 0.5px
    // sliver stays alive so no item is silently dropped from the map
    const rest = scaled.slice(placed).map((slot) => slot.item)
    if (rest.length > 0) {
      const advance = Math.min(rowThickness, bw)
      if (bw >= bh) {
        go(rest, bx + advance, by, Math.max(0.5, bw - advance), bh)
      } else {
        go(rest, bx, by + advance, bw, Math.max(0.5, bh - advance))
      }
    }
  }
  go(sized, x, y, w, h)
  return rects.map((rect) => ({
    ...rect,
    x: Math.min(rect.x, x + w),
    y: Math.min(rect.y, y + h),
    w: Math.max(0, Math.min(rect.w, x + w - rect.x)),
    h: Math.max(0, Math.min(rect.h, y + h - rect.y)),
  }))
}

export interface TreemapLayout {
  entryRects: Array<TreemapRect & { weight: number; item: { label: string; weight: number; index: number } }>
  pkgRects: Array<
    TreemapRect & {
      weight: number
      item: { label: string; weight: number; pkgIndex: number }
      entryIndex: number
      pkgIndex: number
      size: number | null
      symlinked: boolean
    }
  >
}

/** Full two-level layout: entries first, then each entry's packages in its inner rect. */
export function buildTreemapLayout(data: TreemapData, width = 1280, height = 720): TreemapLayout {
  const entryRects = squarify(
    data.entries.map((entry, index) => ({ label: entry.label, weight: Math.max(entry.size, 1), index })),
    0,
    0,
    width,
    height,
  )
  const pkgRects: TreemapLayout['pkgRects'] = []
  entryRects.forEach((rect) => {
    const entry = data.entries[rect.item.index]
    const usable = inset(rect, 16)
    const cells = squarify(
      entry.packages.map((pkg, pkgIndex) => ({
        label: `${pkg.name}${pkg.version ? `@${pkg.version}` : ''}${pkg.symlinked ? ' ⟶link' : ''}`,
        weight: pkg.symlinked || pkg.size === null ? 0.6 : Math.max(pkg.size, 1),
        pkgIndex,
      })),
      usable.x,
      usable.y,
      usable.w,
      usable.h,
    )
    for (const cell of cells) {
      const pkg = entry.packages[cell.item.pkgIndex]
      pkgRects.push({ ...cell, entryIndex: rect.item.index, pkgIndex: cell.item.pkgIndex, size: pkg.size, symlinked: pkg.symlinked })
    }
  })
  return { entryRects, pkgRects }
}

const PALETTE = [
  '#4f78d9', '#48b1a3', '#a3a84b', '#a34b8c', '#4ba3a3', '#6e6ea8', '#a86e4b', '#4ba34b',
  '#8c4b4b', '#4b6ea8', '#a84b6e', '#5aa0c8', '#c8a25a', '#7a9e4b', '#9490c8', '#c85a5a',
]

function colorFor(name: string): string {
  let hash = 0
  for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) >>> 0
  return PALETTE[hash % PALETTE.length]
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fmt(bytes: number | null): string {
  // fmt is treemap-local on purpose: GB at 2 decimals keeps the dense HTML overlay labels
  // readable — do NOT fold into the shared formatBytes (1 decimal everywhere).
  if (bytes === null) return '(link)'
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** Self-contained HTML (no external refs): embedded data + vanilla hover tooltip. */
export function renderTreemapHtml(data: TreemapData, width = 1280, height = 720): string {
  const { entryRects, pkgRects } = buildTreemapLayout(data, width, height)
  const rects: string[] = []
  for (const rect of entryRects) {
    rects.push(
      `<rect x="${rect.x.toFixed(1)}" y="${rect.y.toFixed(1)}" width="${rect.w.toFixed(1)}" height="${rect.h.toFixed(1)}" fill="none" stroke="#4fc1ff" stroke-width="2"/><text x="${(rect.x + 6).toFixed(1)}" y="${(rect.y + 14).toFixed(1)}" fill="#eaeef4" font-size="12" font-family="ui-monospace,monospace">${esc(rect.label)} · ${esc(fmt(data.entries[rect.item.index].size))}</text>`,
    )
  }
  for (const rect of pkgRects) {
    const entry = data.entries[rect.entryIndex]
    const pkg = entry.packages[rect.pkgIndex]
    const tip = `${entry.displayPath}/${pkg.name}${pkg.version ? `@${pkg.version}` : ''} — ${fmt(pkg.size)}${pkg.symlinked ? ' (symlink)' : ''}`
    const fill = rect.symlinked ? '#8a8f98' : colorFor(pkg.name)
    rects.push(
      `<rect class="cell" x="${rect.x.toFixed(1)}" y="${rect.y.toFixed(1)}" width="${rect.w.toFixed(1)}" height="${rect.h.toFixed(1)}" fill="${fill}" fill-opacity="${rect.symlinked ? '0.35' : '0.85'}" ${rect.symlinked ? 'stroke-dasharray="3 2" stroke="#8a8f98" stroke-width="1"' : ''} data-tip="${esc(tip)}"/>`,
    )
  }
  const entriesLine = esc(fmt(data.totalSize))
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nmh treemap — ${entriesLine}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b0e14; color: #eaeef4; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { padding: 10px 14px; font-size: 13px; color: #9aa4b2; }
  svg { display: block; width: 100%; height: calc(100vh - 46px); }
  .cell:hover { stroke: #4fc1ff; stroke-width: 2; }
  .cell { cursor: zoom-in; }
  #tip { display: none; position: fixed; z-index: 9; background: #161b22; border: 1px solid #30363d; padding: 6px 9px; font-size: 12px; pointer-events: none; max-width: 60vw; }
</style>
</head>
<body>
<header>nmh treemap — ${entriesLine} — ${data.entries.length} node_modules — hover buat detail disk, generated ${esc(data.generatedAt)}</header>
<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="treemap ukuran node_modules">
${rects.join('\n')}
</svg>
<div id="tip"></div>
<script>
const tip = document.getElementById('tip')
for (const cell of document.querySelectorAll('.cell')) {
  cell.addEventListener('mousemove', (event) => {
    tip.textContent = cell.getAttribute('data-tip')
    tip.style.display = 'block'
    tip.style.left = Math.min(event.clientX + 12, window.innerWidth - tip.offsetWidth - 8) + 'px'
    tip.style.top = Math.min(event.clientY + 14, window.innerHeight - tip.offsetHeight - 8) + 'px'
  })
  cell.addEventListener('mouseleave', () => {
    tip.style.display = 'none'
  })
}
</script>
</body>
</html>
`
}
