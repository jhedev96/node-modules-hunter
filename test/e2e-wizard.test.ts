import fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot, vpFixture } from './helpers.ts'

interface ScanPayload {
  nmh: string
  command: 'scan'
  totals: { folders: number; size: number }
  entries: Array<{ path: string; size: number; pm: string }>
}

describe('wizard e2e (no args, spawned CLI, non-TTY)', () => {
  it('non-TTY fallback: compact banner + read-only scan + TTY pointer, exit 0', async () => {
    const fx = await vpFixture('e2e-wiz')
    try {
      const run = await runCli([], { cwd: fx.root })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('node-modules-hunter v')
      expect(run.stdout).toContain('app/node_modules')
      expect(run.stderr).toContain('needs a TTY')
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('non-TTY fallback with --json: bare scan payload, no banner, no scan prose', async () => {
    const fx = await vpFixture('e2e-wiz-json')
    try {
      const run = await runCli(['--json'], { cwd: fx.root })
      expect(run.code).toBe(0)
      expect(run.stdout).not.toContain('🐉')
      expect(run.stdout).not.toContain('needs a TTY')

      const payload = JSON.parse(run.stdout) as ScanPayload
      expect(payload.command).toBe('scan')
      expect(payload.totals.folders).toBe(1)
      expect(run.stderr).toContain('needs a TTY')
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('non-TTY fallback in an empty tree: banner printed, nothing-found honesty, exit 2', async () => {
    const dir = await tmpRoot('e2e-wiz-empty')
    try {
      const run = await runCli([], { cwd: dir })
      expect(run.code).toBe(2)
      expect(run.stdout).toContain('node-modules-hunter v')
      expect(run.stderr).toContain('no node_modules found in this folder')
      expect(run.stderr).toContain('needs a TTY')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
