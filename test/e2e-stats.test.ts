import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { monorepoFixture, runCli, tmpRoot } from './helpers.ts'

interface StatsPayload {
  command: string
  mode: string
  topN: number
  overview: {
    totalSize: number
    entryCount: number
    instances: number
    unique: number
    dupFactor: number
    waste: number
    wastePercent: number
    declared: number | null
  }
  sizeGroups: Array<{ name: string; copies: number; totalSize: number; dedupableSize?: number }>
  projects: Array<{
    path: string
    nested: boolean
    topPackages: Array<{ name: string; version: string | null; size: number | null; symlinked: boolean }>
    declared: { dependencies: string[]; devDependencies: string[] } | null
  }>
}

const statsJson = async (args: string[]): Promise<{ code: number; payload: StatsPayload; stderr: string }> => {
  const run = await runCli([...args, '--json'])
  return { code: run.code, payload: JSON.parse(run.stdout) as StatsPayload, stderr: run.stderr }
}

/** Two projects sharing an identical lodash@4.17.21 — the canonical dedup case. */
async function dupFixture(label: string): Promise<{ root: string; web: string; api: string }> {
  const root = await tmpRoot(label)
  const web = path.join(root, 'web', 'node_modules')
  const api = path.join(root, 'api', 'node_modules')
  for (const [entry, pkg] of [
    [web, 'lodash'],
    [web, 'react'],
    [api, 'lodash'],
    [api, 'zod'],
  ] as const) {
    await fs.mkdir(path.join(entry, pkg), { recursive: true })
  }
  await fs.writeFile(path.join(root, 'web', 'package.json'), '{"name":"web","devDependencies":{"react":"^19"}}')
  await fs.writeFile(path.join(root, 'web', 'pnpm-lock.yaml'), 'lockfileVersion: 6.0')
  await fs.writeFile(path.join(root, 'api', 'package.json'), '{"name":"api","dependencies":{"zod":"^3"},"devDependencies":{"lodash":"^4"}}')
  await fs.writeFile(path.join(root, 'api', 'package-lock.json'), '{"lockfileVersion":3}')
  await fs.writeFile(path.join(web, 'lodash', 'package.json'), '{"name":"lodash","version":"4.17.21"}')
  await fs.writeFile(path.join(web, 'react', 'package.json'), '{"name":"react","version":"19.2.0"}')
  await fs.writeFile(path.join(api, 'lodash', 'package.json'), '{"name":"lodash","version":"4.17.21"}')
  await fs.writeFile(path.join(api, 'zod', 'package.json'), '{"name":"zod","version":"3.24.1"}')
  await fs.appendFile(path.join(web, 'lodash', 'index.js'), Buffer.alloc(8 * 1024))
  await fs.appendFile(path.join(web, 'react', 'index.js'), Buffer.alloc(4 * 1024))
  await fs.appendFile(path.join(api, 'lodash', 'index.js'), Buffer.alloc(3 * 1024))
  return { root, web, api }
}

