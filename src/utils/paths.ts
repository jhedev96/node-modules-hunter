import { homedir } from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { glob } from 'tinyglobby'

/** Characters that make a target string worth expanding as a glob. */
const GLOB_CHARS = /[?*[\]{}]/

export function looksLikeGlob(input: string): boolean {
  return GLOB_CHARS.test(input)
}

export function expandTilde(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(homedir(), input.slice(2))
  return input
}

/** Split `--dir` input into individual targets: comma-separated lists, repeats, whitespace-trimmed. */
export function splitTargets(raw: string | string[] | undefined | null): string[] {
  if (!raw) return []
  const list = Array.isArray(raw) ? raw : [raw]
  return list
    .flatMap((chunk) => chunk.split(','))
    .map((chunk) => chunk.trim())
    .filter(Boolean)
}

export interface ResolvedRoots {
  /** Absolute, symlink-resolved scan roots (deduped by real path). */
  roots: string[]
  /** Original patterns that matched nothing at all. */
  unmatched: string[]
  /** Paths that EXIST but cannot be realpath'd (symlink loop / dangling edge cases). */
  unresolvable: string[]
}

/**
 * Expand tilde / globs / relative paths into a deduped list of real (absolute) paths.
 * Overlapping roots collapse to one real path — this is what keeps totals from double counting.
 */
export async function resolveRoots(patterns: string[], cwd: string): Promise<ResolvedRoots> {
  const roots: string[] = []
  const unmatched: string[] = []
  const unresolvable: string[] = []
  const seen = new Set<string>()

  for (const pattern of patterns) {
    const expanded = expandTilde(pattern)
    const isGlob = looksLikeGlob(expanded)
    let matches: string[]
    if (isGlob) {
      try {
        matches = await glob({
          patterns: [expanded],
          cwd,
          onlyDirectories: true,
          expandDirectories: false,
          absolute: false,
          dot: true,
        })
      } catch {
        matches = []
      }
    } else {
      matches = [expanded]
    }

    if (matches.length === 0) {
      unmatched.push(pattern)
      continue
    }

    for (const match of matches) {
      const absolute = path.isAbsolute(match) ? match : path.resolve(cwd, match)
      const real = await realpathSafe(absolute)
      if (!real) {
        // Exists on disk but cannot be resolved → not "no match": it is a safety case (ELOOP).
        if (await pathExists(absolute)) unresolvable.push(absolute)
        else unmatched.push(pattern)
        continue
      }
      if (seen.has(real)) continue
      seen.add(real)
      roots.push(real)
    }
  }

  return { roots, unmatched, unresolvable }
}

export async function realpathSafe(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p)
  } catch {
    return null
  }
}

export async function pathExists(p: string): Promise<boolean> {
  return (await fs.lstat(p).then(() => true, () => false)) === true
}

/** True when a real path equals a filesystem root (`/`, `C:\`). */
export function isRootPath(realPath: string): boolean {
  return path.dirname(realPath) === realPath
}
