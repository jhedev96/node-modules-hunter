import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readNpmLockGraph } from '../src/core/lockfile.ts'
import { runCli, tmpRoot } from './helpers.ts'

interface GraphPayload {
  mode?: string
  graph: {
    totalEntries: number
    fullEntries: number
    rootDirect: number
    edges: number
    nodes: number
    unreachable: number
    depthHistogram: Array<{ depth: number; packages: number }>
    entries: Array<{ displayPath: string; pm: string; file: string | null; grade: 'full' | 'manifest'; rootDirect: number; nodes: number; edges: number }>
  } | null
}

interface WhyPayload {
  instances: Array<{ displayPath: string; requiredByGrade: 'manifest' | 'lockfile'; requiredBy: Array<{ name: string; version: string | null; range: string; field: string }> }>
}

/**
 * web: v3 lockfile with a real chain root→lodash→leftpad, a workspace link key,
 * and a scoped package with no incoming edge (unreachable).
 * legacy: lockfileVersion 1 → parser refuses, entry stays manifest-grade.
 * api: no lockfile at all — manifest-grade.
 */
async function fixture(label: string): Promise<string> {
  const root = await tmpRoot(label)
  const web = path.join(root, 'web')
  const legacy = path.join(root, 'legacy')
  const api = path.join(root, 'api')

  await fs.mkdir(path.join(web, 'node_modules', 'lodash'), { recursive: true })
  await fs.mkdir(path.join(web, 'node_modules', 'leftpad'), { recursive: true })
  await fs.mkdir(path.join(web, 'node_modules', '@scope', 'thing'), { recursive: true })
  await fs.writeFile(path.join(web, 'node_modules', 'lodash', 'package.json'), JSON.stringify({ name: 'lodash', version: '4.17.21' }))
  await fs.writeFile(path.join(web, 'node_modules', 'leftpad', 'package.json'), JSON.stringify({ name: 'leftpad', version: '1.3.0' }))
  await fs.writeFile(path.join(web, 'node_modules', '@scope', 'thing', 'package.json'), JSON.stringify({ name: '@scope/thing', version: '2.0.0' }))
  await fs.writeFile(
    path.join(web, 'package.json'),
    JSON.stringify({ name: 'web', version: '1.0.0', dependencies: { lodash: '^4.17.0', leftpad: '^1.2.0' } }),
  )
  await fs.writeFile(
    path.join(web, 'package-lock.json'),
    JSON.stringify({
      name: 'web',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        // the lockfile root only DECLARES lodash (leftpad arrives via edges)
        '': { name: 'web', version: '1.0.0', dependencies: { lodash: '^4.17.0' } },
        'node_modules/lodash': { version: '4.17.21', dependencies: { leftpad: '^1.2.0' } },
        'node_modules/leftpad': { version: '1.3.0' },
        'node_modules/@scope/thing': { version: '2.0.0' },
        'packages/side': { link: true },
      },
    }),
  )

  await fs.mkdir(path.join(legacy, 'node_modules', 'oldnd'), { recursive: true })
  await fs.writeFile(path.join(legacy, 'node_modules', 'oldnd', 'package.json'), JSON.stringify({ name: 'oldnd', version: '0.1.0' }))
  await fs.writeFile(path.join(legacy, 'package.json'), JSON.stringify({ name: 'legacy', version: '1.0.0' }))
  await fs.writeFile(
    path.join(legacy, 'package-lock.json'),
    JSON.stringify({ name: 'legacy', lockfileVersion: 1, dependencies: { oldnd: { version: '0.1.0' } } }),
  )

  await fs.mkdir(path.join(api, 'node_modules', 'chalk'), { recursive: true })
  await fs.writeFile(path.join(api, 'node_modules', 'chalk', 'package.json'), JSON.stringify({ name: 'chalk', version: '3.0.0' }))
  await fs.writeFile(path.join(api, 'package.json'), JSON.stringify({ name: 'api', version: '1.0.0', dependencies: { chalk: '^3' } }))
  return root
}

describe('npm lockfile graph parser (unit, v2/v3 + refusals)', () => {
  it('names scoped, nested and stripped keys; refuses v1/corrupt/missing files', async () => {
    const root = await tmpRoot('graph-unit')
    const project = path.join(root, 'proj')
    await fs.mkdir(project, { recursive: true })
    await fs.writeFile(
      path.join(project, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { a: '^1' } },
          'node_modules/a': { version: '1.0.0', dependencies: { b: '^2' } },
          'node_modules/z/node_modules/b': { version: '2.0.0' },
          'node_modules/@scope/pkg': { version: '3.0.0', dependencies: { a: '1' } },
          'other/name': { link: true },
        },
      }),
    )
    const graph = await readNpmLockGraph(project)
    expect(graph).not.toBeNull()
    expect(graph!.pm).toBe('npm')
    expect(graph!.rootDirect).toBe(1)
    expect(graph!.nodes).toBe(3) // a, b, @scope/pkg — 'other/name' is a workspace link, skipped
    expect(graph!.edges).toBe(3) // root→a, a→b, @scope/pkg→a
    expect(graph!.dependencyEdges).toContainEqual({ from: '@scope/pkg', to: 'a', range: '1' })

    // v1 is npm 6 era — honest manifest-grade refusal
    const v1Project = path.join(root, 'v1')
    await fs.mkdir(v1Project, { recursive: true })
    await fs.writeFile(path.join(v1Project, 'package-lock.json'), JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: '1' } } }))
    expect(await readNpmLockGraph(v1Project)).toBeNull()

    const broken = path.join(root, 'broken')
    await fs.mkdir(broken, { recursive: true })
    await fs.writeFile(path.join(broken, 'package-lock.json'), '{nope')
    expect(await readNpmLockGraph(broken)).toBeNull()

    expect(await readNpmLockGraph(path.join(root, 'missing'))).toBeNull()
  })
})

