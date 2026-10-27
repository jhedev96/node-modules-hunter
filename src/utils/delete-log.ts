import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { verboseLog } from './logger.ts'
import { toolVersion } from './version.ts'
import { expandTilde } from './paths.ts'
import type { DeleteMode, DeleteOutcomeRow } from '../core/result.ts'

/** Overridden by `logDir` in .nmhrc (see cli.ts); empty = default ~/.nmh/logs. */
let logDirectoryOverride: string | null = null

export function setLogDirectory(dir: string): void {
  logDirectoryOverride = expandTilde(dir)
}

export interface DeleteLogPayload {
  mode: DeleteMode
  results: DeleteOutcomeRow[]
  freed: number
  deleted: number
  failed: number
}

/**
 * Atomic-ish delete log under ~/.nmh/logs/ — the recovery reference (PRD §6.7).
 * Best effort: a failed log never breaks the delete itself.
 */
export async function writeDeleteLog(payload: DeleteLogPayload): Promise<string | null> {
  const dir = logDirectoryOverride ?? path.join(homedir(), '.nmh', 'logs')
  try {
    await fs.mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    // v0.9.4: a random suffix — two deletes inside the same millisecond used to overwrite one log
    const file = path.join(dir, `delete-${stamp}-${randomBytes(3).toString('hex')}.json`)
    const body = {
      nmh: toolVersion(),
      timestamp: new Date().toISOString(),
      ...payload,
      entries: payload.results.map((row) => ({
        path: row.path,
        status: row.status,
        error: row.error ?? null,
      })),
    }
    await fs.writeFile(file, JSON.stringify(body, null, 2))
    return file
  } catch (err) {
    verboseLog(`delete log unavailable: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
