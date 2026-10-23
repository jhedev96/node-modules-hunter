import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'

/**
 * web → lodash fixture for map/search/stats share shape.
 */
async function fixture(label: string): Promise<string> {
  const root = await tmpRoot(label)
  const web = path.join(root, 'web')
  const pkgDir = path.join(web, 'node_modules', 'lodash')
  await fs.mkdir(pkgDir, { recursive: true })
  await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'lodash', version: '4.17.21' }))
  await fs.writeFile(path.join(web, 'package.json'), JSON.stringify({ name: 'web', version: '1.0.0', dependencies: { lodash: '^4' } }))
  return root
}

describe('save-report expansion (map/search/stats, PRD §5.4 decision #10)', () => {
  it('map writes a stripped table next to the screen print; .text keeps clean text', async () => {
    const root = await fixture('rep-map')
    try {
      const run = await runCli(['map', '.', '--save-report', 'out/map.md'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('web')
      expect(run.stderr).toContain('report saved')
      const saved = await fs.readFile(path.join(root, 'out', 'map.md'), 'utf8')
      expect(saved).toContain('Project')
      expect(saved).toContain('web')
      expect(saved).not.toMatch(/\[/) // no ANSI leftovers in .md
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('search --json writes a parseable JSON payload with command stamp', async () => {
    const root = await fixture('rep-search')
    try {
      const run = await runCli(['search', 'lodash', '.', '--save-report', 'hits.json', '--json'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      const saved = await fs.readFile(path.join(root, 'hits.json'), 'utf8')
      const payload = JSON.parse(saved) as { command?: string; results?: unknown[] }
      expect(payload.command).toBe('search')
      expect(payload.results).toHaveLength(1)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('stats writes the balanced text report (ANSI-free) to .txt', async () => {
    const root = await fixture('rep-stats')
    try {
      const run = await runCli(['stats', '.', '--save-report', 'stats.txt'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      const saved = await fs.readFile(path.join(root, 'stats.txt'), 'utf8')
      expect(saved).toContain('OVERVIEW')
      expect(saved).not.toMatch(/\[/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('bad extension is rejected globally (map too)', async () => {
    const root = await fixture('rep-ext')
    try {
      const run = await runCli(['map', '.', '--save-report', 'x.yaml'], { cwd: root, home: root })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('unknown report format')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('treemap refuses --save-report (its HTML file IS the report)', async () => {
    const root = await fixture('rep-tree')
    try {
      const run = await runCli(['treemap', '.', '--save-report', 'tm.md'], { cwd: root, home: root })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('--save-report')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
