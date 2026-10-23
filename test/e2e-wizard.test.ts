import fs from 'node:fs/promises'
import path from 'node:path'
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
      expect(run.stderr).toContain('project ancestors were scouted too')
      expect(run.stderr).toContain('needs a TTY')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('v0.8 auto-scope: cwd without node_modules in 3 levels climbs to the nearest manifest ancestor', async () => {
    const dir = await tmpRoot('e2e-wiz-climb')
    try {
      const proj = path.join(dir, 'proj')
      await fs.mkdir(path.join(proj, 'node_modules', 'react'), { recursive: true })
      await fs.writeFile(path.join(proj, 'package.json'), '{"name":"proj"}')
      await fs.writeFile(path.join(proj, 'node_modules', 'react', 'package.json'), '{"name":"react"}')
      const deep = path.join(proj, 'deep', 'nested', 'here')
      await fs.mkdir(deep, { recursive: true })

      const run = await runCli(['--json'], { cwd: deep })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as ScanPayload
      expect(payload.totals.folders).toBe(1)
      expect(run.stdout).toContain('proj/node_modules')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('v0.8 auto-scope: manifest ancestor without installs is skipped; the workspace root wins', async () => {
    const dir = await tmpRoot('e2e-wiz-climb-skip')
    try {
      const workspace = path.join(dir, 'wsk')
      await fs.mkdir(path.join(workspace, 'node_modules', 'react'), { recursive: true })
      await fs.writeFile(path.join(workspace, 'package.json'), '{"name":"wsk","workspaces":["app"]}')
      await fs.writeFile(path.join(workspace, 'node_modules', 'react', 'package.json'), '{"name":"react"}')
      const app = path.join(workspace, 'app')
      await fs.mkdir(path.join(app, 'sources'), { recursive: true })
      await fs.writeFile(path.join(app, 'package.json'), '{"name":"app"}')

      const run = await runCli(['--json'], { cwd: path.join(app, 'sources') })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as ScanPayload
      expect(payload.totals.folders).toBe(1)
      expect(run.stdout).toContain('wsk/node_modules')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
