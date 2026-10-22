import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'

interface TypePayload {
  mode: string
  typeBreakdown: Array<{ field: string; size: number; packages: number }>
}

/**
 * One project, every fact row: dependency (zod), devDependency (jest),
 * optional (maybe), peer (peerfix) + an undeclared transitive (ghost).
 */
async function fixture(label: string): Promise<string> {
  const root = await tmpRoot(label)
  const web = path.join(root, 'web', 'node_modules')
  for (const name of ['zod', 'jest', 'maybe', 'peerfix', 'ghost']) {
    await fs.mkdir(path.join(web, name), { recursive: true })
    await fs.writeFile(path.join(web, name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    await fs.writeFile(path.join(web, name, 'blob.bin'), 'x'.repeat(1000))
  }
  await fs.writeFile(
    path.join(root, 'web', 'package.json'),
    JSON.stringify({
      name: 'web',
      version: '1.0.0',
      dependencies: { zod: '^3.0.0' },
      devDependencies: { jest: '^29.0.0' },
      optionalDependencies: { maybe: '^1.0.0' },
      peerDependencies: { peerfix: '^1.0.0' },
    }),
  )
  return root
}

describe('stats --by type e2e (dependency-group breakdown, PRD §8.1)', () => {
  it('json: canonical bucket order with per-field sizes/counts, zero buckets kept', async () => {
    const root = await fixture('bt-json')
    try {
      const run = await runCli(['stats', '.', '--by', 'type', '--json'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as TypePayload
      expect(payload.mode).toBe('type')
      const fields = payload.typeBreakdown.map((row) => row.field)
      expect(fields).toEqual(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'transitive'])
      for (const row of payload.typeBreakdown) {
        expect(row.packages).toBe(1) // one instance per bucket in this fixture
        expect(row.size).toBeGreaterThan(1000) // blob (1000 B) + its package.json
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('text: focused view hides TOP/LONG TAIL, prints BY TYPE rows, skips zero buckets, no v0.4 warning', async () => {
    const root = await fixture('bt-text')
    try {
      const run = await runCli(['stats', '.', '--by', 'type'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('BY TYPE')
      expect(run.stdout).toContain('dependencies          :')
      expect(run.stdout).toContain('transitive            :')
      expect(run.stdout).not.toContain('TOP 10 SIZE')
      expect(run.stdout).not.toContain('LONG TAIL')
      expect(run.stdout).not.toContain('DEDUP SUGGESTION')
      expect(run.stderr).not.toContain('v0.4')

      // buckets with nothing in them vanish from the text view
      const minimal = await tmpRoot('bt-zero')
      try {
        await fs.mkdir(path.join(minimal, 'p', 'node_modules', 'zod'), { recursive: true })
        await fs.writeFile(path.join(minimal, 'p', 'package.json'), '{"name":"p","version":"1.0.0","dependencies":{"zod":"^3.0.0"}}')
        await fs.writeFile(path.join(minimal, 'p', 'node_modules', 'zod', 'package.json'), '{"name":"zod","version":"3.0.0"}')
        const zeroRun = await runCli(['stats', '.', '--by', 'type'], { cwd: minimal, home: minimal })
        expect(zeroRun.stdout).toContain('BY TYPE')
        expect(zeroRun.stdout).not.toContain('optionalDependencies')
        expect(zeroRun.stdout).not.toContain('peerDependencies')
      } finally {
        await fs.rm(minimal, { recursive: true, force: true })
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('without --by size mode stays the classic size report (TOP list) — no static fallback ever', async () => {
    const root = await fixture('bt-plain')
    try {
      const run = await runCli(['stats', '.'], { cwd: root, home: root })
      expect(run.stdout).toContain('TOP 10 SIZE')
      expect(run.stdout).not.toContain('BY TYPE')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
