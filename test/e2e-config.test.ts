import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'

/** Four node_modules at depths 1..4 below <root>/proj — perfect for --depth ladder tests. */
async function depthFixture(label: string, config: Record<string, unknown>): Promise<string> {
  const root = await tmpRoot(label)
  await fs.writeFile(path.join(root, '.nmhrc'), JSON.stringify(config))
  for (const rel of [
    'proj/node_modules',
    'proj/a/node_modules',
    'proj/a/b/node_modules',
    'proj/a/b/c/node_modules',
  ]) {
    const entry = path.join(root, rel)
    await fs.mkdir(entry, { recursive: true })
    await fs.writeFile(path.join(entry, 'package.json'), '{"name":"x","version":"1.0.0"}')
  }
  await fs.writeFile(path.join(root, 'proj', 'package.json'), '{"name":"proj","version":"1.0.0"}')
  return root
}

interface ScanPayload {
  totals: { folders: number; size: number }
  entries: Array<{ path: string }>
}

const scanJson = async (args: string[], opts: { cwd: string; home?: string }) => {
  // home pinned only when explicitly requested: an implicit pin would stop the
  // .nmhrc upward walk below the config's directory and flip expectations.
  const run = await runCli(
    args.includes('--json') ? args : [...args, '--json'],
    { cwd: opts.cwd, home: opts.home },
  )
  let payload: ScanPayload
  try {
    payload = JSON.parse(run.stdout) as ScanPayload
  } catch {
    throw new Error(
      `scanJson: expected JSON but got (code=${run.code}); args=${JSON.stringify(args)} out=${run.stdout.slice(0, 200)}`,
    )
  }
  return { run, payload }
}

