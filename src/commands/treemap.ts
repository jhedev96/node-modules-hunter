import fs from 'node:fs/promises'
import path from 'node:path'
import { collectMap } from './map.ts'
import { log, warn, verboseLog } from '../utils/logger.ts'
import { renderTreemapHtml, type TreemapData } from '../core/treemap.ts'

export interface TreemapRequest {
  targets: string[]
  cwd: string
  maxDepth?: number
  recursive: boolean
  excludes?: string[]
  keep?: string[]
  pmFilter?: string[]
  /** Where to write the single-file HTML (default nmh-treemap.html). */
  out: string
  /** Print the treemap data as JSON instead of writing a file. */
  json: boolean
}

/** `nmh treemap` (PRD §8.6 #1): one self-contained HTML treemap of who eats the disk. */
export async function runTreemap(request: TreemapRequest): Promise<number> {
  const map = await collectMap({
    targets: request.targets,
    cwd: request.cwd,
    maxDepth: request.maxDepth,
    recursive: request.recursive,
    excludes: request.excludes,
    keep: request.keep,
    pmFilter: request.pmFilter,
  })

  const entries = map.projects.map((project) => ({
    label: project.project ?? project.entry.displayPath,
    displayPath: project.entry.displayPath,
    pm: project.entry.pm.family,
    size: project.entry.size,
    packages: project.topPackages.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      size: pkg.size,
      symlinked: pkg.symlinked,
    })),
  }))
  const data: TreemapData = {
    generatedAt: new Date().toISOString(),
    cwd: request.cwd,
    totalSize: entries.reduce((sum, entry) => sum + entry.size, 0),
    entries,
  }

  if (request.json) {
    log(JSON.stringify(data))
    return entries.length === 0 ? 2 : 0
  }

  if (entries.length === 0) {
    warn('no node_modules found — nothing to draw here 🙃')
    return 2
  }

  const outPath = path.resolve(request.cwd, request.out)
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await fs.writeFile(outPath, renderTreemapHtml(data), 'utf8')
  verboseLog(`treemap data: ${entries.length} entries, ${entries.reduce((sum, entry) => sum + entry.packages.length, 0)} packages`)
  log(`🗺️ treemap → ${outPath} — buka di browser, hover cell buat detail`)
  return 0
}
