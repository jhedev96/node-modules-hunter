import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'

interface ScanPayload {
  entries: Array<{ path: string }>
}

async function rmTree(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
}

/** A project at `<root>/<segments>` holding a bare node_modules with one package. */
async function makeNodeModules(root: string, ...segments: string[]): Promise<string> {
  const dir = path.join(root, ...segments, 'node_modules')
  await fs.mkdir(path.join(dir, 'gp'), { recursive: true })
  await fs.writeFile(path.join(dir, 'gp', 'package.json'), JSON.stringify({ name: 'gp', version: '1.0.0' }))
  return dir
}

/**
 * v1.1 default-flip fixture: system noise where node_modules can hide but never
 * belongs — Trash variants (classic + freedesktop uid), the macOS Library tree,
 * and a bundled .app — plus one ordinary project for the baseline.
 */
async function makeFixture(root: string): Promise<void> {
  await makeNodeModules(root, 'normal')
  await makeNodeModules(root, '.Trash', 'project-a')
  await makeNodeModules(root, '.Trash-1000', 'project-b')
  await makeNodeModules(root, 'Library', 'Dev', 'project-c')
  await makeNodeModules(root, 'MyApp.app', 'Contents', 'Resources', 'app')
}

describe('system-dir skip defaults + --no-skip (v1.1)', () => {
  it('discovery hides .Trash*, Library/, and *.app by default (v1.0 walked everywhere)', async () => {
    const root = await tmpRoot('noskip-default')
    try {
      await makeFixture(root)
      const run = await runCli(['--dir', root, '--json'], { home: root })
      expect(run.code).toBe(0)
      const json = JSON.parse(run.stdout) as ScanPayload
      expect(json.entries.map((entry) => entry.path)).toEqual([path.join(root, 'normal', 'node_modules')])
    } finally {
      await rmTree(root)
    }
  })

  it('--no-skip reveals the hidden trees and keeps .git skipped regardless', async () => {
    const root = await tmpRoot('noskip-flag')
    try {
      await makeFixture(root)
      const run = await runCli(['--dir', root, '--no-skip', '--json'], { home: root })
      expect(run.code).toBe(0)
      const paths = new Set((JSON.parse(run.stdout) as ScanPayload).entries.map((entry) => entry.path))
      expect(paths.has(path.join(root, 'normal', 'node_modules'))).toBe(true)
      expect(paths.has(path.join(root, '.Trash', 'project-a', 'node_modules'))).toBe(true)
      expect(paths.has(path.join(root, '.Trash-1000', 'project-b', 'node_modules'))).toBe(true)
      expect(paths.has(path.join(root, 'Library', 'Dev', 'project-c', 'node_modules'))).toBe(true)
      expect(paths.has(path.join(root, 'MyApp.app', 'Contents', 'Resources', 'app', 'node_modules'))).toBe(true)

      // .git stays skipped even under --no-skip: git internals never hold a node_modules
      await fs.mkdir(path.join(root, '.git', 'objects', 'ab'), { recursive: true })
      await fs.mkdir(path.join(root, '.git', 'node_modules', 'gp'), { recursive: true })
      const again = await runCli(['--dir', root, '--no-skip', '--json'], { home: root })
      const paths2 = new Set((JSON.parse(again.stdout) as ScanPayload).entries.map((entry) => entry.path))
      expect(paths2.size).toBe(5)
      expect([...paths2].some((entry) => entry.includes('.git'))).toBe(false)
    } finally {
      await rmTree(root)
    }
  })

  it('direct targets bypass discovery skips — node_modules inside Library stays measurable', async () => {
    const root = await tmpRoot('noskip-direct')
    try {
      const direct = await makeNodeModules(root, 'Library', 'Dev', 'project-c')
      const run = await runCli(['--dir', direct, '--json'], { home: root })
      expect(run.code).toBe(0)
      const json = JSON.parse(run.stdout) as ScanPayload
      expect(json.entries.map((entry) => entry.path)).toEqual([direct])
    } finally {
      await rmTree(root)
    }
  })
})
