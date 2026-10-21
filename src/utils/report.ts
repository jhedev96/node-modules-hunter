import fs from 'node:fs/promises'
import path from 'node:path'

export const REPORT_EXTENSIONS = ['.json', '.md', '.txt'] as const

/** Save a rendered report next to whatever else is printed (PRD §5.4 --save-report). */
export async function saveReportFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath)
  if (dir !== '' && dir !== '.') await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(filePath, content)
}
