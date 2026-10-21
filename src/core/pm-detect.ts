import fs from 'node:fs/promises'
import path from 'node:path'
import type { PMFamily, PMInfo } from './result.ts'
import { manifestHasVitePlus, readPackageJson, type LoosePackageJson } from './packages.ts'

/** Detection order mirrors Vite+ (vp) — wrapper whose own docs define the canonical order. */
const LOCKFILE_PRIORITY: Array<{ family: Exclude<PMFamily, 'unknown'>; files: string[] }> = [
  { family: 'pnpm', files: ['pnpm-workspace.yaml', 'pnpm-lock.yaml'] },
  { family: 'yarn', files: ['yarn.lock', '.yarnrc.yml'] },
  { family: 'npm', files: ['package-lock.json'] },
  { family: 'bun', files: ['bun.lock', 'bun.lockb'] },
]

type PmDetector = (nodeModulesPath: string) => Promise<PMInfo>

/** Detection is climbed-level-then-ordered; a memo makes repeated entries in one workspace cheap. */
export function createPmDetector(): PmDetector {
  const cache = new Map<string, PMInfo>()
  return async (nodeModulesPath) => {
    const start = path.dirname(nodeModulesPath)
    const hit = cache.get(start)
    if (hit) return hit
    const info = await decorateVp(await detectUncached(start))
    cache.set(start, info)
    return info
  }
}

/** vp is a wrapper, not a package manager: tag when the workspace declares vite-plus. */
async function decorateVp(info: PMInfo): Promise<PMInfo> {
  const pkg = await readPackageJson(info.projectRoot)
  if (!manifestHasVitePlus(pkg)) return info
  return { ...info, vp: true, sources: [...info.sources, 'vite-plus dependency'] }
}

async function detectUncached(startDir: string): Promise<PMInfo> {
  let current = startDir
  for (;;) {
    const pkg = await readPackageJson(current)
    if (pkg) {
      const field = pmFromField(pkg.packageManager)
      if (field) return { family: field, sources: ['packageManager'], multiple: false, projectRoot: current, vp: false }

      const devEngines = pmFromDevEngines(pkg)
      if (devEngines) {
        return {
          family: devEngines,
          sources: ['devEngines.packageManager'],
          multiple: false,
          projectRoot: current,
          vp: false,
        }
      }
    }

    const lock = await detectLockfilesAt(current)
    if (lock) return lock

    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return {
    family: 'unknown',
    sources: [],
    multiple: false,
    projectRoot: startDir,
    vp: false,
  }
}

async function detectLockfilesAt(dir: string): Promise<PMInfo | null> {
  const foundFamilies = new Set<Exclude<PMFamily, 'unknown'>>()
  const foundFiles: string[] = []
  let primary: Exclude<PMFamily, 'unknown'> | null = null

  for (const group of LOCKFILE_PRIORITY) {
    for (const file of group.files) {
      if (await fileExists(path.join(dir, file))) {
        foundFiles.push(file)
        foundFamilies.add(group.family)
        if (!primary) primary = group.family
        break // first match per family is enough
      }
    }
  }

  if (!primary) return null
  return {
    family: primary,
    sources: foundFiles,
    multiple: foundFamilies.size > 1,
    projectRoot: dir,
    vp: false,
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p)
    return st.isFile()
  } catch {
    return false
  }
}

/** `pnpm@10.4.1+sha512.x` → 'pnpm'; `@scope/pm@1.0.0` → '@scope/pm'; garbage → null. */
export function pmFromField(value: string | undefined): Exclude<PMFamily, 'unknown'> | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const at = value.lastIndexOf('@')
  const name = at > 0 ? value.slice(0, at) : value
  return knownFamily(name)
}

function pmFromDevEngines(pkg: LoosePackageJson): Exclude<PMFamily, 'unknown'> | null {
  const field = pkg.devEngines?.packageManager
  if (!field) return null
  const names: string[] = Array.isArray(field)
    ? field.map((entry) => (typeof entry === 'string' ? entry : entry?.name ?? ''))
    : [typeof field === 'string' ? field : field.name ?? '']
  for (const name of names) {
    const known = knownFamily(name.trim())
    if (known) return known
  }
  return null
}

function knownFamily(name: string): Exclude<PMFamily, 'unknown'> | null {
  switch (name) {
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return name
    default:
      return null
  }
}
