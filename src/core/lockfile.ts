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

/** First usable lockfile wins — npm, yarn v1, pnpm, then bun text lockfiles. */
export async function readProjectLockGraph(projectDir: string): Promise<LockGraph | null> {
  return (await readNpmLockGraph(projectDir)) ?? (await readYarnLockGraph(projectDir)) ?? (await readPnpmLockGraph(projectDir)) ?? (await readBunLockGraph(projectDir)) ?? null
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

/** Subset shape for the mini-YAML: only scalar strings and one-level mappings. */
export interface MiniYamlMap {
  [key: string]: MiniYamlValue
}
export type MiniYamlValue = string | MiniYamlMap

/**
 * Lockfile-subset mini-YAML (pnpm-lock.yaml is machine-made and regular):
 * indent-stack mappings, quoted/plain scalar values, one-level inline flow
 * maps `{integrity: sha512-…}`. Sequences, anchors, multi-line scalars and
 * nested flow structures are refused by CALLERS (required paths simply won't
 * resolve → null, manifest-grade). NOT a general YAML parser — by design.
 */
export function parseMiniYaml(text: string): Record<string, MiniYamlValue> {
  const root: Record<string, MiniYamlValue> = {}
  const stack: Array<{ indent: number; obj: Record<string, MiniYamlValue> }> = [{ indent: -1, obj: root }]
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (trimmed.startsWith('- ')) continue // sequence line — not in the subset
    const colon = topLevelColonIndex(trimmed)
    if (colon < 0) continue
    const key = unquote(trimmed.slice(0, colon).trim())
    const valueText = trimmed.slice(colon + 1).trim()
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop()
    const parent = stack[stack.length - 1]!.obj
    if (valueText.length === 0) {
      const child: Record<string, MiniYamlValue> = {}
      parent[key] = child
      stack.push({ indent, obj: child })
    } else if (valueText.startsWith('{') && valueText.endsWith('}')) {
      parent[key] = parseInlineFlow(valueText.slice(1, -1))
    } else {
      parent[key] = unquote(valueText)
    }
  }
  return root
}

/** First ':' outside quotes/braces, or -1. */
function topLevelColonIndex(text: string): number {
  let quote: '"' | "'" | null = null
  let braces = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '{' || ch === '[') braces += 1
    else if (ch === '}' || ch === ']') braces -= 1
    else if (ch === ':' && braces === 0) return i
  }
  return -1
}

/** `{a: b, c: "d"}` → record (single level, no nested braces). */
function parseInlineFlow(inner: string): Record<string, MiniYamlValue> {
  const out: Record<string, MiniYamlValue> = {}
  if (inner.trim().length === 0) return out
  let quote: '"' | "'" | null = null
  let start = 0
  for (let i = 0; i <= inner.length; i += 1) {
    const ch = inner[i] ?? ','
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    if (ch === ',' || i === inner.length) {
      const part = inner.slice(start, i)
      const colon = topLevelColonIndex(part)
      if (colon > 0) out[unquote(part.slice(0, colon).trim())] = unquote(part.slice(colon + 1).trim())
      start = i + 1
    }
  }
  return out
}

/** Strip one pair of matching quotes (pnpm quotes keys with ':' inside). */
function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

/** 'lodash@4.17.21(@babel/core@7.26.0)' → 'lodash' — peer suffix stripped first. */
function nameOfSpecKey(key: string): string | null {
  const base = key.split('(')[0] ?? key
  const at = base.lastIndexOf('@')
  if (at <= 0) return null
  const name = base.slice(0, at)
  return name.length > 0 ? name : null
}

interface NameEdgeCount {
  edges: LockEdge[]
  rootDirect: number
  nodeNames: Set<string>
}

/**
 * pnpm-lock.yaml (v6/v9) PLUS the sibling package.json. Edges come from the
 * `snapshots:` maps (lockfileVersion 9.0 — `packages:` holds resolution-only
 * nodes) or the `packages:` deps maps (6.x). Root importer '.' supplies
 * rootDirect + root edges via its specifier lines (specifier wins over the
 * resolved version as the declared range). Workspace sub-importers are
 * counted later — v0.6 keeps the root importer only, said in the docs.
 */
