import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseYarnLock, readProjectLockGraph, readYarnLockGraph } from '../src/core/lockfile.ts'
import { runCli, tmpRoot } from './helpers.ts'

interface GraphPayload {
  mode?: string
  graph: {
    fullEntries: number
    totalEntries: number
    rootDirect: number
    edges: number
    nodes: number
    depthHistogram: Array<{ depth: number; packages: number }>
    entries: Array<{ pm: string; file: string | null; grade: 'full' | 'manifest' }>
  } | null
}

const CLASSIC = `# yarn lockfile v1


lodash@^4.17.20, lodash@^4.17.21:
  version "4.17.21"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"
  dependencies:
    leftpad "^1.2.0"

leftpad@^1:
  version "1.3.0"
`

describe('yarn.lock v1 parser (unit)', () => {
  it('names entries (quoted/scope specs merge), keeps dependencies edges', () => {
    const text = `# yarn lockfile v1

"@scope/pkg@^1.0.0", "@scope/pkg@^1.2.0":
  version "1.2.7"
  dependencies:
    helper "^2"

helper@^2:
  version "2.0.0"
`
    const parsed = parseYarnLock(text)
    expect(parsed).not.toBeNull()
    expect([...parsed!.nodeNames]).toEqual(['@scope/pkg', 'helper'])
    expect(parsed!.edges).toEqual([{ from: '@scope/pkg', to: 'helper', range: '^2' }])
  })

  it('refuses Berry YAML lockfiles and files with no entries', () => {
    expect(parseYarnLock('# yarn lockfile v2\n\n__metadata:\n  version: 8\n\n"lodash@npm:^4.17.21":\n  version: 4.17.21\n')).toBeNull()
    expect(parseYarnLock('# only comments here\n')).toBeNull()
  })
})

describe('readYarnLockGraph / dispatcher (fs-level)', () => {
  it('roots come from package.json; tree edges from the lockfile; pm=yarn', async () => {
    const root = await tmpRoot('yarn-dispatch')
    const project = path.join(root, 'app')
    await fs.mkdir(project, { recursive: true })
    await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'app', dependencies: { lodash: '^4.17.20' }, devDependencies: { chalk: '^4' } }))
    await fs.writeFile(path.join(project, 'yarn.lock'), CLASSIC)

    const graph = await readYarnLockGraph(project)
    expect(graph).not.toBeNull()
    expect(graph!.pm).toBe('yarn')
    expect(graph!.file).toBe('yarn.lock')
    expect(graph!.rootDirect).toBe(2)
    expect(graph!.nodes).toBe(2)
    expect(graph!.edges).toBe(3) // root→lodash, root→chalk (devDep), lodash→leftpad
    expect(graph!.depthHistogram).toEqual([
      { depth: 1, packages: 2 }, // lodash + chalk (chalk is a root-only mention, not a lockfile node)
      { depth: 2, packages: 1 }, // leftpad via lodash
    ])

    // dispatcher prefers nothing when npm lockfile is absent — yarn wins
    const dispatched = await readProjectLockGraph(project)
    expect(dispatched!.pm).toBe('yarn')
  })

  it('dispatcher keeps npm priority when both lockfiles exist', async () => {
    const root = await tmpRoot('yarn-both')
    const project = path.join(root, 'app')
    await fs.mkdir(project, { recursive: true })
    await fs.writeFile(
      path.join(project, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { a: '^1' } }, 'node_modules/a': { version: '1.0.0' } } }),
    )
    await fs.writeFile(path.join(project, 'yarn.lock'), CLASSIC)
    const graph = await readProjectLockGraph(project)
    expect(graph!.pm).toBe('npm')
  })
})

describe('nmh stats --graph with a yarn project (e2e)', () => {
  it('reports the yarn graph honestly; grade flips to yarn pm rows', async () => {
    const root = await tmpRoot('yarn-e2e')
    const project = path.join(root, 'app')
    await fs.mkdir(path.join(project, 'node_modules', 'lodash'), { recursive: true })
    await fs.writeFile(path.join(project, 'node_modules', 'lodash', 'package.json'), JSON.stringify({ name: 'lodash', version: '4.17.21' }))
    await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'app', dependencies: { lodash: '^4.17.20' } }))
    await fs.writeFile(path.join(project, 'yarn.lock'), CLASSIC)
    try {
      const run = await runCli(['stats', 'app', '--graph', '--json'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as GraphPayload
      expect(payload.mode).toBe('graph')
      expect(payload.graph!.fullEntries).toBe(1)
      expect(payload.graph!.entries[0]).toMatchObject({ pm: 'yarn', file: 'yarn.lock', grade: 'full' })
      expect(payload.graph!.rootDirect).toBe(1)
      expect(payload.graph!.edges).toBe(2) // root→lodash + lodash→leftpad (leftpad not installed)
      expect(payload.graph!.nodes).toBe(2)
      // text: grades printed with the yarn file name
      const text = await runCli(['stats', 'app', '--graph'], { cwd: root, home: root })
      expect(text.stdout).toContain('yarn.lock')
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it(`budget: a Berry lockfile stays manifest-grade (no fake numbers)`, async () => {
    const root = await tmpRoot('yarn-berry')
    const project = path.join(root, 'app')
    await fs.mkdir(path.join(project, 'node_modules', 'lodash'), { recursive: true })
    await fs.writeFile(path.join(project, 'node_modules', 'lodash', 'package.json'), JSON.stringify({ name: 'lodash', version: '4.17.21' }))
    await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'app', dependencies: { lodash: '^4' } }))
    await fs.writeFile(
      path.join(project, 'yarn.lock'),
      '# yarn lockfile v2\n\n__metadata:\n  version: 8\n\n"lodash@npm:^4":\n  version: 4.17.21\n  resolution: "lodash@npm:4.17.21"\n',
    )
    try {
      const run = await runCli(['stats', 'app', '--graph', '--json'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as GraphPayload
      expect(payload.graph!.fullEntries).toBe(0)
      expect(payload.graph!.entries[0]).toMatchObject({ grade: 'manifest', file: null })
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})
