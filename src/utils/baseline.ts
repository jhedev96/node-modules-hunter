import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { toolVersion } from './version.ts'
import { warn, verboseLog } from './logger.ts'
import type { StatsOutcome } from '../core/result.ts'

/** Metadata snapshot for a project tree (PRD §8.3 baseline & compare). */
export interface BaselineSnapshot {
  schema: 1
  /** Tool version that produced the snapshot. */
  tool: string
  /** ISO timestamp when saved. */
  createdAt: string
  /** Working dir the snapshot was taken from (informational, matches history marking). */
  cwd: string
  totals: { size: number; folders: number; packages: number }
  entries: BaselineEntrySnapshot[]
}

export interface BaselineEntrySnapshot {
  /** node_modules path relative to the snapshot cwd, forward-slash normalized. */
  rel: string
  size: number
  packages: number
  pm: string
  /** Per-package instances (name → copies summed for compare). */
  instances: Array<{ name: string; version: string | null; symlinked: boolean; size: number | null }>
}

export interface BaselineListItem {
  name: string
  createdAt: string
  cwd: string
  totals: BaselineSnapshot['totals']
}

export interface BaselineDelta {
  rel: string
  kind: 'grew' | 'shrank' | 'new' | 'gone' | 'same'
  before: number | null
  after: number | null
  delta: number
}

export interface PackageMover {
  name: string
  before: number
  after: number
  delta: number
}

export interface BaselineComparison {
  baselineName: string
  baselineCreatedAt: string
  totalBefore: number
  totalAfter: number
  totalDelta: number
  totalDeltaPercent: number | null
  packagesDelta: number
  /** Changed entries (new/gone/grew/shrank), |delta| desc. */
  deltas: BaselineDelta[]
  /** Same-name package size sums, biggest movers by |delta| desc. */
  packageMovers: PackageMover[]
}

/** Baseline names: safe single-segment file stem only — no traversal, no funny names. */
export function validateBaselineName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
}

function baselinesDir(): string {
  return path.join(homedir(), '.nmh', 'baselines')
}

/** Build a snapshot from an already-computed stats outcome. */
export function snapshotFromStats(cwd: string, outcome: StatsOutcome): BaselineSnapshot {
  const entries: BaselineEntrySnapshot[] = outcome.projects.map((project) => ({
    rel: path.relative(cwd, project.entry.path).split(path.sep).join('/'),
    size: project.entry.size,
    packages: project.entry.packageCount,
    pm: project.entry.pm.family,
    instances: project.topPackages.slice(0, 5000).map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      symlinked: pkg.symlinked,
      size: pkg.size,
    })),
  }))
  return {
    schema: 1,
    tool: toolVersion(),
    createdAt: new Date().toISOString(),
    cwd,
    totals: {
      size: outcome.overview.totalSize,
      folders: outcome.projects.length,
      packages: outcome.overview.instances,
    },
    entries,
  }
}

/** Save/overwrite `~/.nmh/baselines/<name>.json`; returns the written path. */
export async function saveBaseline(name: string, snapshot: BaselineSnapshot): Promise<string> {
  const file = path.join(baselinesDir(), `${name}.json`)
  await fs.mkdir(baselinesDir(), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  return file
}

export async function loadBaseline(name: string): Promise<BaselineSnapshot | null> {
  const file = path.join(baselinesDir(), `${name}.json`)
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as BaselineSnapshot
    return parsed && parsed.schema === 1 && Array.isArray(parsed.entries) ? parsed : null
  } catch (err) {
    verboseLog(`baseline read failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** Corrupt files are skipped (not fatal for --history). */
export async function listBaselines(): Promise<BaselineListItem[]> {
  const items: BaselineListItem[] = []
  let names: string[]
  try {
    names = (await fs.readdir(baselinesDir())).filter((file) => file.endsWith('.json'))
  } catch {
    return items // no baselines dir yet
  }
  for (const file of names) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(baselinesDir(), file), 'utf8')) as BaselineSnapshot
      if (parsed && parsed.schema === 1 && parsed.totals) {
        items.push({
          name: file.replace(/\.json$/, ''),
          createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '?',
          cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '?',
          totals: parsed.totals,
        })
      }
    } catch {
      warn(`skipping unreadable baseline: ${file}`)
    }
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function sumByName(entries: BaselineEntrySnapshot[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const entry of entries) {
    for (const pkg of entry.instances) {
      if (pkg.size == null) continue
      map.set(pkg.name, (map.get(pkg.name) ?? 0) + pkg.size)
    }
  }
  return map
}

/** Compare a fresh snapshot against a stored baseline. */
export function compareBaseline(name: string, baseline: BaselineSnapshot, fresh: BaselineSnapshot): BaselineComparison {
  const beforeEntries = new Map(baseline.entries.map((entry) => [entry.rel, entry]))
  const afterEntries = new Map(fresh.entries.map((entry) => [entry.rel, entry]))

  const deltas: BaselineDelta[] = []
  for (const [rel, after] of afterEntries) {
    const before = beforeEntries.get(rel)
    if (before === undefined) deltas.push({ rel, kind: 'new', before: null, after: after.size, delta: after.size })
    else deltas.push({ rel, kind: after.size > before.size ? 'grew' : after.size < before.size ? 'shrank' : 'same', before: before.size, after: after.size, delta: after.size - before.size })
  }
  for (const [rel, before] of beforeEntries) {
    if (!afterEntries.has(rel)) deltas.push({ rel, kind: 'gone', before: before.size, after: null, delta: -before.size })
  }
  deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  const beforePkgs = sumByName(baseline.entries)
  const afterPkgs = sumByName(fresh.entries)
  const movers: PackageMover[] = []
  for (const [name, size] of afterPkgs) {
    const before = beforePkgs.get(name) ?? 0
    movers.push({ name, before, after: size, delta: size - before })
  }
  for (const [name, size] of beforePkgs) {
    if (!afterPkgs.has(name)) movers.push({ name, before: size, after: 0, delta: -size })
  }
  movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name))

  const totalBefore = baseline.totals.size
  const totalAfter = fresh.totals.size
  return {
    baselineName: name,
    baselineCreatedAt: baseline.createdAt,
    totalBefore,
    totalAfter,
    totalDelta: totalAfter - totalBefore,
    totalDeltaPercent: totalBefore > 0 ? Math.round(((totalAfter - totalBefore) / totalBefore) * 1000) / 10 : null,
    packagesDelta: fresh.totals.packages - baseline.totals.packages,
    deltas,
    packageMovers: movers.filter((mover) => mover.delta !== 0),
  }
}
