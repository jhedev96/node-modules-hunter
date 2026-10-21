import { deleteFlow } from './delete.ts'
import type { DeleteMode } from '../core/result.ts'

export interface CleanRequest {
  targets: string[]
  cwd: string
  /** default trash (safe first, PRD §6.6); --delete=hard opts into permanence. */
  mode: DeleteMode | null
  dryRun: boolean
  assumeYes: boolean
  json: boolean
}

/**
 * `nmh clean [dirs]` — scan then delete EVERYTHING safe that was found.
 * Wizard-style "hapus semua", sugar over the delete flow with filter semantics.
 */
export async function runClean(request: CleanRequest): Promise<number> {
  return deleteFlow({
    targets: request.targets,
    cwd: request.cwd,
    mode: request.mode ?? 'trash',
    dryRun: request.dryRun,
    assumeYes: request.assumeYes,
    json: request.json,
    blockedMode: 'filter',
  })
}
