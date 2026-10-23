import fs from 'node:fs/promises'
import path from 'node:path'

export const REPORT_EXTENSIONS = ['.json', '.md', '.txt'] as const

/** Save a rendered report next to whatever else is printed (PRD §5.4 --save-report). */
export async function saveReportFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath)
  if (dir !== '' && dir !== '.') await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(filePath, content)
}

export interface ReportNote {
  /** Nice "saved" confirmation (logger.note). */
  ok: (message: string) => void
  /** Write failures never abort the run (logger.warn). */
  fail: (message: string) => void
}

/**
 * Shared --save-report persistence for any command that already holds its
 * rendered text (json or stripAnsi'd text). Mirrors scan's writeReport behavior.
 */
export async function writeReportSnapshot(
  filePath: string | undefined,
  content: string,
  notes: ReportNote,
): Promise<void> {
  if (!filePath) return
  const ext = path.extname(filePath).toLowerCase()
  try {
    await saveReportFile(filePath, content + '\n')
    notes.ok(`💾 report saved → ${filePath} (${ext.slice(1)})`)
  } catch (err) {
    notes.fail(`report write failed — continuing (${err instanceof Error ? err.message : String(err)})`)
  }
}
