import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Trash backends are the platform facilities themselves (COM / Finder / gio / trash-cli) —
 * no extra dependency in core (PRD §11 zero-dep principle). On a Linux box without gio
 * or trash-cli we refuse clearly instead of silently falling back to hard delete.
 */
export type TrashBackend = 'windows-com' | 'macos-finder' | 'linux-gio' | 'linux-trash-cli' | 'none'

export async function trashBackend(): Promise<TrashBackend> {
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
