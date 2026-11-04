import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { confirm, isCancel } from '@clack/prompts'
import { toolVersion } from '../utils/version.ts'
import { isNewer } from '../utils/update-check.ts'
import { errorLog, log, note, payload, spinUpdate, spinClear, verboseLog, isTTYOut } from '../utils/logger.ts'
import { formatBytes } from '../utils/format.ts'

const execFileP = promisify(execFile)

/** v1.2: how the update run should behave — two read-only views plus the deciding default. */
export type UpdateMode = 'check' | 'info' | 'default'
/** v1.2: -y / -n on the CLI; 'none' = ask interactively (TTY) or refuse (non-TTY/--json). */
export type UpdateAnswer = 'yes' | 'no' | 'none'

export interface UpdateRequest {
  json: boolean
  mode: UpdateMode
  answer: UpdateAnswer
  /** -f/--force: install without asking when an update exists — never reinstalls a latest version. */
  force: boolean
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
 * Latest published version + registry facts. Reads the user's own npm config (registry
 * mirrors included) via `npm view --json`. Test/MCI escape hatch, mirroring the NMH-*
 * family: when NMH_UPDATE_LATEST_JSON points to a JSON file it wins entirely (no spawn,
 * no network) — extra npm-view fields in it feed `--info`; a bare {"version":"x.y.z"}
 * keeps the v1.1 shape working.
 */
async function latestManifest(): Promise<LatestManifest | null> {
  const override = process.env.NMH_UPDATE_LATEST_JSON
  if (typeof override === 'string' && override.length > 0) {
    try {
      const parsed = JSON.parse(await fs.readFile(override, 'utf8')) as Record<string, unknown>
      const version = parsed.version
      if (typeof version !== 'string' || !VERSION_SHAPE.test(version)) return null
      return { version, detail: manifestDetailFrom(parsed) }
    } catch (err) {
      verboseLog(`update: override file unreadable (${err instanceof Error ? err.message : String(err)})`)
      return null
    }
  }
  const view = await runNpm(['view', 'node-modules-hunter', '--json'], 60_000)
  if (view.code !== 0) {
    verboseLog(`npm view failed (rc ${view.code}): ${view.stderr.trim().slice(0, 200)}`)
    return null
  }
  try {
    const parsed = JSON.parse(view.stdout) as Record<string, unknown>
    const version = parsed.version
    if (typeof version !== 'string' || !VERSION_SHAPE.test(version)) return null
    const detail = manifestDetailFrom(parsed)
    detail.publishedAt = await publishedTime(version)
    return { version, detail }
  } catch {
    return null
  }
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
  spinUpdate('updating via npm…')
  const install = await runNpm(['install', '-g', 'node-modules-hunter@' + version], 300_000)
  spinClear()
  if (install.code !== 0) {
    return { ok: false, detail: install.stderr.trim().slice(0, 300) || `npm exited ${install.code}` }
  }
  return { ok: true, detail: installCommand }
}

