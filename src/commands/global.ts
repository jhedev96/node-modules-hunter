import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { expandTilde } from '../utils/paths.ts'
import { createLimiter } from '../utils/limit.ts'
import { progressLine, clearProgress, warn, verboseLog, log, payload } from '../utils/logger.ts'
import { readPackageJson, listTopLevelPackages, packageVersion } from '../core/packages.ts'
import { measureEntry } from '../core/sizer.ts'
import { renderGlobalJson, renderGlobalReport } from '../core/render.ts'
import type { GlobalBinIssue, GlobalPackageInfo, GlobalPmReport, GlobalOutcome } from '../core/result.ts'

const execFileAsync = promisify(execFile)
const PROBE_TIMEOUT = 8000

export interface GlobalRequest {
  cwd: string
  json?: boolean
  /** --pm <family>: only probe this PM. */
  pmFilter?: string[]
}

interface RootSpec {
  root: string
  binDir: string | null
  source: 'pm' | 'fallback'
}

/** Probe one PM CLI for its global node_modules. Last non-empty stdout line wins. */
async function probeViaCommand(cmd: string, argv: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, argv, { timeout: PROBE_TIMEOUT })
    const line = stdout.split('\n').map((row) => row.trim()).filter(Boolean).pop()
    return line && line.length > 0 ? line : null
  } catch (err) {
    verboseLog(`global probe: ${cmd} ${argv.join(' ')} failed (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`)
    return null
  }
}

async function probeRoot(cmd: string, argv: string[], shape: (dir: string) => RootSpec, fallback: RootSpec | null): Promise<RootSpec | null> {
  const dir = await probeViaCommand(cmd, argv)
  if (dir) {
    const spec = shape(dir)
    if (await isDir(spec.root)) return spec
  }
  if (fallback && (await isDir(fallback.root))) return fallback
  return null
}

async function isDir(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory()
  } catch {
    return false
  }
}

/** Expand a scoped name to its default bin name (@scope/foo → foo). */
function defaultBinName(packageName: string): string {
  const parts = packageName.split('/')
  return packageName.startsWith('@') && parts.length >= 2 ? parts[1]! : packageName
}

/**
 * Bin-symlink sanity (PRD §8.4 dead-globals, best effort): a package declares bin
 * entries, so its global bin dir should hold a working symlink per bin name.
 * Pure lstat on the bin dir — symlink targets are stat()ed but never walked.
 */
export async function inspectDeadBins(
  root: string,
  binDir: string,
  refs: Array<{ name: string; path: string; symlinked: boolean }>,
): Promise<GlobalBinIssue[]> {
  const issues: GlobalBinIssue[] = []
  if (!(await isDir(binDir))) return issues
  for (const ref of refs) {
    if (ref.symlinked) continue
    let binField: string | Record<string, string> | null = null
    try {
      const manifest = await readPackageJson(ref.path)
      binField = manifest?.bin ?? null
    } catch {
      continue // unreadable manifest → cannot know what to check
    }
    let binNames: string[]
    if (typeof binField === 'string') binNames = [defaultBinName(ref.name)]
    else if (binField && typeof binField === 'object') binNames = Object.keys(binField)
    else continue // no bins declared → nothing to check
    for (const binName of binNames) {
      const link = path.join(binDir, binName)
      try {
        const linkStat = await fs.lstat(link)
        if (!linkStat.isSymbolicLink()) continue // regular file (copy-installed) → fine
        try {
          await fs.stat(link) // follows the target once: broken/missing → dead
        } catch {
          issues.push({ name: ref.name, kind: 'broken bin symlink', detail: binName })
        }
      } catch {
        issues.push({ name: ref.name, kind: 'missing bin symlink', detail: binName })
      }
    }
  }
  return issues
}

