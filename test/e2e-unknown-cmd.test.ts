import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'

interface ScanPayload {
  totals: { folders: number }
  entries: Array<{ path: string }>
}

describe('first positional classification (unknown-command guard regression)', () => {
  it('a bare unknown token is a loud usage error — it used to silently scan cwd (rc 0)', async () => {
    const fx = await tmpRoot('unknown-cmd')
    try {
      const run = await runCli(['bogus-command', '--json'], { cwd: fx })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain("unknown command 'bogus-command'")
      expect(run.stderr).toContain('nmh help')
      // the payload must NOT appear: no scan happened
      expect(run.stdout).toBe('')
    } finally {
      await fs.rm(fx, { recursive: true, force: true })
    }
  })

  it('a bare existing cwd-relative dir is a scan target — `nmh node_modules` hits the folder itself', async () => {
    const fx = await tmpRoot('bare-target')
    const nm = path.join(fx, 'node_modules')
    await fs.mkdir(path.join(nm, 'pkg'), { recursive: true })
    await fs.writeFile(path.join(nm, 'pkg', 'package.json'), '{"name":"pkg","version":"1.0.0"}')
    try {
      const run = await runCli(['node_modules', '--json'], { cwd: fx })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as ScanPayload
      expect(payload.totals.folders).toBe(1)
      expect(payload.entries[0]?.path).toBe(nm)
    } finally {
      await fs.rm(fx, { recursive: true, force: true })
    }
  })

  it('a registered subcommand wins even when a directory of the same name sits in the cwd', async () => {
    const fx = await tmpRoot('command-wins')
    await fs.mkdir(path.join(fx, 'scan'), { recursive: true })
    const nm = path.join(fx, 'proj', 'node_modules')
    const pkg = path.join(nm, 'pkg')
    await fs.mkdir(pkg, { recursive: true })
    await fs.writeFile(path.join(pkg, 'package.json'), '{"name":"pkg","version":"1.0.0"}')
    try {
      // `nmh scan` = the scan command (targets default to cwd) — not an attempt at ./scan
      const run = await runCli(['scan', '--json'], { cwd: fx })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as ScanPayload
      expect(payload.entries.map((e) => e.path)).toContain(nm)
    } finally {
      await fs.rm(fx, { recursive: true, force: true })
    }
  })
})