describe('nmh stats --graph', () => {
  it('focuses the GRAPH section with lockfile rows and honest manifest-grade fallbacks', async () => {
    const root = await fixture('graph-text')
    try {
      const run = await runCli(['stats', 'web', 'legacy', 'api', '--graph'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('GRAPH')
      // 1 real lockfile of 3 entries
      expect(run.stdout).toContain('1/3')
      expect(run.stdout).toContain('declared → 3 tree nodes via 2 edges')
      expect(run.stdout).toContain('unreachable from the root')
      expect(run.stdout).toContain('package-lock.json')
      // manifest-grade rows named honestly
      expect(run.stdout).toContain('no usable lockfile')
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('reports exact counts in JSON: chain depth, unreachable scoped pkg, grade per entry', async () => {
    const root = await fixture('graph-json')
    try {
      const run = await runCli(['stats', 'web', 'api', '--graph', '--json'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as GraphPayload
      expect(payload.mode).toBe('graph')
      expect(payload.graph).not.toBeNull()
      const graph = payload.graph!
      expect(graph.totalEntries).toBe(2)
      expect(graph.fullEntries).toBe(1)
      expect(graph.rootDirect).toBe(1) // lockfile root declares lodash only
      expect(graph.edges).toBe(2) // root→lodash, lodash→leftpad
      expect(graph.nodes).toBe(3)
      expect(graph.depthHistogram).toEqual([
        { depth: 1, packages: 1 },
        { depth: 2, packages: 1 },
      ])
      expect(graph.unreachable).toBe(1) // @scope/thing — installed but no path from root
      expect(graph.entries[0]).toMatchObject({ displayPath: expect.stringContaining('web'), grade: 'full', file: 'package-lock.json', rootDirect: 1, nodes: 3, edges: 2 })
      expect(graph.entries[1]).toMatchObject({ displayPath: expect.stringContaining('api'), grade: 'manifest', file: null })
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('keeps graph null when the flag is absent', async () => {
    const root = await fixture('graph-off')
    try {
      const run = await runCli(['stats', 'web', '--json'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as GraphPayload
      expect(payload.graph).toBeNull()
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('stays manifest-grade (exit ok) when the lockfile is v1/legacy', async () => {
    const root = await fixture('graph-legacy')
    try {
      const run = await runCli(['stats', 'legacy', '--graph', '--json'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as GraphPayload
      expect(payload.graph!.fullEntries).toBe(0)
      expect(payload.graph!.totalEntries).toBe(1)
      expect(payload.graph!.entries[0].grade).toBe('manifest')
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('rejects --graph outside stats and in global mode', async () => {
    const root = await tmpRoot('graph-guard')
    try {
      const mapRun = await runCli(['map', '.', '--graph'], { cwd: root, home: root })
      expect(mapRun.code).toBe(1)
      expect(mapRun.stderr).toContain('--graph only work with the stats command')
      const globalRun = await runCli(['stats', '--global', '--graph'], { cwd: root, home: root })
      expect(globalRun.code).toBe(1)
      expect(globalRun.stderr).toContain('shape per-project stats')
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe('nmh why — lockfile-grade required-by', () => {
  it('finds the transitive requirer the sibling-manifest scan cannot', async () => {
    const root = await fixture('graph-why')
    try {
      // leftpad: root manifest declares it, but the LOCKFILE-level requirer is lodash
      const run = await runCli(['why', 'leftpad', 'web'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('lockfile-grade')
      expect(run.stdout).toContain('lodash')
      expect(run.stdout).toContain('(lockfile)')

      const json = await runCli(['why', 'leftpad', 'web', '--json'], { cwd: root, home: root })
      const payload = JSON.parse(json.stdout) as WhyPayload
      expect(payload.instances[0].requiredByGrade).toBe('lockfile')
      expect(payload.instances[0].requiredBy).toEqual([{ name: 'lodash', version: null, range: '^1.2.0', field: 'lockfile' }])
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('falls back to the sibling-manifest scan when no lockfile exists', async () => {
    const root = await fixture('graph-why-manifest')
    try {
      const run = await runCli(['why', 'chalk', 'api', '--json'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as WhyPayload
      expect(payload.instances[0].requiredByGrade).toBe('manifest')
      expect(payload.instances[0].requiredBy).toEqual([])
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})
