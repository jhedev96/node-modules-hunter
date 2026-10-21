import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectDeadBins } from '../src/commands/global.ts'
import { runCli, tmpRoot } from './helpers.ts'

interface GlobalPayload {
  command: string
  mode: string
  totals: { packages: number; size: number }
  duplicates: Array<{ name: string }>
  pms: Array<{
    pm: string
    root: string
    binDir: string | null
    source: string
    dead: Array<{ name: string; kind: string; detail: string }>
    packages: Array<{ name: string; version: string | null; symlinked: boolean; size: number | null }>
  }>
}

interface GlobalFixture {
  root: string
  gRoot: string
  binDir: string
  shimDir: string
}

/**
 * Synthetic global tree + an `npm` shim on PATH: `npm root -g` echoes the fake tree,
 * so tests stay tiny and deterministic instead of measuring the real ~GB install.
 */
async function globalFixture(): Promise<GlobalFixture> {
  const root = await tmpRoot('g-fake')
  const gRoot = path.join(root, 'prefix', 'lib', 'node_modules')
  const binDir = path.join(root, 'prefix', 'bin')
  const shimDir = path.join(root, 'shim')

  const alpha = path.join(gRoot, 'alpha')
  const beta = path.join(gRoot, '@acme', 'beta')
  const gamma = path.join(gRoot, 'gamma')
  for (const dir of [alpha, beta, gamma]) await fs.mkdir(dir, { recursive: true })
  // alpha: healthy bin symlink · beta: declares bin but nothing links it · gamma: link's target is gone
  await fs.writeFile(path.join(alpha, 'package.json'), JSON.stringify({ name: 'alpha', version: '1.0.0', bin: 'cli.js' }))
  await fs.writeFile(path.join(alpha, 'cli.js'), 'console.log(1)\n')
  await fs.writeFile(path.join(beta, 'package.json'), JSON.stringify({ name: '@acme/beta', version: '2.3.4', bin: 'beta.js' }))
  await fs.writeFile(path.join(gamma, 'package.json'), JSON.stringify({ name: 'gamma', version: '0.9.0', bin: 'gamma.js' }))

  await fs.mkdir(binDir, { recursive: true })
  await fs.symlink(path.join(alpha, 'cli.js'), path.join(binDir, 'alpha'))
  await fs.symlink(path.join(root, 'nowhere'), path.join(binDir, 'gamma'))

  await fs.mkdir(shimDir, { recursive: true })
  const shim = path.join(shimDir, 'npm')
  await fs.writeFile(shim, `#!/bin/sh\necho "${gRoot}"\n`)
  await fs.chmod(shim, 0o755)
  return { root, gRoot, binDir, shimDir }
}

/** Child PATH leads with the shim dir; HOME/workdir pinned to the fixture. */
function runOpts(fixture: GlobalFixture) {
  return {
    cwd: fixture.root,
    home: fixture.root,
    envExtra: { PATH: `${fixture.shimDir}${path.delimiter}${process.env.PATH ?? ''}` },
  }
}

