import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { confirm, isCancel } from '@clack/prompts'
import { toolVersion } from '../utils/version.ts'
import { isNewer } from '../utils/update-check.ts'
import { errorLog, log, note, payload, spinUpdate, spinClear, verboseLog, isTTYOut } from '../utils/logger.ts'
import { isValidDistTag } from '../utils/config.ts'
import { formatBytes } from '../utils/format.ts'
import { t } from '../i18n/index.ts'

const execFileP = promisify(execFile)

/** v1.2: how the update run should behave — two read-only views plus the deciding default. */
export type UpdateMode = 'check' | 'info' | 'default'
/** v1.2: -y / -n on the CLI; 'none' = ask interactively (TTY) or refuse (non-TTY/--json). */
export type UpdateAnswer = 'yes' | 'no' | 'none'
/** v1.4: how the selected dist-tag's version relates to the installed one. */
export type UpdateDirection = 'upgrade' | 'downgrade' | 'current'

export interface UpdateRequest {
  json: boolean
  mode: UpdateMode
  answer: UpdateAnswer
  /** -f/--force: install without asking when an update exists — never reinstalls a latest version. */
  force: boolean
  /** v1.4: which npm dist-tag to read (default 'latest'); cli merges --tag/--check <tag>/rc updateTag. */
  tag?: string
}

export interface UpdateDetail {
  description?: string
  tarball?: string
  unpackedSize?: string
  fileCount?: number
  engines?: string
  license?: string
  publishedAt?: string
}

export interface UpdateResult {
  current: string
  latest: string
  updated: boolean
  method: 'npm-global' | 'manual'
  /** v1.2 (additive key): true when the registry offers something newer than the installed version. */
  updateAvailable: boolean
  /** v1.4 (additive keys): the dist-tag this run read from, the version it points at, and how
   * that compares to the installed one — `latest` stays the version of the `latest` dist-tag. */
  tag: string
  target: string
  direction: UpdateDirection
  /** v1.4 (additive key): every published dist-tag — --info only, when the registry answers. */
  distTags?: Record<string, string>
  /** v1.2 (additive key): npm-view style registry facts — --info only. */
  detail?: UpdateDetail
}

export type UpdateOutcome = { code: 0; result: UpdateResult } | { code: 1; error: string }