export async function readPnpmLockGraph(projectDir: string): Promise<LockGraph | null> {
  let text: string
  try {
    const stat = await fs.stat(path.join(projectDir, 'pnpm-lock.yaml'))
    if (!stat.isFile() || stat.size > MAX_LOCKFILE_BYTES) return null
    text = await fs.readFile(path.join(projectDir, 'pnpm-lock.yaml'), 'utf8')
  } catch {
    return null
  }
  const doc = parseMiniYaml(text)
  const parsed = parsePnpmDoc(doc)
  if (parsed === null) return null
  // NOTE (unlike yarn): pnpm lockfiles carry the root importer ('.') with
  // specifier lines — the manifest is NOT re-read, keeping rootDirect single-sourced
  return buildGraph('pnpm', 'pnpm-lock.yaml', parsed)
}

/** Pull the graph source data out of a parsed pnpm-lock.yaml document. */
export function parsePnpmDoc(doc: Record<string, MiniYamlValue>): NameEdgeCount | null {
  const edges: LockEdge[] = []
  const nodeNames = new Set<string>()

  // lockfileVersion 9.0: snapshots carry the inter-package edges
  const snapshots = doc.snapshots
  if (snapshots !== undefined && typeof snapshots === 'object' && !Array.isArray(snapshots)) {
    collectPnpmNodes(snapshots as Record<string, MiniYamlValue>, edges, nodeNames)
  }
  const packages = doc.packages
  if (packages !== undefined && typeof packages === 'object' && !Array.isArray(packages)) {
    const hadSnapshots = nodeNames.size > 0
    // when snapshots already supplied edges (9.0), packages: is resolution-only —
    // still harvest names, but never collect duplicate dep edges
    collectPnpmNodes(packages as Record<string, MiniYamlValue>, hadSnapshots ? [] : edges, nodeNames)
  }
  if (nodeNames.size === 0) return null // not a pnpm lockfile shape we know

  // root importer '.' — specifier is the DECLARED range when present
  let rootDirect = 0
  const importers = doc.importers
  if (importers !== undefined && typeof importers === 'object' && !Array.isArray(importers)) {
    const rootImporter = (importers as Record<string, MiniYamlValue>)['.']
    if (rootImporter !== undefined && typeof rootImporter === 'object' && !Array.isArray(rootImporter)) {
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
        const map = (rootImporter as Record<string, MiniYamlValue>)[field]
        if (map === undefined || typeof map !== 'object' || Array.isArray(map)) continue
        for (const [name, entry] of Object.entries(map as Record<string, MiniYamlValue>)) {
          const range = typeof entry === 'object' && entry !== null && !Array.isArray(entry)
            ? (entry as Record<string, MiniYamlValue>).specifier ?? (entry as Record<string, MiniYamlValue>).version
            : entry
          if (typeof range !== 'string') continue
          edges.push({ from: ROOT, to: name, range })
          rootDirect += 1
        }
      }
    }
  }
  return { edges, rootDirect, nodeNames }
}

/** Collect node names + dependency edges from a packages/snapshots section. */
function collectPnpmNodes(section: Record<string, MiniYamlValue>, edges: LockEdge[], nodeNames: Set<string>): void {
  for (const [key, entry] of Object.entries(section)) {
    const name = nameOfSpecKey(key)
    if (name === null) continue
    nodeNames.add(name)
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const deps = (entry as Record<string, MiniYamlValue>).dependencies
    if (deps === undefined || typeof deps !== 'object' || Array.isArray(deps)) continue
    for (const [to, range] of Object.entries(deps as Record<string, MiniYamlValue>)) {
      // 6.x values are plain resolved versions; 9.0 may carry specifiers — either
      // is an honest edge label; 'link:' aliases get their literal text
      edges.push({ from: name, to: nameOfSpecKey(to) ?? to, range: typeof range === 'string' ? range : '' })
    }
  }
}

/**
 * bun.lock (Bun ≥ 1.2 writes TEXT lockfiles; jsonc-flavored JSON) — workspaces
 * carry the root deps, packages entries are compact arrays like
 * `["7.21.4", {}, ["@babel/types@8.0.0"]]` or object maps with `dependencies:`.
 * Best-effort: dep strings 'name@range' split at their last '@'; shapes outside
 * these two encodings yield nodes without edges. bun.lockb (binary) is NOT
 * parsed here → null, manifest-grade, said honestly in the output.
 */
