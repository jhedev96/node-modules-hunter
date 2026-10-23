import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Lockfile-grade dependency graph (PRD §8.2, deferred from v0.4 → v0.5 → v0.6).
 * Zero runtime deps: package-lock.json is JSON — lockfileVersion 2/3 (`packages`
 * map). Version-1 (npm 6) lockfiles fall back to manifest-grade honestly; yarn
 * and pnpm get their own tiny parsers in the same file family. Any surprise →
 * `null`, callers keep the manifest-grade numbers and label them as such.
 */

export interface LockEdge {
  /** Package name that declares the dependency — '«root»' is the project itself. */
  from: string
  to: string
  range: string
}

export interface LockGraph {
  pm: 'npm' | 'yarn' | 'pnpm' | 'bun'
  /** Display-friendly name of the parsed lockfile (file part only). */
  file: string
  /** Direct deps the project root declares (Σ all its dep fields). */
  rootDirect: number
  /** Distinct package names in the tree (workspace links excluded). */
  nodes: number
  /** Counted edges — the root's own edges included. */
  edges: number
  /** BFS hops from the project root, reachable packages only, ascending. */
  depthHistogram: Array<{ depth: number; packages: number }>
  /** Tree nodes no edge path reaches (peers/optional pruning happens). */
  unreachable: number
  /**
   * Raw dependency edges — kept for reverse lookups (`nmh why` requirers).
   * Internal only: aggregate outcomes and JSON reports carry counts, not edges.
   */
  dependencyEdges: LockEdge[]
}

const ROOT = '«root»'
/** Lockfiles can be multi-MB on big repos; beyond this we just say manifest-grade. */
const MAX_LOCKFILE_BYTES = 8 * 1024 * 1024

/**
 * npm lockfile keys are PATHS, not names: 'node_modules/x', nested
 * 'node_modules/a/node_modules/b', and scoped 'node_modules/@scope/pkg' (the
 * scope segment has no inner 'node_modules/'). Strip ALL leading
 * 'node_modules/' occurrences — the tail is the package name (npm forbids
 * 'node_modules' inside real names, so this is unambiguous).
 */
function nameOfPackageKey(key: string): string | null {
  if (!key.startsWith('node_modules/')) return null
  const name = key.replace(/^(?:node_modules\/)+/, '')
  return name.length > 0 ? name : null
}

interface NpmLockNode {
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  optionalDependencies?: Record<string, unknown>
}

/** lockfileVersion 2/3 shape: { packages: { '': root, 'node_modules/x': node } }. */
export function parseNpmLockPackages(doc: { packages?: Record<string, NpmLockNode> }): { edges: LockEdge[]; rootDirect: number; nodeNames: Set<string> } | null {
  const packages = doc.packages
  if (packages === undefined || typeof packages !== 'object') return null
  const rootEntry = (packages as Record<string, NpmLockNode | undefined>)['']
  if (rootEntry === undefined || rootEntry === null) return null

  const edges: LockEdge[] = []
  const pushEdges = (from: string, map: Record<string, unknown> | undefined): void => {
    if (map === undefined || typeof map !== 'object') return
    for (const [name, range] of Object.entries(map)) {
      if (typeof range === 'string') edges.push({ from, to: name, range })
    }
  }

  let rootDirect = 0
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const map = rootEntry[field]
    if (map === undefined || typeof map !== 'object') continue
    rootDirect += Object.keys(map).length
    pushEdges(ROOT, map)
  }
  const nodeNames = new Set<string>()
  for (const [key, entry] of Object.entries(packages)) {
    const name = nameOfPackageKey(key)
    if (name === null) continue
    nodeNames.add(name)
    pushEdges(name, entry?.dependencies)
  }
  return { edges, rootDirect, nodeNames }
}

/** Merge root edges + BFS from the root into the final graph shape. */
export function buildGraph(pm: LockGraph['pm'], file: string, parsed: { edges: LockEdge[]; rootDirect: number; nodeNames: Set<string> } | null): LockGraph | null {
  if (parsed === null) return null
  const adjacency = new Map<string, Array<{ to: string; range: string }>>()
  const realEdges = parsed.edges.filter((edge) => edge.from !== edge.to)
  for (const edge of realEdges) {
    const list = adjacency.get(edge.from)
    if (list === undefined) adjacency.set(edge.from, [edge])
    else list.push(edge)
  }
  const depth = new Map<string, number>([[ROOT, 0]])
  let frontier = [ROOT]
  let hop = 0
  while (frontier.length > 0 && hop < 64) {
    const next: string[] = []
    for (const current of frontier) {
      for (const edge of adjacency.get(current) ?? []) {
        if (depth.has(edge.to)) continue
        depth.set(edge.to, hop + 1)
        next.push(edge.to)
      }
    }
    frontier = next
    hop += 1
  }
  const histogram = new Map<number, number>()
  let reachedReal = 0
  for (const depthEntry of depth) {
    if (depthEntry[0] === ROOT) continue
    histogram.set(depthEntry[1], (histogram.get(depthEntry[1]) ?? 0) + 1)
    if (parsed.nodeNames.has(depthEntry[0])) reachedReal += 1
  }
  return {
    pm,
    file,
    rootDirect: parsed.rootDirect,
    nodes: parsed.nodeNames.size,
    edges: realEdges.length,
    depthHistogram: [...histogram].sort((a, b) => a[0] - b[0]).map(([d, packages]) => ({ depth: d, packages })),
    // tree nodes with no incoming path from the root — installed-but-unreferenced
    unreachable: Math.max(0, parsed.nodeNames.size - reachedReal),
    dependencyEdges: realEdges,
  }
}