/** `npm` is a .cmd on Windows — execFile needs a shell there; args are fixed/validated strings. */
async function runNpm(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const win32 = process.platform === 'win32'
  try {
    const { stdout } = await execFileP(win32 ? 'npm.cmd' : 'npm', args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      shell: win32,
      windowsHide: true,
    })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

const VERSION_SHAPE = /^\d+\.\d+\.\d+/

interface LatestManifest {
  version: string
  detail: UpdateDetail
}

/** Registry facts worth showing in `--info`; every field is optional and best-effort. */
function manifestDetailFrom(parsed: Record<string, unknown>): UpdateDetail {
  const detail: UpdateDetail = {}
  if (typeof parsed.description === 'string') detail.description = parsed.description
  if (typeof parsed.license === 'string') detail.license = parsed.license
  const dist = parsed.dist
  if (dist !== null && typeof dist === 'object') {
    const d = dist as Record<string, unknown>
    if (typeof d.tarball === 'string') detail.tarball = d.tarball
    if (typeof d.unpackedSize === 'number') detail.unpackedSize = formatBytes(d.unpackedSize)
    if (typeof d.fileCount === 'number') detail.fileCount = d.fileCount
  }
  const engines = parsed.engines
  if (engines !== null && typeof engines === 'object') {
    const e = engines as Record<string, unknown>
    if (typeof e.node === 'string') detail.engines = e.node
  }
  return detail
}

/**
 * Latest published version + registry facts. Version detection goes through
 * `npm view <pkg> version` (plain text — the one npm-output shape that is stable
 * across npm versions; v1.2.0 briefly parsed `npm view --json` instead and died:
 * modern npm returns the ABBREVIATED PACKUMENT there — an array of version
 * strings — with no top-level `version` key). The `--info` detail is a separate
 * best-effort `npm view <pkg>@latest --json` whose many shapes get normalized.
 * Test/MCI escape hatch, mirroring the NMH-* family: NMH_UPDATE_LATEST_JSON wins
 * for the version (and may carry detail fields), NMH_UPDATE_VIEW_JSON feeds the
 * detail fetch with a recorded npm-view payload — zero spawns, fully hermetic.
 */
async function latestManifest(): Promise<LatestManifest | null> {
  const override = process.env.NMH_UPDATE_LATEST_JSON
  if (typeof override === 'string' && override.length > 0) {
    try {
      const parsed = JSON.parse(await fs.readFile(override, 'utf8')) as Record<string, unknown>
      const version = parsed.version
      if (typeof version !== 'string' || !VERSION_SHAPE.test(version)) return null
      const base = manifestDetailFrom(parsed)
      // a bare {"version"} override has no facts to show — the VIEW SEAM can still fill in,
      // but never a spawn: an override run must stay hermetic (slow-runner hardened)
      const detail = Object.keys(base).length > 0 ? base : await fetchDetail(version, false)
      return { version, detail }
    } catch (err) {
      verboseLog(t('verbose.updateOverrideUnreadable', { detail: err instanceof Error ? err.message : String(err) }))
      return null
    }
  }
  const version = await latestVersionText()
  if (version === null) return null
  return { version, detail: await fetchDetail(version, true) }
}

async function latestVersionText(): Promise<string | null> {
  const view = await runNpm(['view', 'node-modules-hunter', 'version'], 60_000)
  if (view.code !== 0) {
    verboseLog(t('verbose.npmViewFailed', { code: view.code, stderr: view.stderr.trim().slice(0, 200) }))
    return null
  }
  const version = view.stdout.trim()
  return VERSION_SHAPE.test(version) ? version : null
}

/** npm view has shipped both single objects and arrays for the same query — accept every shape. */
function manifestFromView(raw: unknown): Record<string, unknown> | null {
  if (Array.isArray(raw)) {
    const objects = raw.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    return objects.length > 0 ? objects[objects.length - 1] : null
  }
  return raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
}

/** Best-effort: --info keeps working (facts minus detail) when this fetch or its shape falters.
 * `allowSpawn=false` (override runs) reads ONLY the seam file — the run stays hermetic. */
async function fetchDetail(version: string, allowSpawn: boolean): Promise<UpdateDetail> {
  const seam = process.env.NMH_UPDATE_VIEW_JSON
  let raw: unknown = null
  if (typeof seam === 'string' && seam.length > 0) {
    try {
      raw = JSON.parse(await fs.readFile(seam, 'utf8'))
    } catch {
      return {}
    }
  } else {
    if (!allowSpawn) return {}
    const view = await runNpm(['view', `node-modules-hunter@${version}`, '--json'], 60_000)
    if (view.code !== 0) return {}
    try {
      raw = JSON.parse(view.stdout)
    } catch {
      return {}
    }
  }
  const manifest = manifestFromView(raw)
  if (manifest === null) return {}
  const detail = manifestDetailFrom(manifest)
  if (typeof seam !== 'string' || seam.length === 0) detail.publishedAt = await publishedTime(version)
  return detail
}

/** Publish time of the latest release — best-effort (`npm view <pkg> time`), failure is silent. */
async function publishedTime(version: string): Promise<string | undefined> {
  const times = await runNpm(['view', 'node-modules-hunter', 'time', '--json'], 30_000)
  if (times.code !== 0) return undefined
  try {
    const parsed = JSON.parse(times.stdout) as Record<string, unknown>
    return typeof parsed[version] === 'string' ? (parsed[version] as string) : undefined
  } catch {
    return undefined
  }
}

/** True when this package is installed as an npm global (per the user's npm prefix). */
async function isNpmGlobal(): Promise<boolean> {
  // Test/MCI seam (the NMH-* escape-hatch family): '1' = global, '0' = not — skips the
  // npm spawn entirely so update tests stay hermetic on slow, parallel-loaded machines.
  const forced = process.env.NMH_UPDATE_GLOBAL
  if (forced === '1') return true
  if (forced === '0') return false
  const ls = await runNpm(['ls', '-g', 'node-modules-hunter', '--depth=0'], 60_000)
  return ls.code === 0 && ls.stdout.includes('node-modules-hunter')
}

/**
 * Every published dist-tag as `name → version` (v1.4). The test seam
 * NMH_UPDATE_DIST_TAGS_JSON points at a recorded `npm view … dist-tags --json`
 * payload — zero spawns, fully hermetic, mirroring the NMH_UPDATE_LATEST_JSON pattern.
 * `allowSpawn=false` (override runs) reads ONLY the seam. Returns null when nothing
 * readable came back — callers fall back to the latest-manifest version for `latest`.
 */
async function distTagsMap(allowSpawn: boolean): Promise<Record<string, string> | null> {
  const collect = (raw: unknown): Record<string, string> | null => {
    // npm ≥12 prints `npm view <pkg> dist-tags --json` as an ABBREVIATED PACKUMENT
    // ARRAY (one object inside) — the same shape trap the v1.2.1 hotfix fixed for
    // `npm view <pkg> --json`; accept both shapes, last object wins.
    let source: unknown = raw
    if (Array.isArray(raw)) {
      const objects = raw.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      if (objects.length === 0) return null
      source = objects[objects.length - 1]
    }
    if (source === null || typeof source !== 'object' || Array.isArray(source)) return null
    const out: Record<string, string> = {}
    for (const [name, version] of Object.entries(source as Record<string, unknown>)) {
      if (typeof version === 'string' && VERSION_SHAPE.test(version)) out[name] = version
    }
    return Object.keys(out).length > 0 ? out : null
  }
  const seam = process.env.NMH_UPDATE_DIST_TAGS_JSON
  if (typeof seam === 'string' && seam.length > 0) {
    try {
      return collect(JSON.parse(await fs.readFile(seam, 'utf8')))
    } catch {
      return null
    }
  }
  if (!allowSpawn) return null
  const view = await runNpm(['view', 'node-modules-hunter', 'dist-tags', '--json'], 60_000)
  if (view.code !== 0) return null
  try {
    return collect(JSON.parse(view.stdout))
  } catch {
    return null
  }
}

/**
 * The self-update step. Real installs go through `npm install -g`; tests can point
 * NMH_UPDATE_FAKE_INSTALL at a writable file — the exact command is recorded there
 * and the install "succeeds" without touching the network or the machine.
 */
async function installLatest(version: string): Promise<{ ok: boolean; detail: string }> {
  const installCommand = `npm install -g node-modules-hunter@${version}`
  const fake = process.env.NMH_UPDATE_FAKE_INSTALL
  if (typeof fake === 'string' && fake.length > 0) {
    try {
      await fs.writeFile(fake, `${installCommand}\n`, 'utf8')
      return { ok: true, detail: installCommand }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }
  spinUpdate(t('update.spin'))
  const install = await runNpm(['install', '-g', 'node-modules-hunter@' + version], 300_000)
  spinClear()
  if (install.code !== 0) {
    return { ok: false, detail: install.stderr.trim().slice(0, 300) || t('update.err.npmExit', { code: install.code }) }
  }
  return { ok: true, detail: installCommand }
}

function renderInfo(current: string, manifest: LatestManifest, updateAvailable: boolean, global: boolean, distTags: Record<string, string> | null): string[] {
  const d = manifest.detail
  const rows = [
    t('update.info.installed', { value: current }),
    t('update.info.latest', { value: manifest.version }),
    t('update.info.update', {
      value: updateAvailable
        ? t('update.info.available') + (global ? '' : t('update.info.availableNonGlobal'))
        : t('update.info.none'),
    }),
  ]
  if (distTags !== null) {
    const tags = Object.entries(distTags).map(([name, version]) => `${name}=${version}`).join(', ')
    rows.push(t('update.info.tags', { tags }))
  }
  if (d.description !== undefined) rows.push(t('update.info.summary', { value: d.description }))
  if (d.tarball !== undefined) {
    const size = d.unpackedSize === undefined ? '' : t('update.info.sizeSuffix', { size: d.unpackedSize, files: d.fileCount === undefined ? '' : `, ${d.fileCount}` })
    rows.push(t('update.info.tarball', { value: d.tarball }) + size)
  }
  if (d.engines !== undefined) rows.push(t('update.info.engines', { value: d.engines }))
  if (d.license !== undefined) rows.push(t('update.info.license', { value: d.license }))
  if (d.publishedAt !== undefined) rows.push(t('update.info.published', { value: d.publishedAt }))
  return rows
}

/**
 * `nmh update` — v1.1 made it explicit (typed on purpose); v1.2 makes it *consented*:
 * the plain run shows the facts and asks before installing (TTY confirm; non-TTY and
 * --json need -y or -n on the command line, mirroring the delete protocol). --check and
 * --info are read-only views that never install. --force skips the ask — but an
 * already-latest install is checked and left alone, never blindly reinstalled.
 * v1.4 adds dist-tags: --tag <name> (and `--check [tag]`, rc updateTag) reads any tag —
 * a tag pointing below the installed version becomes a *downgrade*, which gets the same
 * consent gate as an upgrade but defaults to NO on the TTY confirm. A tag pointing at
 * the installed version is `current`: facts, no install.
 * Exit 0 when up-to-date, declined, or updated; 1 when the registry or install fails.
 */
export async function runUpdate(request: UpdateRequest): Promise<number> {
  const current = toolVersion()
  const tag = request.tag ?? 'latest'
  if (!isValidDistTag(tag)) {
    const message = t('update.err.invalidTag', { value: tag })
    errorLog(request.json ? message : `⚠ ${message}`)
    return 1
  }

  const manifest = await latestManifest()
  if (manifest === null) {
    const message = t('update.err.noRegistry')
    if (request.json) errorLog(message)
    else errorLog(`⚠ ${message}`)
    return 1
  }

  // dist-tags decide which version the run reads (v1.4). An override run (LATEST_JSON
  // set) must stay hermetic — no spawns, so a non-latest tag without a DIST_TAGS_JSON
  // seam is a registry failure, not a silent fallback to latest.
  const hermetic = typeof process.env.NMH_UPDATE_LATEST_JSON === 'string' && process.env.NMH_UPDATE_LATEST_JSON.length > 0
  const distTags = await distTagsMap(!hermetic)
  let target: string
  if (tag === 'latest') {
    target = distTags?.latest ?? manifest.version
  } else if (distTags !== null && typeof distTags[tag] === 'string') {
    target = distTags[tag]
  } else if (distTags === null) {
    const message = t('update.err.noRegistry')
    if (request.json) errorLog(message)
    else errorLog(`⚠ ${message}`)
    return 1
  } else {
    const tags = Object.keys(distTags).join(', ')
    const message = t('update.err.tagUnknown', { tag, tags })
    if (request.json) errorLog(message)
    else errorLog(`⚠ ${message}`)
    return 1
  }

  const latest = manifest.version
  const global = await isNpmGlobal()
  const method: UpdateResult['method'] = global ? 'npm-global' : 'manual'
  const direction: UpdateDirection = isNewer(current, target) ? 'upgrade' : isNewer(target, current) ? 'downgrade' : 'current'
  const updateAvailable = direction === 'upgrade'
  const result = (updated: boolean): UpdateResult => ({ current, latest, updated, method, updateAvailable, tag, target, direction })

  // --info: the npm-view-style read-out — facts only, never an install (stdout: pipeable)
  if (request.mode === 'info') {
    if (request.json) payload(JSON.stringify({ ...result(false), distTags: distTags ?? undefined, detail: manifest.detail }, null, 2))
    else log([t('update.info.title'), ...renderInfo(current, manifest, updateAvailable, global, distTags)].join('\n'))
    return 0
  }

  // --check: the compact compare for scripts/CI — newest or not, exit 0 either way
  if (request.mode === 'check') {
    const onTag = tag === 'latest' ? '' : ` ${t('update.check.onTag', { tag })}`
    if (request.json) payload(JSON.stringify(result(false), null, 2))
    else if (updateAvailable) log(t('update.check.available', { current, latest: target }) + onTag)
    else log(t('update.check.latest', { current, latest: target }) + onTag)
    return 0
  }

  if (direction === 'current') {
    // --force on an already-current install: checked, reported, NOT reinstalled (v1.2 decision)
    if (request.json) payload(JSON.stringify(result(false), null, 2))
    else log(t('update.latestNoInstall', { current, latest: target }))
    return 0
  }

  if (!global) {
    const advice = [
      t('update.manual.title', { current }),
      t('update.manual.command'),
    ]
    if (request.json) payload(JSON.stringify(result(false), null, 2))
    else for (const line of advice) note(line)
    return 0
  }

  // consent gate (v1.2, v1.4): -y installs, -n declines, otherwise ask on a TTY —
  // non-TTY/--json without an answer refuse loud, exactly like a delete without -y.
  // A downgrade defaults to NO on the ask (overwriting a newer install is never the
  // obvious move); --force still skips the ask in both directions.
  let install = request.force || request.answer === 'yes'
  if (!install && request.answer === 'none') {
    if (request.json || !isTTYOut()) {
      errorLog(t('update.err.needsAnswer'))
      return 1
    }
    const admitted = await confirm({
      message: direction === 'downgrade'
        ? t('update.confirm.downgrade', { current, target, tag })
        : t('update.confirm', { current, latest: target }),
      initialValue: direction !== 'downgrade',
    })
    install = admitted === true
  }

  if (!install) {
    if (request.json) payload(JSON.stringify(result(false), null, 2))
    else log(t('update.declined', { current, latest: target }))
    return 0
  }

  const installation = await installLatest(target)
  if (!installation.ok) {
    errorLog(t('update.err.failed', { detail: installation.detail }))
    errorLog(t('update.err.manualHint', { latest: target }))
    return 1
  }

  if (request.json) payload(JSON.stringify(result(true), null, 2))
  else log(t('update.done', { current, latest: target }))
  return 0
}
