import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { toolVersion } from '../utils/version.ts'
import { isNewer } from '../utils/update-check.ts'
import { errorLog, log, note, payload, progressLine, clearProgress, verboseLog } from '../utils/logger.ts'

const execFileP = promisify(execFile)

export interface UpdateRequest {
  json: boolean
}

export interface UpdateResult {
  current: string
  latest: string
  updated: boolean
  method: 'npm-global' | 'manual'
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

/**
 * Latest published version. Reads the user's own npm config (registry mirrors
 * included) via `npm view`. Test/MCI escape hatch, mirroring NMH_REGISTRY_JSON:
 * when NMH_UPDATE_LATEST_JSON points to a `{"version": "x.y.z"}` file it wins —
 * update tests stay hermetic, no network, no real install.
 */
async function latestVersion(): Promise<string | null> {
  const override = process.env.NMH_UPDATE_LATEST_JSON
  if (typeof override === 'string' && override.length > 0) {
    try {
      const parsed = JSON.parse(await fs.readFile(override, 'utf8')) as { version?: unknown }
      return typeof parsed.version === 'string' && VERSION_SHAPE.test(parsed.version) ? parsed.version : null
    } catch (err) {
      verboseLog(`update: override file unreadable (${err instanceof Error ? err.message : String(err)})`)
      return null
    }
  }
  const view = await runNpm(['view', 'node-modules-hunter', 'version'], 30_000)
  if (view.code !== 0) {
    verboseLog(`npm view failed (rc ${view.code}): ${view.stderr.trim().slice(0, 200)}`)
    return null
  }
  const version = view.stdout.trim()
  return VERSION_SHAPE.test(version) ? version : null
}

/** True when this package is installed as an npm global (per the user's npm prefix). */
async function isNpmGlobal(): Promise<boolean> {
  const ls = await runNpm(['ls', '-g', 'node-modules-hunter', '--depth=0'], 20_000)
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
  progressLine('⠋ updating via npm…')
  const install = await runNpm(['install', '-g', 'node-modules-hunter@' + version], 300_000)
  clearProgress()
  if (install.code !== 0) {
    return { ok: false, detail: install.stderr.trim().slice(0, 300) || `npm exited ${install.code}` }
  }
  return { ok: true, detail: installCommand }
}

/**
 * `nmh update` (v1.1): explicit self-update — nothing automatic, nothing silent.
 * Exit 0 when up-to-date or updated, 1 when the registry or install fails;
 * non-npm-global installs get manual advice instead of a surprise install.
 */
export async function runUpdate(request: UpdateRequest): Promise<number> {
  const current = toolVersion()
  const latest = await latestVersion()
  if (latest === null) {
    const message = 'cannot read the latest version — is the registry reachable? (npm view node-modules-hunter version)'
    if (request.json) errorLog(message)
    else errorLog(`⚠ ${message}`)
    return 1
  }

  const global = await isNpmGlobal()
  const method: UpdateResult['method'] = global ? 'npm-global' : 'manual'

  if (!isNewer(current, latest)) {
    const result: UpdateResult = { current, latest, updated: false, method }
    if (request.json) payload(JSON.stringify(result, null, 2))
    else log(`nmh ${current} sudah versi terbaru (registry: ${latest}) — tak ada yang diinstall`)
    return 0
  }

  if (!global) {
    const result: UpdateResult = { current, latest, updated: false, method }
    const advice = [
      `nmh ${current} terpasang di luar npm global — update manual:`,
      '  npm i -g node-modules-hunter        (atau: pnpm add -g / bunx / brew upgrade node-modules-hunter)',
    ]
    if (request.json) payload(JSON.stringify(result, null, 2))
    else for (const line of advice) note(line)
    return 0
  }

  const install = await installLatest(latest)
  if (!install.ok) {
    errorLog(`⚠ update gagal: ${install.detail}`)
    errorLog(`  coba manual: npm install -g node-modules-hunter@${latest}`)
    return 1
  }

  const result: UpdateResult = { current, latest, updated: true, method: 'npm-global' }
  if (request.json) payload(JSON.stringify(result, null, 2))
  else log(`✓ terupdate ${current} → ${latest} (npm install -g node-modules-hunter)`)
  return 0
}
