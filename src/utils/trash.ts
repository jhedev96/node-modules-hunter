import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'

const execFileAsync = promisify(execFile)

/**
 * Trash backends are the platform facilities themselves (COM / Finder / gio / trash-cli) —
 * no extra dependency in core (PRD §11 zero-dep principle). On a Linux box without gio
 * or trash-cli we refuse clearly instead of silently falling back to hard delete.
 */
export type TrashBackend = 'windows-com' | 'macos-finder' | 'linux-gio' | 'linux-trash-cli' | 'none'

export async function trashBackend(): Promise<TrashBackend> {
  // Test/MCI escape hatch (the NMH_REGISTRY_JSON family): force a backend decision instead
  // of discovery — 'none' lets tests exercise the nmh-trash fallback without an exotic box.
  const forced = process.env.NMH_TRASH_BACKEND
  if (
    forced === 'windows-com' ||
    forced === 'macos-finder' ||
    forced === 'linux-gio' ||
    forced === 'linux-trash-cli' ||
    forced === 'none'
  ) {
    return forced
  }
  switch (process.platform) {
    case 'win32':
      return 'windows-com'
    case 'darwin':
      return 'macos-finder'
    case 'linux':
      if (await commandExists('gio')) return 'linux-gio'
      if (await commandExists('trash-put')) return 'linux-trash-cli'
      return 'none'
    default:
      return 'none'
  }
}

export class TrashUnavailableError extends Error {
  constructor() {
    super('no trash backend available on this platform — install `gio` (gvfs) or `trash-cli`, or use --delete=hard')
    this.name = 'TrashUnavailableError'
  }
}

/** Move paths to the OS trash. Throws on backend missing or any failed path. */
export async function moveToTrash(paths: string[], backend: TrashBackend): Promise<void> {
  if (backend === 'none') throw new TrashUnavailableError()

  for (const p of paths) {
    switch (backend) {
      case 'windows-com':
        await trashWindows(p)
        break
      case 'macos-finder':
        await trashMacos(p)
        break
      case 'linux-gio':
        await run('gio', ['trash', p], 120_000)
        break
      case 'linux-trash-cli':
        await run('trash-put', [p], 120_000)
        break
      default:
        throw new TrashUnavailableError()
    }
  }
}

const POWERSHELL_SCRIPT_TEMPLATE =
  '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory({{PATH}}, \'OnlyErrorDialogs\', \'SendToRecycleBin\')'

async function trashWindows(target: string): Promise<void> {
  const script = POWERSHELL_SCRIPT_TEMPLATE.replace(
    '{{PATH}}',
    `'${target.replace(/'/g, "''")}'`,
  )
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 120_000)
}

async function trashMacos(p: string): Promise<void> {
  await run(
    'osascript',
    [
      '-e',
      'on run argv',
      '-e',
      'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)',
      '-e',
      'end run',
      p,
    ],
    120_000,
  )
}

async function run(bin: string, args: string[], timeout: number): Promise<void> {
  try {
    await execFileAsync(bin, args, { timeout, windowsHide: true })
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? ''
    const message = stderr.trim().split('\n').slice(-3).join(' · ') || String(err)
    throw new Error(`${bin}: ${message.slice(0, 400)}`)
  }
}

async function commandExists(bin: string): Promise<boolean> {
  try {
    await execFileAsync('sh', ['-c', `command -v ${bin}`], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

/**
 * v1.1 nmh-internal trash: one batch dir per run under `~/.nmh/trash/`, each victim
 * stored as `<parent>-node_modules-<hex3>` to survive same-name collisions, and a
 * `manifest.jsonl` row per moved folder recording the original path for restore.
 * Everything lives under the user's HOME — restorable by moving folders back.
 */
export async function createTrashBatch(home?: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const hex = Math.random().toString(16).slice(2, 5)
  const batchDir = path.join(home ?? homedir(), '.nmh', 'trash', `trash-${stamp}-${hex}`)
  await fs.mkdir(batchDir, { recursive: true })
  return batchDir
}

/** Move one folder into the batch dir; returns the name it was stored under. */
export async function nmhTrashMove(entryPath: string, batchDir: string): Promise<string> {
  const parent = path.basename(path.dirname(entryPath))
  const storedAs = `${parent}-node_modules-${Math.random().toString(16).slice(2, 5)}`
  const destination = path.join(batchDir, storedAs)
  try {
    // rename first: instant on the same device, never follows symlinks
    await fs.rename(entryPath, destination)
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== 'EXDEV') throw err
    // cross-device: copy WITHOUT dereferencing symlinks (the never-follow rule), then remove
    await fs.cp(entryPath, destination, { recursive: true, dereference: false, verbatimSymlinks: true })
    await fs.rm(entryPath, { recursive: true, force: true })
  }
  return storedAs
}

export interface TrashManifestRow {
  originalPath: string
  storedAs: string
  size: number
  trashedAt: string
  nmh: string
  via: 'explicit' | 'fallback'
}

/** Append one restore record to the batch manifest (JSONL — one object per line). */
export async function appendTrashManifest(
  batchDir: string,
  row: TrashManifestRow,
): Promise<void> {
  await fs.appendFile(path.join(batchDir, 'manifest.jsonl'), `${JSON.stringify(row)}\n`, 'utf8')
}