export async function readBunLockGraph(projectDir: string): Promise<LockGraph | null> {
  let text: string
  try {
    const stat = await fs.stat(path.join(projectDir, 'bun.lock'))
    if (!stat.isFile() || stat.size > MAX_LOCKFILE_BYTES) return null
    text = await fs.readFile(path.join(projectDir, 'bun.lock'), 'utf8')
  } catch {
    return null
  }
  let doc: unknown
  try {
    doc = JSON.parse(stripJsonC(text))
  } catch {
    return null
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null
  const parsed = parseBunDoc(doc as Record<string, unknown>)
  if (parsed === null) return null
  const graph = buildGraph('bun', 'bun.lock', { edges: parsed.edges, rootDirect: parsed.rootDirect, nodeNames: parsed.nodeNames })
  return graph
}

/**
 * Strip line and block comments plus trailing commas (bun.lock is jsonc-ish),
 * fully quote-aware: neither comments nor scope-closing commas are recognized
 * inside a string literal (v0.9.4 — a global trailing-comma regex used to eat
 * `, }` / `, ]` sequences inside string values, corrupting them silently).
 */
export function stripJsonC(text: string): string {
  let out = ''
  let quote: '"' | null = null
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (quote !== null) {
      out += ch
      if (ch === '\\') {
        const next = text[i + 1] ?? ''
        out += next
        i += 2
        continue
      }
      if (ch === '"') quote = null
      i += 1
      continue
    }
    if (ch === '"') {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === ',') {
      // jsonc trailing comma: drop it when the next non-whitespace char closes the scope
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j += 1
      if (text[j] === '}' || text[j] === ']') {
        i += 1
        continue
      }
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** Extract nodes/edges from a parsed bun.lock document (workspaces + packages). */
export function parseBunDoc(doc: Record<string, unknown>): NameEdgeCount | null {
  const edges: LockEdge[] = []
  const nodeNames = new Set<string>()

  const packages = doc.packages
  if (packages === undefined || typeof packages !== 'object' || Array.isArray(packages)) return null
  for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
    const name = nameOfSpecKey(key)
    if (name === null) continue
    nodeNames.add(name)
    // entries may be [version, meta?, deps[]] arrays or { dependencies: {...} } maps
    if (Array.isArray(value)) {
      for (const member of value) {
        if (typeof member === 'string' && member.includes('@')) {
          const at = member.lastIndexOf('@')
          if (at > 0 && at < member.length - 1) edges.push({ from: name, to: member.slice(0, at), range: member })
        } else if (Array.isArray(member)) {
          for (const dep of member) {
            if (typeof dep === 'string' && dep.includes('@')) {
              const at = dep.lastIndexOf('@')
              if (at > 0 && at < dep.length - 1) edges.push({ from: name, to: dep.slice(0, at), range: dep })
            }
          }
        } else if (member !== null && typeof member === 'object') {
          collectBunDepMap(name, member as Record<string, unknown>, edges)
        }
      }
    } else if (value !== null && typeof value === 'object') {
      collectBunDepMap(name, value as Record<string, unknown>, edges)
    }
  }
  if (nodeNames.size === 0) return null

  let rootDirect = 0
  const workspaces = doc.workspaces
  if (workspaces !== undefined && typeof workspaces === 'object' && !Array.isArray(workspaces)) {
    const rootWorkspace = (workspaces as Record<string, unknown>)['.']
    if (rootWorkspace !== undefined && typeof rootWorkspace === 'object' && !Array.isArray(rootWorkspace)) {
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
        const map = (rootWorkspace as Record<string, unknown>)[field]
        if (map === undefined || typeof map !== 'object' || Array.isArray(map)) continue
        for (const [name, range] of Object.entries(map as Record<string, unknown>)) {
          if (typeof range !== 'string') continue
          edges.push({ from: ROOT, to: name, range })
          rootDirect += 1
        }
      }
    }
  }
  return { edges, rootDirect, nodeNames }
}

function collectBunDepMap(name: string, node: Record<string, unknown>, edges: LockEdge[]): void {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const map = node[field]
    if (map === undefined || typeof map !== 'object' || Array.isArray(map)) continue
    for (const [to, range] of Object.entries(map as Record<string, unknown>)) {
      if (typeof range === 'string') edges.push({ from: name, to, range })
    }
  }
}
