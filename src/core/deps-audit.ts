import { glob } from 'tinyglobby'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createLimiter } from '../utils/limit.ts'
import { readPackageJson } from './packages.ts'

export interface AuditProject {
  dir: string
  projectName: string | null
}

export interface DepsAuditHit {
  name: string
  /** Up to 3 project-relative file paths where it is imported (phantom only). */
  sites: string[]
  /** Declaring manifests as `name (field)` (dead only). */
  declaringProjects: string[]
}

export interface DepsAudit {
  scannedFiles: number
  /** Imported in code but declared in no scanned manifest. */
  phantom: DepsAuditHit[]
  /** Declared (callable fields) + installed but never imported. */
  dead: DepsAuditHit[]
}

const SOURCE_GLOB = '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,vue,svelte,astro}'
const SOURCE_IGNORES = ['**/node_modules/**', '**/.git/**']
const MAX_FILES_PER_PROJECT = 2000
const MAX_FILE_BYTES = 512 * 1024
const MAX_PROJECTS = 300
const MAX_SITES_SHOWN = 3

/** Import/require/export-from module specifiers — same-line spans only (best-effort, PRD keputusan #7). */
const SPEC_PATTERNS: RegExp[] = [
  /\bimport\s+(?:type\s+)?[\w{}\s,$*]*?\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?[\w{}\s,$*]*?\bfrom\s+['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

/** `node:fs`/relative/alias specifiers → null; `pkg/sub` → `pkg`; `@scope/x/y` → `@scope/x`. */
export function moduleNameOf(spec: string): string | null {
  if (spec.length === 0) return null
  if (spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return null
  if (spec.startsWith('@')) {
    const parts = spec.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null
  }
  return spec.split('/')[0] ?? null
}

/** Unique package names imported by one source file (order of first appearance). */
export function extractImports(code: string): string[] {
  const found = new Set<string>()
  for (const pattern of SPEC_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const name = moduleNameOf(match[1] ?? '')
      if (name !== null) found.add(name)
    }
  }
  return [...found]
}

const CALLABLE_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
const ALL_DEP_FIELDS = [...CALLABLE_FIELDS, 'peerDependencies'] as const

function posixify(rel: string): string {
  return rel.split(path.sep).join('/')
}

/**
 * Best-effort phantom/dead audit (PRD §8.2):
 * - phantom = imported in project sources but declared in no scanned manifest
 * - dead    = declared in a callable field + installed + never imported anywhere
 * peerDependencies never count as dead (hosts consume them), but they do satisfy
 * phantom (a name a peer hosts is declared).
 */
export async function collectDepsAudit(
  projects: AuditProject[],
  installedNames: Set<string>,
): Promise<DepsAudit> {
  // same dir twice (e.g. an entry + its -r parent) is one project
  const dirs = [...new Map(projects.map((project) => [project.dir, project])).values()].slice(0, MAX_PROJECTS)

  const importedSites = new Map<string, string[]>() // name → file samples (capped)
  let scannedFiles = 0
  const limiter = createLimiter(6)

  // dep-declared names across every scanned manifest
  const declaredAny = new Set<string>() // includes peerDependencies
  // per-project callable declarations, minus globally-imported names → dead
  const callsites: Array<{ projectName: string | null; field: string; names: Set<string> }> = []

  await Promise.all(
    dirs.map(async (project) => {
      const manifest = await readPackageJson(project.dir)
      if (manifest !== null) {
        for (const field of ALL_DEP_FIELDS) {
          const names = Object.keys((manifest[field] as Record<string, unknown> | undefined) ?? {})
          if (names.length === 0) continue
          for (const name of names) declaredAny.add(name)
          if (field !== 'peerDependencies') {
            callsites.push({ projectName: project.projectName, field, names: new Set(names) })
          }
        }
      }

      let files: string[] = []
      try {
        files = await glob(SOURCE_GLOB, { cwd: project.dir, ignore: SOURCE_IGNORES, dot: false })
      } catch {
        return // unreadable project dir — audit stays honest (fewer scanned files)
      }
      for (const file of files.slice(0, MAX_FILES_PER_PROJECT)) {
        await limiter(async () => {
          let code: string
          try {
            const stat = await fs.stat(path.join(project.dir, file))
            if (stat.size > MAX_FILE_BYTES) return
            code = await fs.readFile(path.join(project.dir, file), 'utf8')
          } catch {
            return // unreadable source — skip silently, still best-effort
          }
          scannedFiles += 1
          const rel = posixify(file)
          for (const name of extractImports(code)) {
            const sites = importedSites.get(name) ?? []
            if (sites.length < 64) sites.push(rel)
            importedSites.set(name, sites)
          }
        })
      }
    }),
  )

  const phantom = [...importedSites]
    .filter(([name]) => !declaredAny.has(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, sites]) => ({
      name,
      sites: sites.slice(0, MAX_SITES_SHOWN),
      declaringProjects: [],
    }))

  const dead: DepsAuditHit[] = []
  for (const callsite of callsites) {
    for (const name of callsite.names) {
      if (importedSites.has(name)) continue // someone imports it — not dead
      if (!installedNames.has(name)) continue // declared but not installed → stale, not "dead copy"
      let hit = dead.find((entry) => entry.name === name)
      if (hit === undefined) {
        hit = { name, sites: [], declaringProjects: [] }
        dead.push(hit)
      }
      hit.declaringProjects.push(`${callsite.projectName ?? '(manifest tanpa nama)'} (${callsite.field})`)
    }
  }
  dead.sort((a, b) => a.name.localeCompare(b.name))

  return { scannedFiles, phantom, dead }
}