describe('global e2e (nmh stats --global)', () => {
  it('JSON: probed root + binDir, per-package sizes/versions, dead-bin issues, cross-totals', async () => {
    const fx = await globalFixture()
    try {
      const run = await runCli(['stats', '--global', '--pm', 'npm', '--json'], runOpts(fx))
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as GlobalPayload
      expect(payload.command).toBe('stats')
      expect(payload.mode).toBe('global')
      expect(payload.pms).toHaveLength(1)

      const npm = payload.pms[0]!
      expect(npm.pm).toBe('npm')
      expect(npm.root).toBe(fx.gRoot)
      expect(npm.binDir).toBe(fx.binDir)
      expect(npm.source).toBe('pm')
      expect(npm.packages.map((pkg) => pkg.name).sort()).toEqual(['@acme/beta', 'alpha', 'gamma'])
      for (const pkg of npm.packages) {
        expect(pkg.size).not.toBeNull()
        expect(pkg.size!).toBeGreaterThan(0)
        expect(pkg.symlinked).toBe(false)
      }
      expect(npm.packages.find((pkg) => pkg.name === '@acme/beta')?.version).toBe('2.3.4')

      expect(payload.totals.packages).toBe(3)
      expect(payload.totals.size).toBeGreaterThan(0)
      expect(payload.duplicates).toEqual([])

      const dead = npm.dead.map((issue) => `${issue.name}:${issue.kind}`)
      expect(dead).toContain('gamma:broken bin symlink')
      expect(dead).toContain('@acme/beta:missing bin symlink')
      expect(dead.some((issue) => issue.startsWith('alpha:'))).toBe(false)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  }, 60_000)

  it('text: header, read-only warning, totals line and package rows — counter silent without --animate', async () => {
    const fx = await globalFixture()
    try {
      const run = await runCli(['stats', '--global', '--pm', 'npm'], runOpts(fx))
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('🌐')
      expect(run.stdout).toContain('read-only')
      expect(run.stdout).toContain('Total global')
      expect(run.stdout).toContain('alpha')
      expect(run.stdout).toContain('@acme/beta')
      expect(run.stdout).not.toContain('⠋')
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  }, 60_000)

  it('stripped PATH → no probe resolves → exit 2 + honest stderr warning + empty JSON', async () => {
    const fx = await globalFixture()
    try {
      const run = await runCli(['stats', '--global', '--pm', 'npm', '--json'], {
        ...runOpts(fx),
        envExtra: { PATH: '/nonexistent' },
      })
      expect(run.code).toBe(2)
      const payload = JSON.parse(run.stdout) as GlobalPayload
      expect(payload.pms).toHaveLength(0)
      expect(run.stderr).toContain('no global install roots')
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  }, 60_000)

  it('guards: --global rejects a [dir], delete mode, tree/top shaping and bare --pm', async () => {
    const dirAndGlobal = await runCli(['stats', '--global', '.'])
    expect(dirAndGlobal.code).toBe(1)
    expect(dirAndGlobal.stderr).toContain('no [dir] needed')

    const deleteAndGlobal = await runCli(['--global', '--delete=trash', '-y'])
    expect(deleteAndGlobal.code).toBe(1)
    expect(deleteAndGlobal.stderr).toContain('--global only works with the stats command')

    const treeAndGlobal = await runCli(['stats', '--global', '--tree'])
    expect(treeAndGlobal.code).toBe(1)
    expect(treeAndGlobal.stderr).toContain('its own table')

    const topAndGlobal = await runCli(['stats', '-g', '--top', '3'])
    expect(topAndGlobal.code).toBe(1)

    const barePm = await runCli(['stats', '--global', '--pm'])
    expect(barePm.code).toBe(1)
    expect(barePm.stderr).toContain('give a family')
  }, 60_000)

  it('inspectDeadBins flags broken & missing symlinks and never flags a healthy link', async () => {
    const root = await tmpRoot('g-deadbins')
    try {
      const binDir = path.join(root, 'bin')
      const brokenPkg = path.join(root, 'broken')
      const missingPkg = path.join(root, 'missing')
      const okPkg = path.join(root, 'okpkg')
      for (const dir of [brokenPkg, missingPkg, okPkg]) await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(brokenPkg, 'package.json'), JSON.stringify({ name: 'brokenpkg', bin: 'cli.js' }))
      await fs.writeFile(path.join(missingPkg, 'package.json'), JSON.stringify({ name: 'missingpkg', bin: { missingpkg: 'y.js' } }))
      await fs.writeFile(path.join(okPkg, 'package.json'), JSON.stringify({ name: 'okpkg', bin: { okpkg: 'cli.js' } }))
      await fs.writeFile(path.join(okPkg, 'cli.js'), '#!/usr/bin/env node')

      await fs.mkdir(binDir, { recursive: true })
      await fs.writeFile(path.join(binDir, 'regular'), 'not a link — bins that are not symlinks are skipped')
      await fs.symlink(path.join(root, 'nowhere'), path.join(binDir, 'brokenpkg'))
      await fs.symlink(path.join(okPkg, 'cli.js'), path.join(binDir, 'okpkg'))

      const issues = await inspectDeadBins(root, binDir, [
        { name: 'brokenpkg', path: brokenPkg, symlinked: false },
        { name: 'missingpkg', path: missingPkg, symlinked: false },
        { name: 'okpkg', path: okPkg, symlinked: false },
      ])
      const kinds = issues.map((issue) => `${issue.name}:${issue.kind}`)
      expect(kinds).toContain('brokenpkg:broken bin symlink')
      expect(kinds).toContain('missingpkg:missing bin symlink')
      expect(kinds.some((k) => k.startsWith('okpkg:'))).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