async function resolvePmRoots(pmFilter: string[] | undefined): Promise<Array<{ pm: string; spec: RootSpec }>> {
  const npmFallback: RootSpec = {
    root: path.join(expandTilde('~'), 'lib', 'node_modules'),
    binDir: path.join(expandTilde('~'), 'bin'),
    source: 'fallback',
  }
  const pnpmFallback = await pnpmFallbackSpec()
  const yarnFallback: RootSpec = {
    root: path.join(expandTilde('~'), '.config', 'yarn', 'global', 'node_modules'),
    binDir: path.join(expandTilde('~'), '.config', 'yarn', 'global', 'bin'),
    source: 'fallback',
  }
  const bunFallback: RootSpec = {
    root: path.join(expandTilde('~'), '.bun', 'install', 'global', 'node_modules'),
    binDir: path.join(expandTilde('~'), '.bun', 'bin'),
    source: 'fallback',
  }

  const wanted = pmFilter ?? ['npm', 'pnpm', 'yarn', 'bun']
  const results: Array<{ pm: string; spec: RootSpec }> = []
  for (const pm of wanted) {
    let spec: RootSpec | null = null
    if (pm === 'npm') spec = await probeRoot('npm', ['root', '-g'], (dir) => ({ root: dir, binDir: path.join(path.dirname(path.dirname(dir)), 'bin'), source: 'pm' }), npmFallback)
    else if (pm === 'pnpm') spec = await probeRoot('pnpm', ['root', '-g'], (dir) => ({ root: dir, binDir: null, source: 'pm' }), pnpmFallback)
    else if (pm === 'yarn') spec = await probeRoot('yarn', ['global', 'dir'], (dir) => ({ root: path.join(dir, 'node_modules'), binDir: path.join(dir, 'bin'), source: 'pm' }), yarnFallback)
    else if (pm === 'bun') spec = await probeRoot('bun', ['pm', '-g'], (dir) => ({ root: dir, binDir: path.join(path.dirname(path.dirname(dir)), 'bin'), source: 'pm' }), bunFallback)
    if (spec) results.push({ pm, spec })
    else verboseLog(`global: ${pm} — no global node_modules found`)
  }
  return results
}

/** pnpm keeps global installs under ~/.local/share/pnpm/global/vN — probe the newest. */
async function pnpmFallbackSpec(): Promise<RootSpec | null> {
  const base = path.join(expandTilde('~'), '.local', 'share', 'pnpm', 'global')
  try {
    const versions = (await fs.readdir(base)).filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(b) - Number(a))
    for (const version of versions) {
      const root = path.join(base, version, 'node_modules')
      if (await isDir(root)) return { root, binDir: null, source: 'fallback' }
    }
  } catch {
    // no pnpm global dir at all
  }
  return null
}

export async function runGlobal(request: GlobalRequest): Promise<number> {
  progressLine('⠋ probing global prefixes…')

  const pmRoots = await resolvePmRoots(request.pmFilter)
  const reports: GlobalPmReport[] = []
  const permissionIssues: string[] = []

  for (const { pm, spec } of pmRoots) {
    const refs = await listTopLevelPackages(spec.root)
    const pkgLimiter = createLimiter(8)
    let done = 0
    const packages = await Promise.all(
      refs.map((ref) =>
        pkgLimiter(async () => {
          const [version, measure] = await Promise.all([
            packageVersion(ref.path),
            ref.symlinked ? Promise.resolve(null) : measureEntry(ref.path),
          ])
          done += 1
          progressLine(`⠋ global ${pm} — ${done}/${refs.length} packages`)
          return { name: ref.name, version, symlinked: ref.symlinked, size: measure === null ? null : measure.size }
        }),
      ),
    )

    const dead = spec.binDir ? await inspectDeadBins(spec.root, spec.binDir, refs) : []
    reports.push({
      pm,
      root: spec.root,
      binDir: spec.binDir,
      source: spec.source,
      packages,
      dead,
    })
  }
  clearProgress()

  // cross-PM duplication: same package name installed globally under >1 PM (PRD §8.4)
  const byName = new Map<string, Map<string, number>>() // name → pm → size
  for (const report of reports) {
    for (const pkg of report.packages) {
      if (pkg.size === null) continue
      const perPm = byName.get(pkg.name) ?? new Map<string, number>()
      perPm.set(report.pm, pkg.size)
      byName.set(pkg.name, perPm)
    }
  }
  const duplicates = [...byName.entries()]
    .filter(([, perPm]) => perPm.size > 1)
    .map(([name, perPm]) => ({
      name,
      pms: [...perPm.keys()],
      savings: Math.min(...perPm.values()),
    }))
    .sort((a, b) => b.pms.length - a.pms.length || a.name.localeCompare(b.name))

  const totals = {
    packages: reports.reduce((sum, report) => sum + report.packages.length, 0),
    size: reports.reduce((sum, report) => sum + report.packages.reduce((inner, pkg) => inner + (pkg.size ?? 0), 0), 0),
  }

  let code = 0
  if (reports.length === 0) code = 2
  return finish(request, { code, reports, skippedPms: [], duplicates, totals, permissionIssues })
}

function finish(request: GlobalRequest, outcome: GlobalOutcome): number {
  if (outcome.reports.length === 0) {
    warn('no global install roots found — nothing to analyze here 🌐🙃')
    if (request.json) {
      payload(renderGlobalJson(outcome, request))
      return 2
    }
    return 2
  }
  if (request.json) payload(renderGlobalJson(outcome, request))
  else log(renderGlobalReport(outcome, request))
  return outcome.code
}
