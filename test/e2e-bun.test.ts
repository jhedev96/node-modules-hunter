import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBunDoc, readProjectLockGraph, stripJsonC } from '../src/core/lockfile.ts'
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

const BUN = `{
  // bun writes jsonc-ish text lockfiles
  "lockfileVersion": 1,
  "workspaces": {
    ".": {
      "name": "app",
      "dependencies": {
        "typescript": "5.8.3",
      },
    },
  },
  "packages": {
    "@babel/traverse@7.23.6": {
      "dependencies": {
        "@babel/types": "^7.23.6",
        "debug": "4.3.4"
      }
    },
    "typescript@5.8.3": [ "5.8.3", {}, ["@babel/traverse@7.23.6"] ],
    "standalone@1.0.0": [ "1.0.0", ["parent-only-string-mentions"] ],
  }
}`

async function bunProject(label: string, withBinaryOnly = false): Promise<string> {
  const root = await tmpRoot(label)
  const project = path.join(root, 'app')
  for (const pkg of ['typescript', '@babel/traverse', 'standalone']) {
    await fs.mkdir(path.join(project, 'node_modules', ...pkg.split('/')), { recursive: true })
    await fs.writeFile(path.join(project, 'node_modules', pkg, 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0' }))
  }
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'app', dependencies: { typescript: '^5.8' } }))
  if (!withBinaryOnly) await fs.writeFile(path.join(project, 'bun.lock'), BUN)
  else await fs.writeFile(path.join(project, 'bun.lockb'), Buffer.from('BUNLOCKBIN'))
  return root
}

describe('bun.lock parser (unit)', () => {
  it('tolerates jsonc bits: comments, trailing commas, object-map and compact-array deps', () => {
    const doc = JSON.parse(stripJsonC(BUN)) as Record<string, unknown>
    const parsed = parseBunDoc(doc)
    expect(parsed!.nodeNames).toEqual(new Set(['@babel/traverse', 'typescript', 'standalone']))
    // object-map deps
    expect(parsed!.edges).toContainEqual({ from: '@babel/traverse', to: '@babel/types', range: '^7.23.6' })
    expect(parsed!.edges).toContainEqual({ from: '@babel/traverse', to: 'debug', range: '4.3.4' })
    // compact array deps: third element is a dep-array of 'name@range' strings
    expect(parsed!.edges).toContainEqual({ from: 'typescript', to: '@babel/traverse', range: '@babel/traverse@7.23.6' })
    // version-only strings above deps arrays never become edges; unknown shapes keep nodes
    expect(parsed!.edges.filter((edge) => edge.to === 'parent-only-string-mentions')).toEqual([])
    expect(parsed!.edges.filter((edge) => edge.to === '1.0.0')).toEqual([])
    // root workspace
    expect(parsed!.rootDirect).toBe(1)
    expect(parsed!.edges).toContainEqual({ from: '«root»', to: 'typescript', range: '5.8.3' })
  })
})

describe('bun e2e (dispatcher + --graph / --why)', () => {
  it('stats --graph reports pm bun via bun.lock; dispatcher spots it after pnpm', async () => {
    const root = await bunProject('bun-e2e')
    try {
      const run = await runCli(['stats', 'app', '--graph', '--json'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as GraphPayload
      expect(payload.mode).toBe('graph')
      expect(payload.graph!.fullEntries).toBe(1)
      expect(payload.graph!.entries[0]).toMatchObject({ pm: 'bun', file: 'bun.lock', grade: 'full' })
      expect(payload.graph!.rootDirect).toBe(1)
      expect(payload.graph!.nodes).toBe(3)
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('bun.lockb binary stays manifest-grade honestly (no fake graph)', async () => {
    const root = await bunProject('bun-binary', true)
    try {
      const run = await runCli(['stats', 'app', '--graph', '--json'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as GraphPayload
      expect(payload.graph!.fullEntries).toBe(0)
      expect(payload.graph!.entries[0]).toMatchObject({ grade: 'manifest', file: null })
      expect(payload.graph!.rootDirect).toBe(0)
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('why walks the bun graph for the lockfile-grade requirer', async () => {
    const root = await bunProject('bun-why')
    try {
      const run = await runCli(['why', '@babel/traverse', 'app'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('typescript → @babel/traverse@7.23.6 (lockfile)')
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})
