import path from 'node:path'
import fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { monorepoFixture, runCli } from './helpers.ts'

interface ScanPayload {
  nmh: string
  command: 'scan'
  totals: { folders: number; packages: number; size: number }
  entries: Array<{ path: string; size: number; packageCount: number; pm: string }>
  unresolvable: string[]
}

describe('scan e2e (spawned CLI, non-TTY)', () => {
  it('returns sorted JSON entries with correct PM detection; nested module is not double-listed', async () => {
    const fx = await monorepoFixture('e2e-scan')
    try {
      const run = await runCli(['scan', fx.root, '--json'])
      expect(run.code).toBe(0)

      const payload = JSON.parse(run.stdout) as ScanPayload
      expect(payload.nmh).toBeTypeOf('string')
      expect(payload.totals.folders).toBe(4)

      const sizes = payload.entries.map((entry) => entry.size)
      expect(sizes).toEqual([...sizes].sort((a, b) => b - a))

      const web = payload.entries.find((entry) => entry.path === fx.paths.webEntry)
      expect(web?.pm).toBe('pnpm')
      expect(web?.packageCount).toBe(3)

      expect(payload.entries.some((entry) => entry.path.includes('nested'))).toBe(false)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('positional path behaves like scan', async () => {
    const fx = await monorepoFixture('e2e-positional')
    try {
      const run = await runCli([fx.root, '--json'])
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as ScanPayload
      expect(payload.totals.folders).toBe(4)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('nothing found → exit 2 with both text and JSON honesty', async () => {
    const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'nmh-empty-'))
    try {
      const text = await runCli(['scan', dir])
      expect(text.code).toBe(2)
      expect(text.stderr).toContain('no node_modules found')

      const json = await runCli(['scan', dir, '--json'])
      expect(json.code).toBe(2)
      expect((JSON.parse(json.stdout) as ScanPayload).totals.folders).toBe(0)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('unmatched glob warns and exits 2', async () => {
    const run = await runCli(['scan', '/nonexistent-nmh-glob-*/x'])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('no match for pattern')
  })

  it('--size total prints just the aggregate line', async () => {
    const fx = await monorepoFixture('e2e-total')
    try {
      const run = await runCli(['scan', fx.root, '--size', 'total'])
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('Total:')
      expect(run.stdout).not.toContain('│')
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })
})
