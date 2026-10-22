import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent } from 'node:fs'

export interface LoosePackageJson {
  name?: string
  version?: string
  packageManager?: string
  devEngines?: {
    packageManager?: { name?: string } | Array<{ name?: string }> | string | Array<string>
  }
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  peerDependencies?: Record<string, unknown>
  /** npm-style bin declaration: 'cli.js' | { name: file, ... } */
  bin?: string | Record<string, string>
  optionalDependencies?: Record<string, unknown>
}

export async function readPackageJson(dir: string): Promise<LoosePackageJson | null> {
  try {
    const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as LoosePackageJson
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const MAX_CLIMB = 8

/** Nearest enclosing manifest name for a node_modules entry (dirname upward). */
export async function projectNameFor(entryPath: string): Promise<string | null> {
  let dir = path.dirname(entryPath)
  for (let hop = 0; hop < MAX_CLIMB; hop += 1) {
    const pkg = await readPackageJson(dir)
    if (typeof pkg?.name === 'string' && pkg.name) return pkg.name
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

export const VITE_PLUS_PACKAGES = new Set(['vite-plus', '@voidzero-dev/vite-plus-core'])

/** vp is a wrapper, not a package manager — detection = vite-plus packages declared in the manifest. */
export function manifestHasVitePlus(pkg: LoosePackageJson | null): boolean {
  if (!pkg) return false
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const deps = pkg[group]
    if (!deps || typeof deps !== 'object') continue
    for (const name of Object.keys(deps)) {
      if (VITE_PLUS_PACKAGES.has(name)) return true
    }
  }
  return false
}

export interface PackageRef {
  name: string
  path: string
  scope: string | null
  symlinked: boolean
}

/** Top-level installable packages of a node_modules entry (dotdirs skipped, `@scope` expanded). */
export async function listTopLevelPackages(entryPath: string): Promise<PackageRef[]> {
  let dirents: Dirent<string>[]
  try {
    dirents = await fs.readdir(entryPath, { withFileTypes: true })
  } catch {
    return []
  }

  const refs: PackageRef[] = []
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue // .pnpm, .bin, .cache, …
    const full = path.join(entryPath, dirent.name)

    if (dirent.isDirectory()) {
      if (dirent.name.startsWith('@')) {
        let members: Dirent<string>[]
        try {
          members = await fs.readdir(full, { withFileTypes: true })
        } catch {
          continue
        }
        for (const member of members) {
          if (member.name.startsWith('.')) continue
          if (member.isDirectory() || member.isSymbolicLink()) {
            refs.push({
              name: `${dirent.name}/${member.name}`,
              path: path.join(full, member.name),
              scope: dirent.name,
              symlinked: member.isSymbolicLink(),
            })
          }
        }
        continue
      }
      refs.push({ name: dirent.name, path: full, scope: null, symlinked: false })
      continue
    }

    if (dirent.isSymbolicLink()) {
      // pnpm-style top-level links point at real package dirs; count them if they really are dirs.
      const st = await fs.stat(full).then(
        (value) => value,
        () => null,
      )
      if (st?.isDirectory()) {
        refs.push({ name: dirent.name, path: full, scope: null, symlinked: true })
      }
    }
  }
  return refs
}

export async function packageVersion(pkgPath: string): Promise<string | null> {
  const pkg = await readPackageJson(pkgPath)
  return typeof pkg?.version === 'string' ? pkg.version : null
}

export interface DepSpec {
  /** The raw manifest value, e.g. `^4.17.0` or `npm:lodash@5`. */
  range: string
  /** Which dependency field declares it: dependencies | devDependencies | optionalDependencies | peerDependencies. */
  field: string
  /** Manifest directory that declares it (first hit on the climb). */
  projectDir: string
  projectName: string | null
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

type ClassifyHit = { field: string; range: string; projectDir: string; projectName: string | null }

/**
 * Cached dep classifier: one manifest read per directory, first manifest on the
 * climb that names the package (in any dep field) wins — same attribution as
 * `depSpecFor`, but cheap enough for N packages × M entries.
 */
export function createDepClassifier(): (entryPath: string, pkgName: string) => Promise<ClassifyHit | null> {
  const cache = new Map<string, LoosePackageJson | null>()
  const readManifest = async (dir: string): Promise<LoosePackageJson | null> => {
    let manifest = cache.get(dir)
    if (manifest === undefined) {
      manifest = await readPackageJson(dir)
      cache.set(dir, manifest)
    }
    return manifest
  }
  return async (entryPath: string, pkgName: string): Promise<ClassifyHit | null> => {
    let dir = path.dirname(entryPath)
    for (let hop = 0; hop < MAX_CLIMB; hop += 1) {
      const pkg = await readManifest(dir)
      if (pkg) {
        for (const field of DEP_FIELDS) {
          const range = (pkg[field] as Record<string, unknown> | undefined)?.[pkgName]
          if (typeof range === 'string') {
            return {
              field,
              range,
              projectDir: dir,
              projectName: typeof pkg.name === 'string' ? pkg.name : null,
            }
          }
        }
      }
      const parent = path.dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
    return null
  }
}

/**
 * Only the requirer's OWN manifest counts for required-by (PRD §8.2): no ancestor
 * climb — a project declaring lodash must not be attributed to every sibling.
 */
export async function ownManifestRequires(pkgPath: string, pkgName: string): Promise<{ range: string; field: string } | null> {
  const manifest = await readPackageJson(pkgPath)
  if (manifest === null) return null
  for (const field of DEP_FIELDS) {
    const range = (manifest[field] as Record<string, unknown> | undefined)?.[pkgName]
    if (typeof range === 'string') return { range, field }
  }
  return null
}

/**
 * Where + how a specific package name is declared around an entry (PRD §8.2 dedup
 * suggestion): nearest manifest on the climb wins, checked per dep field.
 */
export async function depSpecFor(entryPath: string, pkgName: string): Promise<DepSpec | null> {
  const hit = await createDepClassifier()(entryPath, pkgName)
  return hit
}

export interface ProjectDeps {
  projectDir: string
  name: string | null
  dependencies: string[]
  devDependencies: string[]
}

/** Declared deps (dependencies + devDependencies) of the nearest manifest around an entry. */
export async function projectDepsFor(entryPath: string): Promise<ProjectDeps | null> {
  let dir = path.dirname(entryPath)
  for (let hop = 0; hop < MAX_CLIMB; hop += 1) {
    const pkg = await readPackageJson(dir)
    if (pkg && (pkg.dependencies || pkg.devDependencies)) {
      return {
        projectDir: dir,
        name: typeof pkg.name === 'string' ? pkg.name : null,
        dependencies: Object.keys(pkg.dependencies ?? {}),
        devDependencies: Object.keys(pkg.devDependencies ?? {}),
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}