describe('config e2e (.nmhrc lookup, precedence, validation)', () => {
  it('depth comes from .nmhrc; CLI --depth wins; deeper entries surface with bigger depth', async () => {
    const root = await depthFixture('cfg-depth', { depth: 2 })
    try {
      const fromConfig = await scanJson(['scan', 'proj', '--json'], { cwd: root })
      expect(fromConfig.run.code).toBe(0)
      expect(fromConfig.payload.totals.folders).toBe(2) // level ≤ 2: proj/nm (1) + a/nm (2)

      const cliWins = await scanJson(['scan', 'proj', '--json', '--depth', '1'], { cwd: root })
      expect(cliWins.payload.totals.folders).toBe(1)

      const deeper = await scanJson(['scan', '.', '--json'], { cwd: path.join(root, 'proj') })
      // cwd deeper inside, still finds .nmhrc walking up to the fixture root (HOME pinned there)
      expect(deeper.payload.totals.folders).toBe(2)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('exclude/keep lists merge: config entries apply even without the CLI flag', async () => {
    const root = await depthFixture('cfg-exclude', { depth: 3, exclude: ['**/a/**'], keep: ['x'] })
    try {
      const { run, payload } = await scanJson(['scan', 'proj', '--json'], { cwd: root })
      expect(run.code).toBe(0)
      expect(payload.totals.folders).toBe(1) // only proj/node_modules; everything under proj/a/** is excluded
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('.nmhrc keep protects node_modules from a delete op (scan-level drop → nothing found)', async () => {
    const root = await depthFixture('cfg-keep', { depth: 1, keep: ['x'] })
    try {
      // keep matches the PROJECT name (adjacent package.json), not the installed packages
      await fs.writeFile(path.join(root, 'proj', 'package.json'), '{"name":"x","version":"1.0.0"}')
      const run = await runCli(['--dir', 'proj', '--delete=trash', '-y'], { cwd: root, home: root })
      expect(run.code).toBe(2) // kept victims are filtered out before the delete pipeline
      expect(run.stderr).toContain('no node_modules found')
      expect(await fs.readdir(path.join(root, 'proj'))).toContain('node_modules')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('defaultMode fills bare --delete (dry-run proves the mode without touching disk)', async () => {
    const root = await depthFixture('cfg-mode', { depth: 1, defaultMode: 'hard' })
    try {
      const hardRun = await runCli(['--dir', 'proj', '--delete', '--dry-run'], { cwd: root, home: root })
      expect(hardRun.code, hardRun.stderr).toBe(0)
      expect(hardRun.stdout).toContain('[DRY RUN] Would DELETE (permanent)')
      expect(await fs.readdir(path.join(root, 'proj'))).toContain('node_modules')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('nearest .nmhrc wins; --config replaces the lookup (relative to cwd)', async () => {
    const root = await depthFixture('cfg-nearest', { depth: 3 })
    try {
      // a closer config shadows the root one for scans run from `proj`
      await fs.writeFile(path.join(root, 'proj', '.nmhrc'), JSON.stringify({ depth: 1 }))

      const nearest = await scanJson(['scan', '.'], { cwd: path.join(root, 'proj') })
      expect(nearest.payload.totals.folders).toBe(1) // proj/.nmhrc depth 1

      const parent = await scanJson(['scan', 'proj', '--json'], { cwd: root })
      expect(parent.payload.totals.folders).toBe(3) // root .nmhrc depth 3 (levels ≤ 3)

      const explicit = path.join(root, 'proj', '.nmhrc')
      const viaFlag = await scanJson(['scan', 'proj', '--json', '--config', explicit], { cwd: root })
      expect(viaFlag.payload.totals.folders).toBe(1)

      const relative = await scanJson(['scan', 'proj', '--json', '--config', './proj/.nmhrc'], { cwd: root })
      expect(relative.payload.totals.folders).toBe(1)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('color:false strips ANSI; explicit --color on the CLI wins back the paint', async () => {
    const root = await depthFixture('cfg-color', { depth: 1, color: false })
    try {
      const quiet = await runCli(['--dir', 'proj'], { cwd: root, home: root })
      expect(quiet.code).toBe(0)
      expect(quiet.stdout).not.toMatch(/\x1b\[/)

      const loud = await runCli(['--dir', 'proj', '--color'], { cwd: root, home: root })
      expect(loud.code).toBe(0)
      expect(loud.stdout).toMatch(/\x1b\[/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('piped child prints plain text even inside a CI env (picocolors !!env.CI regression)', async () => {
    // GitHub Actions exports CI=true for every child; picocolors turns color on
    // in ANY CI env even on a pipe. nmh's own TTY policy must win — otherwise
    // all plain-substring e2e asserts fail on CI (the v1.1.0 matrix break).
    const root = await depthFixture('cfg-ci-plain', { depth: 1 })
    try {
      const plain = await runCli(['--dir', 'proj'], { cwd: root, home: root, envExtra: { CI: 'true' } })
      expect(plain.code).toBe(0)
      expect(plain.stdout).not.toMatch(/\x1b\[/)
      // path separators differ per OS (Windows prints `proj\node_modules`)
      expect(plain.stdout).toContain(path.join('proj', 'node_modules'))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('logDir redirects recovery logs (relative to cwd)', async () => {
    const root = await depthFixture('cfg-logdir', { depth: 1, logDir: 'logs', defaultMode: 'trash' })
    try {
      const entry = path.join(root, 'proj', 'node_modules')
      const run = await runCli(['--dir', 'proj', '--delete=trash', '--force'], {
        cwd: root,
        home: root,
        envExtra: { NMH_TRASH_BACKEND: 'none' }, // hermetic: same trash flow on every OS
      })
      expect(run.code).toBe(0)
      const logs = await fs.readdir(path.join(root, 'logs'))
      expect(logs.some((name) => /^delete-.*\.json$/.test(name))).toBe(true)
      expect(await fs.readdir(path.join(root, 'proj'), { recursive: true })).not.toContain('node_modules')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('validation: bad JSON, wrong types, missing files → exit 1 with clear messages', async () => {
    const root = await depthFixture('cfg-invalid', { depth: 1 })
    try {
      await fs.writeFile(path.join(root, 'broken.json'), '{"depth": }')
      const badJson = await runCli(['scan', 'proj', '--config', 'broken.json'], { cwd: root, home: root })
      expect(badJson.code).toBe(1)
      expect(badJson.stderr).toContain('not valid JSON')

      await fs.writeFile(path.join(root, 'typed.json'), JSON.stringify({ depth: 'three' }))
      const badType = await runCli(['scan', 'proj', '--config', 'typed.json'], { cwd: root, home: root })
      expect(badType.code).toBe(1)
      expect(badType.stderr).toContain('depth must be a non-negative integer')

      await fs.writeFile(path.join(root, 'moded.json'), JSON.stringify({ defaultMode: 'nuke' }))
      const badMode = await runCli(['scan', 'proj', '--config', 'moded.json'], { cwd: root, home: root })
      expect(badMode.code).toBe(1)
      expect(badMode.stderr).toContain("defaultMode must be 'hard' | 'soft' | 'trash'")

      const missing = await runCli(['scan', 'proj', '--config', 'ghost.json'], { cwd: root, home: root })
      expect(missing.code).toBe(1)
      expect(missing.stderr).toContain('config file not found')

      const bare = await runCli(['scan', 'proj', '--config'], { cwd: root, home: root })
      expect(bare.code).toBe(1)
      expect(bare.stderr).toContain('--config needs a file path')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('unknown keys warn and execution continues; .nmhrc.json is also a valid name', async () => {
    const root = await tmpRoot('cfg-unknown')
    try {
      await fs.mkdir(path.join(root, 'proj', 'node_modules'), { recursive: true })
      await fs.writeFile(path.join(root, 'proj', 'node_modules', 'package.json'), '{"name":"x"}')
      await fs.writeFile(path.join(root, '.nmhrc.json'), JSON.stringify({ depth: 1, quietly: true }))

      const run = await runCli(['scan', 'proj', '--json'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(run.stderr).toContain('unknown config key "quietly"')
      expect(JSON.parse(run.stdout) as ScanPayload).toMatchObject({ totals: { folders: 1 } })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('no .nmhrc anywhere → defaults still apply (and the real ~/.nmhrc is not polluted by fixtures)', async () => {
    const root = await depthFixture('cfg-none', { depth: 1 })
    try {
      await fs.unlink(path.join(root, '.nmhrc'))
      // home pinned: on a shared runner the walk must stop at the fixture and
      // never reach the real profile (another worker's .nmhrc must not leak in)
      const { run, payload } = await scanJson(['scan', 'proj', '--json'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(payload.totals.folders).toBeGreaterThan(1) // default depth reaches deeper than 1
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('$HOME/.nmhrc is honored when the cwd sits OUTSIDE the home tree (the fallback lookup)', async () => {
    // cwd and home are sibling fixture dirs: the cwd → ancestors → / climb never passes
    // home, so the only way to see the config is the explicit $HOME fallback.
    const cwd = await tmpRoot('cfg-outside-cwd')
    const home = await tmpRoot('cfg-outside-home')
    try {
      await fs.mkdir(path.join(cwd, 'proj-a', 'node_modules'), { recursive: true })
      await fs.writeFile(path.join(cwd, 'proj-a', 'node_modules', 'package.json'), '{"name":"a"}')
      await fs.mkdir(path.join(cwd, 'proj-b', 'node_modules'), { recursive: true })
      await fs.writeFile(path.join(cwd, 'proj-b', 'node_modules', 'package.json'), '{"name":"b"}')
      await fs.writeFile(path.join(home, '.nmhrc'), JSON.stringify({ exclude: ['**/proj-a/**'] }))

      // control: cwd-side .nmhrc absent, home-side one must still steer the scan
      const run = await runCli(['scan', '.', '--json'], { cwd, home })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as ScanPayload
      expect(payload.totals.folders).toBe(1) // proj-a excluded via the $HOME/.nmhrc fallback
      expect(payload.entries.map((e) => path.basename(path.dirname(e.path)))).toContain('proj-b')

      // and .nmhrc directly in the cwd still wins over the home fallback (nearest first)
      await fs.writeFile(path.join(cwd, '.nmhrc'), JSON.stringify({ exclude: ['**/proj-b/**'] }))
      const nearest = await runCli(['scan', '.', '--json'], { cwd, home })
      const nearestPayload = JSON.parse(nearest.stdout) as ScanPayload
      expect(nearestPayload.totals.folders).toBe(1)
      expect(nearestPayload.entries.map((e) => path.basename(path.dirname(e.path)))).toContain('proj-a')
    } finally {
      await fs.rm(cwd, { recursive: true, force: true })
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})
