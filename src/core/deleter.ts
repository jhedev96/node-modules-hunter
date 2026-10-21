import fs from 'node:fs/promises'
import { createLimiter } from '../utils/limit.ts'
import { TrashUnavailableError, moveToTrash, trashBackend } from '../utils/trash.ts'
import { isPermissionError } from './walker.ts'
import type { DeleteMode, DeleteOutcome, DeleteOutcomeRow, ScanEntry } from './result.ts'

export interface DeleteRequest {
  mode: DeleteMode
  concurrency?: number
  onRow?: (row: DeleteOutcomeRow, done: number, total: number) => void
}

/**
 * Execute deletion over ScanEntries with bounded parallelism.
 * Hard: fs.rm(recursive, force, retries×3) — does NOT follow symlinks (pnpm-safe).
 * Trash: platform facility via utils/trash; throws TrashUnavailableError when absent.
 */
export async function deleteEntries(
  entries: ScanEntry[],
  request: DeleteRequest,
): Promise<DeleteOutcome> {
  const total = entries.length
  const limiter = createLimiter(request.concurrency ?? 8)
  const rows: DeleteOutcomeRow[] = []
  let done = 0

  const runOne = async (entry: ScanEntry, attempt: () => Promise<string | null>): Promise<void> => {
    const failure = await attempt().catch(
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
    const row: DeleteOutcomeRow = failure
      ? { path: entry.path, size: entry.size, status: 'failed', error: failure }
      : { path: entry.path, size: entry.size, status: request.mode === 'hard' ? 'deleted' : 'trashed' }
    rows.push(row)
    done += 1
    request.onRow?.(row, done, total)
  }

  if (request.mode === 'hard') {
    await Promise.all(entries.map((entry) => limiter(() => runOne(entry, () => removeHard(entry.path)))))
  } else {
    const backend = await trashBackend()
    if (backend === 'none') throw new TrashUnavailableError()
    await Promise.all(
      entries.map((entry) =>
        limiter(() => runOne(entry, () => moveToTrash([entry.path], backend).then(() => null))),
      ),
    )
  }

  const completed = rows.filter((row) => row.status !== 'failed')
  const failedRows = rows.filter((row) => row.status === 'failed')
  return {
    results: rows,
    freed: completed.reduce((sum, row) => sum + row.size, 0),
    deleted: completed.length,
    failed: failedRows.length,
    permissionDenied: failedRows.some((row) => /EACCES|EPERM/.test(row.error ?? '')),
  }
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

export { TrashUnavailableError }