describe('stats e2e (spawned CLI, non-TTY)', () => {
  it('overview: instances vs unique, dup factor, declared, dedup waste', async () => {
    const fx = await dupFixture('stats-overview')
    try {
      const { code, payload } = await statsJson(['stats', fx.root])
      expect(code).toBe(0)
      expect(payload.command).toBe('stats')
      expect(payload.overview.entryCount).toBe(2)
      expect(payload.overview.instances).toBe(4)
      expect(payload.overview.unique).toBe(3) // lodash@4.17.21 counted once
      expect(payload.overview.dupFactor).toBe(1.3)
      expect(payload.overview.declared).toBe(3) // react (dev) + zod (dep) + lodash (dev)
      expect(payload.overview.waste).toBeGreaterThan(0)
      expect(payload.overview.waste).toBeLessThan(payload.overview.totalSize)

      const lodash = payload.sizeGroups.find((group) => group.name === 'lodash')
      expect(lodash?.copies).toBe(2)
      expect(lodash?.dedupableSize).toBeGreaterThan(0)
      expect(payload.sizeGroups[0].name).toBe('lodash') // biggest aggregated size first
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('text report: top list with dedup note; long tail under --by package', async () => {
    const fx = await dupFixture('stats-text')
    try {
      const full = await runCli(['stats', fx.root])
      expect(full.code).toBe(0)
      expect(full.stdout).toContain('OVERVIEW')
      expect(full.stdout).toContain('← dedup bisa hemat')

      const focused = await runCli(['stats', fx.root, '--top', '1', '--by', 'package'])
      expect(focused.stdout).toContain('TOP 1 SIZE')
      expect(focused.stdout).toContain('LONG TAIL')
      expect(focused.stdout).toMatch(/more package name\(s\)/)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('--by size is an accepted alias; --by type focuses the breakdown; invalid values are usage errors', async () => {
    const fx = await dupFixture('stats-by')
    try {
      const sizeAlias = await runCli(['stats', fx.root, '--by', 'size'])
      expect(sizeAlias.code).toBe(0)
      expect(sizeAlias.stdout).toContain('TOP')
      expect(sizeAlias.stderr).not.toContain('--by')

      const typeFocus = await runCli(['stats', fx.root, '--by', 'type'])
      expect(typeFocus.code).toBe(0)
      expect(typeFocus.stderr).not.toContain('v0.4') // real since v0.4 — no fallback warning
      expect(typeFocus.stdout).toContain('BY TYPE')
      expect(typeFocus.stdout).not.toContain('TOP') // focused view, size list stays hidden

      const badBy = await runCli(['stats', fx.root, '--by', 'horoscope'])
      expect(badBy.code).toBe(1)
      expect(badBy.stderr).toContain('invalid --by')

      const badTop = await runCli(['stats', fx.root, '--top', 'abc'])
      expect(badTop.code).toBe(1)
      expect(badTop.stderr).toContain('invalid --top')

      const zeroTop = await runCli(['stats', fx.root, '--top', '0'])
      expect(zeroTop.code).toBe(1)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('--tree renders per-project packages with sizes', async () => {
    const fx = await dupFixture('stats-tree')
    try {
      const run = await runCli(['stats', fx.root, '--tree'])
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('lodash@4.17.21')
      expect(run.stdout).toMatch(/\((8\.0|7\.9) KB\)/)
      expect(run.stdout).toContain('react@19.2.0 (4.0 KB)')
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('nested entries count as instances only with -r; symlinked packages stay sizeless', async () => {
    const fx = await monorepoFixture('stats-nested')
    try {
      const flat = await statsJson(['stats', fx.root])
      const flatUrls = flat.payload.projects.reduce((sum, project) => sum + project.topPackages.length, 0)
      expect(flat.payload.projects.some((project) => project.nested)).toBe(false)

      const deep = await statsJson(['stats', fx.root, '-r'])
      const deepUrls = deep.payload.projects.reduce((sum, project) => sum + project.topPackages.length, 0)
      expect(deepUrls).toBe(flatUrls + 1) // nested node_modules contributes its `foo` package

      const web = deep.payload.projects.find((project) => project.path === fx.paths.webEntry)
      const linkedPkg = web?.topPackages.find((pkg) => pkg.name === 'linked')
      expect(linkedPkg?.symlinked).toBe(true)
      expect(linkedPkg?.size).toBeNull()
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('subcommand aliases analyze/info and the --stats flag form', async () => {
    const fx = await dupFixture('stats-alias')
    try {
      for (const [alias, args] of [
        ['analyze', ['analyze', fx.root]],
        ['info', ['info', fx.root]],
        ['flag', ['--dir', fx.root, '--stats']],
      ] as const) {
        const run = await runCli([...args, '--json'])
        expect(run.code, `${alias} exited ${run.code}`).toBe(0)
        expect(JSON.parse(run.stdout) as StatsPayload).toMatchObject({ command: 'stats' })
      }
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('usage: --stats/--tree with delete (exit 1), --depend with stats (exit 1), --top outside stats (exit 1)', async () => {
    const fx = await dupFixture('stats-usage')
    try {
      const withDelete = await runCli(['stats', fx.root, '--delete=hard', '-y'])
      expect(withDelete.code).toBe(1)
      expect(withDelete.stderr).toContain('--stats is read-only')

      const treeDelete = await runCli(['stats', fx.root, '--tree', '--delete=hard', '-y'])
      expect(treeDelete.code).toBe(1)
      expect(treeDelete.stderr).toContain('read-only')

      const dependStats = await runCli(['stats', fx.root, '--depend', 'lodash'])
      expect(dependStats.code).toBe(1)
      expect(dependStats.stderr).toContain('--depend only works with the map')

      const topOutside = await runCli(['scan', fx.root, '--top', '3'])
      expect(topOutside.code).toBe(1)
      expect(topOutside.stderr).toContain('--top/--by only work with the stats')
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('nothing found → exit 2', async () => {
    const root = await tmpRoot('stats-empty')
    try {
      const noEntry = await runCli(['stats', root, '--json'])
      expect(noEntry.code).toBe(2)
      expect(JSON.parse(noEntry.stdout).projects).toHaveLength(0)

      const noMatch = await runCli(['stats', root])
      expect(noMatch.code).toBe(2)
      expect(noMatch.stderr).toContain('nothing to analyze')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