/**
 * npm package-lock.json (lockfileVersion 2/3) next to a node_modules entry.
 * Version 1 (npm 6) or unexpected shapes → null (manifest-grade fallback).
 */
export async function readNpmLockGraph(projectDir: string, file = 'package-lock.json'): Promise<LockGraph | null> {
  let text: string
  try {
    const stat = await fs.stat(`${projectDir}/${file}`)
    if (!stat.isFile() || stat.size > MAX_LOCKFILE_BYTES) return null
    text = await fs.readFile(`${projectDir}/${file}`, 'utf8')
  } catch {
    return null
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  if (doc === null || typeof doc !== 'object') return null
  const hosts = doc as Record<string, unknown>
  const parsed = typeof hosts.packages === 'object' && hosts.packages !== null ? parseNpmLockPackages(doc as never) : null
  return buildGraph('npm', file, parsed)
}

/** First usable lockfile wins — npm, then yarn v1; pnpm/bun land in later slices. */
export async function readProjectLockGraph(projectDir: string): Promise<LockGraph | null> {
  return (await readNpmLockGraph(projectDir)) ?? (await readYarnLockGraph(projectDir)) ?? null
}

/**
 * yarn.lock (classic v1) PLUS the sibling package.json. Yarn v1 stores no root
 * deps, so the project manifest supplies rootDirect and the root edges; entry
 * `dependencies:` sub-blocks supply the tree edges (optionalDependencies are
 * skipped, same as the npm parser — they surface as `unreachable` when absent).
 * Yarn Berry (a YAML file with `__metadata:` / `npm:`-protocol specs) is refused
 * here → null; it lands with the YAML micro-parser (v0.6 slice C).
 */
export async function readYarnLockGraph(projectDir: string): Promise<LockGraph | null> {
  let text: string
  try {
    const stat = await fs.stat(path.join(projectDir, 'yarn.lock'))
    if (!stat.isFile() || stat.size > MAX_LOCKFILE_BYTES) return null
    text = await fs.readFile(path.join(projectDir, 'yarn.lock'), 'utf8')
  } catch {
    return null
  }
  const parsed = parseYarnLock(text)
  if (parsed === null) return null

  // root manifest → rootDirect + root edges (best-effort; absent manifest keeps 0/[])
  let rootDirect = 0
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(projectDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
      optionalDependencies?: Record<string, unknown>
    }
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      const map = manifest[field]
      if (map === undefined || typeof map !== 'object') continue
      for (const [name, range] of Object.entries(map)) {
        if (typeof range !== 'string') continue
        rootDirect += 1
        parsed.edges.push({ from: ROOT, to: name, range })
      }
    }
  } catch {
    // no readable manifest — the tree is still honest, just without root edges
  }
  parsed.rootDirect = rootDirect
  return buildGraph('yarn', 'yarn.lock', parsed)
}

/**
 * yarn.lock v1 text state machine:
 *   header  : `spec1@range, spec2@range:` at column 0 (specs may be quoted)
 *   body    : `  key "value"` pairs + `  dependencies:` sub-blocks of 4-indented
 *             `name "range"` pairs
 *   refusal : yarn Berry (`__metadata:`, `npm:` protocol specs) or no entries
 */
export function parseYarnLock(text: string): { edges: LockEdge[]; rootDirect: number; nodeNames: Set<string> } | null {
  if (text.includes('__metadata:')) return null // Yarn Berry / YAML-era lockfile
  const lines = text.split('\n')
  const edges: LockEdge[] = []
  const nodeNames = new Set<string>()
  let inDependencies = false
  let currentName: string | null = null
  let sawEntry = false
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (line.length === 0) {
      inDependencies = false
      continue
    }
    if (!raw.startsWith(' ') && !raw.startsWith('#')) {
      // entry header: name the node from its first spec (strip quote wrappers)
      if (line.includes('npm:') || !line.endsWith(':')) return null
      const specs = line.slice(0, -1).split(', ')
      const spec = specs[0]?.trim().replace(/^"|"$/g, '') ?? ''
      const at = spec.lastIndexOf('@')
      if (at <= 0) return null
      currentName = spec.slice(0, at)
      nodeNames.add(currentName)
      sawEntry = true
      inDependencies = false
      continue
    }
    if (currentName === null) continue
    const body = line.replace(/^\s+/, '')
    if (/^(dependencies|optionalDependencies|peerDependencies):$/.test(body)) {
      inDependencies = body === 'dependencies:'
      continue
    }
    if (inDependencies) {
      const match = /^"?(.+?)"?\s+"([^"]+)"$/.exec(body)
      if (match !== null) edges.push({ from: currentName, to: match[1]!, range: match[2]! })
    }
  }
  if (!sawEntry) return null
  return { edges, rootDirect: 0, nodeNames }
}
