import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'

interface WhyPayload {
  command: string
  pkg: string
  found: number
  instances: Array<{
    displayPath: string
    pm: string
    version: string | null
    symlinked: boolean
    size: number | null
    declaredBy: { projectName: string | null; range: string; field: string } | null
    requiredBy: Array<{ name: string; version: string | null; range: string; field: string }>
  }>
}

/**
 * web/node_modules holds the target (lodash) plus one requirer (express, own range)
 * and one orphan (no manifest mention) — the classic reverse-depend question.
 */
async function fixture(label: string): Promise<string> {
  const root = await tmpRoot(label)
  const web = path.join(root, 'web', 'node_modules')
  await fs.mkdir(path.join(web, 'lodash'), { recursive: true })
  await fs.mkdir(path.join(web, 'express'), { recursive: true })
  await fs.mkdir(path.join(web, 'only-child'), { recursive: true })
  await fs.writeFile(path.join(root, 'web', 'package.json'), JSON.stringify({ name: 'web', version: '1.0.0', dependencies: { lodash: '^4.17.21' } }))
  await fs.writeFile(path.join(web, 'lodash', 'package.json'), '{"name":"lodash","version":"4.17.21"}')
  await fs.writeFile(path.join(web, 'lodash', 'blob.bin'), 'x'.repeat(900))
  await fs.writeFile(path.join(web, 'express', 'package.json'), '{"name":"express","version":"4.19.2","dependencies":{"lodash":"^4.17.0"}}')
  await fs.writeFile(path.join(web, 'only-child', 'package.json'), '{"name":"only-child","version":"2.0.0"}')
  return root
}

describe('why e2e (reverse depend, manifest-level best-effort)', () => {
  it('text: instance header, project declaration and per-requirer lines with their own ranges', async () => {
    const root = await fixture('wh-text')
    try {
      const run = await runCli(['why', 'lodash', '.'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain("why 'lodash' — 1 instance(s)")
      expect(run.stdout).toContain('lodash@4.17.21')
      expect(run.stdout).toContain('web declares ^4.17.21 (dependencies)')
      expect(run.stdout).toContain('required by          : 1 package(s)')
      expect(run.stdout).toContain('express@4.19.2 → ^4.17.0 (dependencies)')
      // the sibling that never mentions lodash must not be attributed (no ancestor climb)
      expect(run.stdout).not.toContain('only-child')

      // a package nobody requires shows the orphan line
      const orphan = await runCli(['why', 'only-child', '.'], { cwd: root, home: root })
      expect(orphan.code).toBe(0)
      expect(orphan.stdout).toContain('orphan copy')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('json: structured instances with declaredBy + requiredBy shapes', async () => {
    const root = await fixture('wh-json')
    try {
      const run = await runCli(['why', 'lodash', '.', '--json'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as WhyPayload
      expect(payload.command).toBe('why')
      expect(payload.found).toBe(1)
      const inst = payload.instances[0]!
      expect(inst.displayPath).toContain('node_modules')
      expect(inst.version).toBe('4.17.21')
      expect(inst.symlinked).toBe(false)
      expect(inst.size).toBeGreaterThan(0)
      expect(inst.declaredBy).toEqual({ projectName: 'web', range: '^4.17.21', field: 'dependencies' })
      expect(inst.requiredBy).toEqual([{ name: 'express', version: '4.19.2', range: '^4.17.0', field: 'dependencies' }])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('flag form (--why <pkg>) equals the subcommand; unknown package → exit 2 + hint', async () => {
    const root = await fixture('wh-flag')
    try {
      const flagRun = await runCli(['--why', 'lodash', '--dir', root, '--json'], { cwd: root, home: root })
      expect(flagRun.code).toBe(0)
      expect((JSON.parse(flagRun.stdout) as WhyPayload).found).toBe(1)

      const missing = await runCli(['why', 'does-not-exist', '.'], { cwd: root, home: root })
      expect(missing.code).toBe(2)
      expect(missing.stderr).toContain("no instance of 'does-not-exist'")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('guards: needs a name, read-only only, delete/clean refuse (exit 1)', async () => {
    const root = await fixture('wh-flak')
    try {
      const bareFlag = await runCli(['--why'], { cwd: root, home: root })
      expect(bareFlag.code).toBe(1)
      expect(bareFlag.stderr).toContain('--why needs a package name')

      const bareCommand = await runCli(['why'], { cwd: root, home: root })
      expect(bareCommand.code).toBe(1)
      expect(bareCommand.stderr).toContain('why needs a package name')

      const withDelete = await runCli(['why', 'lodash', root, '--delete=trash', '-y'], { cwd: root, home: root })
      expect(withDelete.code).toBe(1)
      expect(withDelete.stderr).toContain('--why is read-only')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('symlinked copies show as linked (size null, never measured)', async () => {
    const root = await fixture('wh-link')
    try {
      const linkDir = path.join(root, 'linked')
      await fs.mkdir(path.join(linkDir, 'node_modules'), { recursive: true })
      await fs.writeFile(path.join(linkDir, 'package.json'), '{"name":"linked","version":"1.0.0"}')
      await fs.symlink(path.join(root, 'web', 'node_modules', 'lodash'), path.join(linkDir, 'node_modules', 'lodash'), 'dir')

      const run = await runCli(['why', 'lodash', '.', '--json'], { cwd: root, home: root })
      const payload = JSON.parse(run.stdout) as WhyPayload
      expect(payload.found).toBe(2)
      const linked = payload.instances.find((inst) => inst.symlinked)
      expect(linked?.size).toBeNull()
      expect(run.stdout).not.toContain('orphan copy')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
