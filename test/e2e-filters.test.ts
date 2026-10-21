import path from 'node:path'
import fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { monorepoFixture, runCli, tmpRoot, vpFixture } from './helpers.ts'

const exists = async (p: string): Promise<boolean> => !!(await fs.lstat(p).then(() => true, () => false))

interface ScanPayload {
  totals: { folders: number; size: number; packages: number }
  entries: Array<{ path: string; pm: string; pmVp: boolean; nested: boolean; ownerPath: string }>
}

describe('scan filters e2e (spawned CLI, non-TTY)', () => {
  it('--pm pnpm keeps only pnpm entries', async () => {
    const fx = await monorepoFixture('pm-pnpm')
    try {
      const run = await runCli(['scan', fx.root, '--pm', 'pnpm', '--json'])
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as ScanPayload
      expect(payload.totals.folders).toBe(1)
      expect(payload.entries[0].pm).toBe('pnpm')
      expect(payload.entries[0].path).toBe(fx.paths.webEntry)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('--pm vp filters on the wrapper tag; family underneath stays pnpm', async () => {
    const fx = await vpFixture('pm-vp')
    try {
      const run = await runCli(['scan', fx.root, '--pm', 'vp', '--json'])
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as ScanPayload
      expect(payload.totals.folders).toBe(1)
      expect(payload.entries[0].pm).toBe('pnpm')
      expect(payload.entries[0].pmVp).toBe(true)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('--pm without a value lists detected PMs (read-only)', async () => {
    const fx = await monorepoFixture('pm-list')
    try {
      const run = await runCli(['scan', fx.root, '--pm'])
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('detected PMs:')
      expect(run.stdout).toContain('pnpm×1')
      expect(run.stdout).toContain('npm×1')
      expect(run.stdout).toContain('yarn×1')
      expect(run.stdout).toContain('bun×1')
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('invalid --pm family is a usage error (exit 1)', async () => {
    const fx = await monorepoFixture('pm-bad')
    try {
      const run = await runCli(['scan', fx.root, '--pm', 'react'])
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('invalid --pm')
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('--exclude drops matching subtrees from discovery', async () => {
    const fx = await monorepoFixture('exclude')
    try {
      const run = await runCli(['scan', fx.root, '--exclude', 'api', '--json'])
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as ScanPayload
      expect(payload.totals.folders).toBe(3)
      expect(payload.entries.some((entry) => entry.path.includes('/api/'))).toBe(false)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('--depth caps how deep node_modules may sit', async () => {
    const fx = await monorepoFixture('depth-e2e')
    try {
      const deep = await runCli(['scan', fx.root, '--depth', '2', '--json'])
      expect(deep.code).toBe(0)
      expect((JSON.parse(deep.stdout) as ScanPayload).totals.folders).toBe(4)

      const shallow = await runCli(['scan', fx.root, '--depth', '1', '--json'])
      expect(shallow.code).toBe(2)
      expect((JSON.parse(shallow.stdout) as ScanPayload).totals.folders).toBe(0)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('-r lists nested node_modules flagged, totals stay top-level only', async () => {
    const fx = await monorepoFixture('recursive-e2e')
    try {
      const run = await runCli(['scan', fx.root, '-r', '--json'])
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as ScanPayload
      expect(payload.entries).toHaveLength(5)
      const nested = payload.entries.filter((entry) => entry.nested)
      expect(nested).toHaveLength(1)
      expect(nested[0].ownerPath).toBe(fx.paths.webEntry)
      expect(payload.totals.folders).toBe(4)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('--keep spares named projects in scan results', async () => {
    const fx = await monorepoFixture('keep-scan')
    try {
      const run = await runCli(['scan', fx.root, '--keep=api', '--json'])
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as ScanPayload
      expect(payload.totals.folders).toBe(3)
      expect(payload.entries.some((entry) => entry.path.includes('/api/'))).toBe(false)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('--expand prints absolute paths; default keeps them shortened', async () => {
    const fx = await monorepoFixture('expand')
    try {
      const expanded = await runCli(['scan', fx.root, '--expand'])
      expect(expanded.code).toBe(0)
      expect(expanded.stdout).toContain(fx.paths.webEntry)

      const compact = await runCli(['scan', fx.root])
      expect(compact.code).toBe(0)
      expect(compact.stdout).not.toContain(fx.paths.webEntry)
      expect(compact.stdout).toContain('web/node_modules')
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })
})

describe('delete filters e2e (spawned CLI, non-TTY)', () => {
  /** keepme = npm, doomed = pnpm — enough spread for --keep and --pm tests. */
  async function twoProjects(label: string): Promise<{ root: string; keepme: string; doomed: string }> {
    const root = await tmpRoot(label)
    const entries: Record<string, string> = {}
    for (const [name, lock] of [
      ['keepme', 'package-lock.json'],
      ['doomed', 'pnpm-lock.yaml'],
    ] as const) {
      const project = path.join(root, name)
      const entry = path.join(project, 'node_modules')
      entries[name] = entry
      await fs.mkdir(path.join(entry, 'express'), { recursive: true })
      await fs.writeFile(path.join(project, 'package.json'), `{"name":"${name}"}`)
      await fs.writeFile(path.join(project, lock), lock === 'pnpm-lock.yaml' ? 'lockfileVersion: 6.0' : '{"lockfileVersion":3}')
      await fs.writeFile(path.join(entry, 'express', 'package.json'), '{"name":"express"}')
      await fs.writeFile(path.join(entry, 'express', 'index.js'), Buffer.alloc(4 * 1024))
    }
    return { root, keepme: entries.keepme, doomed: entries.doomed }
  }

  it('--keep spares the named project during deletion', async () => {
    const fx = await twoProjects('keep-del')
    try {
      const run = await runCli(['--dir', fx.root, '--delete=hard', '-y', '--keep=keepme'])
      expect(run.code).toBe(0)
      expect(await exists(fx.keepme)).toBe(true)
      expect(await exists(fx.doomed)).toBe(false)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('--pm filters delete victims by detected family', async () => {
    const fx = await twoProjects('pm-del')
    try {
      const run = await runCli(['--dir', fx.root, '--delete=hard', '-y', '--pm', 'pnpm'])
      expect(run.code).toBe(0)
      expect(await exists(fx.keepme)).toBe(true)
      expect(await exists(fx.doomed)).toBe(false)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('bare --pm with a delete op is a usage error (exit 1)', async () => {
    const fx = await twoProjects('pm-bare-del')
    try {
      const run = await runCli(['--dir', fx.root, '--delete=hard', '-y', '--pm'])
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('give a family')
      expect(await exists(fx.keepme)).toBe(true)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('-r dry-run plans nested node_modules as extra victims', async () => {
    const fx = await monorepoFixture('recursive-dry')
    try {
      const run = await runCli(['--dir', fx.paths.webEntry, '-r', '--delete=hard', '--dry-run', '--json'])
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as { dryRun: boolean; results: Array<{ path: string; status: string }> }
      expect(payload.dryRun).toBe(true)
      expect(payload.results).toHaveLength(2)
      expect(payload.results.every((row) => row.status === 'would-hard')).toBe(true)
      expect(
        payload.results.some((row) => row.path.endsWith(path.join('react', 'nested', 'node_modules'))),
      ).toBe(true)
      expect(await exists(fx.paths.webEntry)).toBe(true)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })
})
