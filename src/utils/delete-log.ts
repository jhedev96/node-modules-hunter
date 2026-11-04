import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { verboseLog } from './logger.ts'
import { toolVersion } from './version.ts'
import { expandTilde } from './paths.ts'
import { t } from '../i18n/index.ts'
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
  /** v1.1 additive: nmh-internal trash batch dir when the nmh trash was used. */
  trashBatch?: string
  /** v1.1 additive: --trash=system fell back to the nmh trash. */
  trashFallback?: boolean
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
        // v1.1 additive: which trash took it (system | nmh) — trash rows only
        ...(row.backend !== undefined ? { backend: row.backend } : {}),
      })),
      // v1.1 additive: nmh-trash batch dir / fallback marker when applicable
      ...(payload.trashBatch !== undefined ? { trashBatch: payload.trashBatch } : {}),
      ...(payload.trashFallback === true ? { trashFallback: true } : {}),
    }
    await fs.writeFile(file, JSON.stringify(body, null, 2))
    return file
  } catch (err) {
    verboseLog(t('verbose.deleteLogUnavailable', { detail: err instanceof Error ? err.message : String(err) }))
    return null
  }
}
