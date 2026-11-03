import fs from 'node:fs/promises'
import { createLimiter } from '../utils/limit.ts'
import {
  appendTrashManifest,
  createTrashBatch,
  moveToTrash,
  nmhTrashMove,
  trashBackend,
} from '../utils/trash.ts'
import { isPermissionError } from './walker.ts'
import { toolVersion } from '../utils/version.ts'
import type { DeleteMode, DeleteOutcome, DeleteOutcomeRow, ScanEntry } from './result.ts'

export interface DeleteRequest {
  mode: DeleteMode
  concurrency?: number
  /**
   * v1.1 --trash: 'system' (default — gio/Finder/Recycle Bin) or 'nmh' (restorable
   * ~/.nmh/trash with a manifest). When 'system' has no backend, the restorable
   * nmh trash takes over LOUDLY instead of the v1.0 hard error.
   */
  trashMode?: 'system' | 'nmh'
  onRow?: (row: DeleteOutcomeRow, done: number, total: number) => void
}

/**
 * Execute deletion over ScanEntries with bounded parallelism.
 * Hard: fs.rm(recursive, force, retries×3) — does NOT follow symlinks (pnpm-safe).
 * Trash: the platform facility via utils/trash, or the restorable nmh-internal
 * trash (explicit --trash=nmh, or fallback when no OS backend exists).
 */
export async function deleteEntries(
  entries: ScanEntry[],
  request: DeleteRequest,
): Promise<DeleteOutcome> {
  const total = entries.length
  const limiter = createLimiter(request.concurrency ?? 8)
  const rows: DeleteOutcomeRow[] = []
  let done = 0

  const runOne = async (
    entry: ScanEntry,
    attempt: () => Promise<string | null>,
    backend?: 'system' | 'nmh',
  ): Promise<void> => {
    const failure = await attempt().catch(
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
    const row: DeleteOutcomeRow = failure
      ? { path: entry.path, size: entry.size, status: 'failed', error: failure }
      : {
          path: entry.path,
          size: entry.size,
          status: request.mode === 'hard' ? 'deleted' : 'trashed',
          ...(backend !== undefined ? { backend } : {}),
        }
    rows.push(row)
    done += 1
    request.onRow?.(row, done, total)
  }

  const outcome: DeleteOutcome = { results: rows, freed: 0, deleted: 0, failed: 0, permissionDenied: false }

  if (request.mode === 'hard') {
    await Promise.all(entries.map((entry) => limiter(() => runOne(entry, () => removeHard(entry.path)))))
  } else {
    const trashMode = request.trashMode ?? 'system'
    const systemBackend = trashMode === 'system' ? await trashBackend() : null
    const useNmhTrash = systemBackend === null || systemBackend === 'none'
    if (useNmhTrash) {
      // The restorable nmh trash: under ~/.nmh/trash/<batch>/, one manifest row per
      // victim — restore is a plain move back. Fallback (OS facility absent) is LOUD,
      // surfaced here and summarized by the command layer.
      const via: 'explicit' | 'fallback' = request.trashMode === 'nmh' ? 'explicit' : 'fallback'
      const batchDir = await createTrashBatch()
      outcome.trashBatch = batchDir
      if (via === 'fallback') outcome.trashFallback = true
      await Promise.all(
        entries.map((entry) =>
          limiter(() =>
            runOne(
              entry,
              async () => {
                const storedAs = await nmhTrashMove(entry.path, batchDir)
                await appendTrashManifest(batchDir, {
                  originalPath: entry.path,
                  storedAs,
                  size: entry.size,
                  trashedAt: new Date().toISOString(),
                  nmh: toolVersion(),
                  via,
                })
                return null
              },
              'nmh',
            ),
          ),
        ),
      )
    } else {
      const backend = systemBackend as Exclude<typeof systemBackend, null | 'none'>
      await Promise.all(
        entries.map((entry) =>
          limiter(() => 
            runOne(entry, () => moveToTrash([entry.path], backend).then(() => null), 'system'),
          ),
        ),
      )
    }
  }

  const completed = rows.filter((row) => row.status !== 'failed')
  const failedRows = rows.filter((row) => row.status === 'failed')
  outcome.freed = completed.reduce((sum, row) => sum + row.size, 0)
  outcome.deleted = completed.length
  outcome.failed = failedRows.length
  outcome.permissionDenied = failedRows.some((row) => /EACCES|EPERM/.test(row.error ?? ''))
  return outcome
}

/** fs.rm handles the Windows retry/backoff story natively via maxRetries (PRD §13). */
async function removeHard(target: string): Promise<string | null> {
  try {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
    return null
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'ERR'
    const message = err instanceof Error ? err.message : String(err)
    return `${code}: ${message}`
  }
}

export { TrashUnavailableError } from '../utils/trash.ts'