function renderInfo(current: string, manifest: LatestManifest, updateAvailable: boolean, global: boolean): string[] {
  const d = manifest.detail
  const rows = [
    `installed   ${current}`,
    `latest      ${manifest.version}`,
    `update      ${updateAvailable ? `tersedia — jalankan \`nmh update\`${global ? '' : ' (atau: npm i -g node-modules-hunter)'}` : 'tidak ada — ini versi terbaru'}`,
  ]
  if (d.description !== undefined) rows.push(`summary     ${d.description}`)
  if (d.tarball !== undefined) {
    const size = d.unpackedSize === undefined ? '' : ` (${d.unpackedSize}${d.fileCount === undefined ? '' : `, ${d.fileCount} files`})`
    rows.push(`tarball     ${d.tarball}${size}`)
  }
  if (d.engines !== undefined) rows.push(`engines     node ${d.engines}`)
  if (d.license !== undefined) rows.push(`license     ${d.license}`)
  if (d.publishedAt !== undefined) rows.push(`published   ${d.publishedAt}`)
  return rows
}

/**
 * `nmh update` — v1.1 made it explicit (typed on purpose); v1.2 makes it *consented*:
 * the plain run shows the facts and asks before installing (TTY confirm; non-TTY and
 * --json need -y or -n on the command line, mirroring the delete protocol). --check and
 * --info are read-only views that never install. --force skips the ask — but an
 * already-latest install is checked and left alone, never blindly reinstalled.
 * Exit 0 when up-to-date, declined, or updated; 1 when the registry or install fails.
 */
export async function runUpdate(request: UpdateRequest): Promise<number> {
  const current = toolVersion()
  const manifest = await latestManifest()
  if (manifest === null) {
    const message = 'cannot read the latest version — is the registry reachable? (npm view node-modules-hunter version)'
    if (request.json) errorLog(message)
    else errorLog(`⚠ ${message}`)
    return 1
  }

  const latest = manifest.version
  const global = await isNpmGlobal()
  const method: UpdateResult['method'] = global ? 'npm-global' : 'manual'
  const updateAvailable = isNewer(current, latest)
  const result = (updated: boolean): UpdateResult => ({ current, latest, updated, method, updateAvailable })

  // --info: the npm-view-style read-out — facts only, never an install (stdout: pipeable)
  if (request.mode === 'info') {
    if (request.json) payload(JSON.stringify({ ...result(false), detail: manifest.detail }, null, 2))
    else log(['nmh update — info registry (npm view node-modules-hunter)', ...renderInfo(current, manifest, updateAvailable, global)].join('\n'))
    return 0
  }

  // --check: the compact compare for scripts/CI — newest or not, exit 0 either way
  if (request.mode === 'check') {
    if (request.json) payload(JSON.stringify(result(false), null, 2))
    else if (updateAvailable) log(`↑ update tersedia: ${current} → ${latest} — jalankan \`nmh update\` untuk menginstall`)
    else log(`✓ nmh ${current} sudah versi terbaru (registry: ${latest})`)
    return 0
  }

  if (!updateAvailable) {
    // --force on an already-latest install: checked, reported, NOT reinstalled (v1.2 decision)
    if (request.json) payload(JSON.stringify(result(false), null, 2))
    else log(`✓ nmh ${current} sudah versi terbaru (registry: ${latest}) — tak ada yang diinstall`)
    return 0
  }

  if (!global) {
    const advice = [
      `nmh ${current} terpasang di luar npm global — update manual:`,
      '  npm i -g node-modules-hunter        (atau: pnpm add -g / bunx / brew upgrade node-modules-hunter)',
    ]
    if (request.json) payload(JSON.stringify(result(false), null, 2))
    else for (const line of advice) note(line)
    return 0
  }

  // consent gate (v1.2): -y installs, -n declines, otherwise ask on a TTY —
  // non-TTY/--json without an answer refuse loud, exactly like a delete without -y
  let install = request.force || request.answer === 'yes'
  if (!install && request.answer === 'none') {
    if (request.json || !isTTYOut()) {
      errorLog('update butuh jawaban eksplisit — -y untuk menginstall, -n untuk menolak (--check/--info untuk lihat saja)')
      return 1
    }
    const admitted = await confirm({
      message: `Update nmh ${current} → ${latest} via npm install -g?`,
      initialValue: true,
    })
    install = admitted === true
  }

  if (!install) {
    if (request.json) payload(JSON.stringify(result(false), null, 2))
    else log(`✕ tetap nmh ${current} — update ke ${latest} tidak diinstall`)
    return 0
  }

  const installation = await installLatest(latest)
  if (!installation.ok) {
    errorLog(`⚠ update gagal: ${installation.detail}`)
    errorLog(`  coba manual: npm install -g node-modules-hunter@${latest}`)
    return 1
  }

  if (request.json) payload(JSON.stringify(result(true), null, 2))
  else log(`✓ terupdate ${current} → ${latest} (npm install -g node-modules-hunter)`)
  return 0
}
