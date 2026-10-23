import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseMiniYaml, parsePnpmDoc, readProjectLockGraph } from '../src/core/lockfile.ts'
import { runCli, tmpRoot } from './helpers.ts'

interface GraphPayload {
  mode?: string
  graph: {
    fullEntries: number
    rootDirect: number
    edges: number
    nodes: number
    depthHistogram: Array<{ depth: number; packages: number }>
    entries: Array<{ pm: string; file: string | null; grade: 'full' | 'manifest' }>
  } | null
}

const V9 = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      lodash:
        specifier: ^4.17.0
        version: 4.17.21
    devDependencies:
      chalk:
        specifier: ^5.0.0
        version: 5.3.0

packages:

  chalk@5.3.0:
    resolution: {integrity: sha512-dowa}
    engines: {node: '>=14'}

  lodash@4.17.21:
    resolution: {integrity: sha512-v2k}

  leftpad@1.3.0:
    resolution: {integrity: sha512-aaa}

snapshots:

  chalk@5.3.0: {}

  lodash@4.17.21(@types/lodash@4.14.202):
    dependencies:
      leftpad: 1.3.0

  leftpad@1.3.0: {}
`

const V6 = `lockfileVersion: '6.0'

importers:

  .:
    dependencies:
      lodash:
        specifier: ^4.17.0
        version: 4.17.21

packages:

  lodash@4.17.21:
    resolution: {integrity: sha512-v2k}
    dependencies:
      leftpad: 1.3.0

  leftpad@1.3.0:
    resolution: {integrity: sha512-aaa}
`

async function pnpmProject(label: string, lock: string): Promise<string> {
  const root = await tmpRoot(label)
  const project = path.join(root, 'app')
  await fs.mkdir(path.join(project, 'node_modules', 'lodash'), { recursive: true })
  await fs.writeFile(path.join(project, 'node_modules', 'lodash', 'package.json'), JSON.stringify({ name: 'lodash', version: '4.17.21' }))
  await fs.mkdir(path.join(project, 'node_modules', 'leftpad'), { recursive: true })
  await fs.writeFile(path.join(project, 'node_modules', 'leftpad', 'package.json'), JSON.stringify({ name: 'leftpad', version: '1.3.0' }))
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'app', dependencies: { lodash: '^4.17.0' } }))
  await fs.writeFile(path.join(project, 'pnpm-lock.yaml'), lock)
  return root
}

describe('mini-YAML + pnpm doc (unit)', () => {
  it('parses indentation, inline flows and quoted keys of the lockfile subset', () => {
    const doc = parseMiniYaml(V9)
    expect(doc.lockfileVersion).toBe('9.0')
    const importers = doc.importers as Record<string, Record<string, Record<string, Record<string, string>>>>
    expect(importers['.']?.dependencies?.lodash?.specifier).toBe('^4.17.0')
    const packages = doc.packages as Record<string, Record<string, Record<string, string>>>
    expect(packages['chalk@5.3.0']?.resolution?.integrity).toBe('sha512-dowa')
    // peer-suffixes snap off the name; parsePnpmDoc also emits	root-importer edges
    const parsed = parsePnpmDoc(doc)
    expect(parsed!.nodeNames.has('lodash')).toBe(true)
    expect(parsed!.nodeNames.size).toBe(3) // chalk, lodash, leftpad — @types/lodash lives in the suffix only
    expect(parsed!.edges.filter((edge) => edge.from !== '«root»')).toEqual([{ from: 'lodash', to: 'leftpad', range: '1.3.0' }])
    expect(parsed!.rootDirect).toBe(2)
  })

  it('v6.0 keeps its edges in packages:; shapes we cannot trust are refused', () => {
    const v6 = parsePnpmDoc(parseMiniYaml(V6))
    expect(v6!.rootDirect).toBe(1)
    expect(v6!.edges.filter((edge) => edge.from !== '«root»')).toEqual([{ from: 'lodash', to: 'leftpad', range: '1.3.0' }])

    expect(parsePnpmDoc(parseMiniYaml('settings:\n  autoInstallPeers: true\n'))).toBeNull()
    expect(parsePnpmDoc(parseMiniYaml('='))).toBeNull()
  })
})

describe('pnpm e2e (--graph / --why via the dispatcher)', () => {
  it('stats --graph reports pm pnpm with importer-declared rootDirect', async () => {
    const root = await pnpmProject('pnpm-e2e', V9)
    try {
      const run = await runCli(['stats', 'app', '--graph', '--json'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as GraphPayload
      expect(payload.mode).toBe('graph')
      expect(payload.graph!.fullEntries).toBe(1)
      expect(payload.graph!.entries[0]).toMatchObject({ pm: 'pnpm', file: 'pnpm-lock.yaml', grade: 'full' })
      expect(payload.graph!.rootDirect).toBe(2) // lodash (deps) + chalk (devDeps) from the root importer
      expect(payload.graph!.edges).toBe(3) // root→lodash, root→chalk, lodash→leftpad
      expect(payload.graph!.nodes).toBe(3)
      expect(payload.graph!.depthHistogram).toEqual([{ depth: 1, packages: 2 }, { depth: 2, packages: 1 }])

      const text = await runCli(['stats', 'app', '--graph'], { cwd: root, home: root })
      expect(text.stdout).toContain('pnpm-lock.yaml')
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('why finds lockfile-grade requirers from the pnpm snapshots', async () => {
    const root = await pnpmProject('pnpm-why', V9)
    try {
      const run = await runCli(['why', 'leftpad', 'app'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('lodash → 1.3.0 (lockfile)')
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})
