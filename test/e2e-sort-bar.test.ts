import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'

const execFileAsync = promisify(execFile)
const DAY = 86_400_000
const KB = 1024

interface ScanPayload {
  entries: Array<{ path: string; size: number; idleDays?: number }>
}

async function rmTree(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
}

/** Project whose node_modules ships one file of exactly `bytes`, plus a pinned git age. */
async function project(root: string, name: string, bytes: number, idleDays: number | null): Promise<string> {
  const dir = path.join(root, name)
  await fs.mkdir(path.join(dir, 'node_modules', 'gp'), { recursive: true })
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
  await fs.writeFile(path.join(dir, 'node_modules', 'gp', 'package.json'), JSON.stringify({ name: 'gp', version: '1.0.0' }))
  await fs.writeFile(path.join(dir, 'node_modules', 'gp', 'blob.bin'), Buffer.alloc(bytes))
  if (idleDays !== null) {
    await execFileAsync('git', ['init'], { cwd: dir })
    await execFileAsync('git', ['add', '.'], { cwd: dir })
    const stamp = new Date(Date.now() - idleDays * DAY).toISOString()
    await execFileAsync(
      'git',
      ['-c', 'user.email=test@nmh.local', '-c', 'user.name=nmh-test', 'commit', '-m', `pinned ${name}`, '--no-gpg-sign'],
      { cwd: dir, env: { ...process.env, GIT_COMMITTER_DATE: stamp, GIT_AUTHOR_DATE: stamp } },
    )
  }
  return path.join(dir, 'node_modules')
}

const baseName = (entryPath: string): string => path.basename(path.dirname(entryPath))

describe('sort + share bar (v1.1)', () => {
  it('default order stays size-desc; --sort path switches to alphabetical', async () => {
    const root = await tmpRoot('sort-basic')
    try {
      await project(root, 'zzz-big', 40 * KB, null)
      await project(root, 'mmm-mid', 8 * KB, null)
      await project(root, 'aaa-tiny', 2 * KB, null)

      const def = JSON.parse((await runCli(['--dir', root, '--json'], { home: root })).stdout) as ScanPayload
      expect(def.entries.map((entry) => baseName(entry.path))).toEqual(['zzz-big', 'mmm-mid', 'aaa-tiny'])

      const byPath = JSON.parse((await runCli(['--dir', root, '--sort', 'path', '--json'], { home: root })).stdout) as ScanPayload
      expect(byPath.entries.map((entry) => baseName(entry.path))).toEqual(['aaa-tiny', 'mmm-mid', 'zzz-big'])
    } finally {
      await rmTree(root)
    }
  })

  it('--sort idle orders oldest project first and turns the activity probe on without --stale', async () => {
    const root = await tmpRoot('sort-idle')
    try {
      await project(root, 'young', 2 * KB, 3)
      await project(root, 'ancient', 2 * KB, 200)
      await project(root, 'aging', 2 * KB, 60)

      const run = await runCli(['--dir', root, '--sort', 'idle', '--json'], { home: root })
      expect(run.code).toBe(0)
      const json = JSON.parse(run.stdout) as ScanPayload
      expect(json.entries.map((entry) => baseName(entry.path))).toEqual(['ancient', 'aging', 'young'])
      for (const entry of json.entries) {
        expect(entry.idleDays).toBeDefined()
        expect(entry.idleDays).toBeGreaterThanOrEqual(3)
      }
    } finally {
      await rmTree(root)
    }
  })

  it('--sort mtime orders newest folder first; guards mirror the --size family', async () => {
    const root = await tmpRoot('sort-mtime')
    try {
      const newest = await project(root, 'newest', 2 * KB, null)
      const oldest = await project(root, 'oldest', 2 * KB, null)
      const now = Date.now()
      // entry.mtimeMs is the node_modules folder's own mtime — touch the folders directly
      await fs.utimes(newest, new Date(now), new Date(now - 10))
      await fs.utimes(oldest, new Date(now), new Date(now - 30 * DAY))

      const run = await runCli(['--dir', root, '--sort', 'mtime', '--json'], { home: root })
      expect(run.code).toBe(0)
      const json = JSON.parse(run.stdout) as ScanPayload
      expect(json.entries.map((entry) => baseName(entry.path))).toEqual(['newest', 'oldest'])

      const bare = await runCli(['--dir', root, '--sort'], { home: root })
      expect(bare.code).toBe(1)
      expect(bare.stderr).toContain('--sort needs a value')
      const twice = await runCli(['--dir', root, '--sort', 'path', '--sort', 'mtime'], { home: root })
      expect(twice.code).toBe(1)
      expect(twice.stderr).toContain('--sort given more than once')
      const bad = await runCli(['--dir', root, '--sort', 'color'], { home: root })
      expect(bad.code).toBe(1)
      expect(bad.stderr).toContain('invalid --sort')
    } finally {
      await rmTree(root)
    }
  })

  it('the table gains a Share bar column scaled to the biggest entry (never in --json)', async () => {
    const root = await tmpRoot('sort-bar')
    try {
      await project(root, 'huge', 60 * KB, null)
      await project(root, 'tiny', 2 * KB, null)
      const table = await runCli(['--dir', root, '--sort', 'path'], { home: root })
      expect(table.code).toBe(0)
      expect(table.stdout).toContain('Share')
      expect(table.stdout).toContain('█')
      const json = await runCli(['--dir', root, '--json'], { home: root })
      expect(json.stdout).not.toContain('█')
      expect(json.stdout).not.toContain('Share')
    } finally {
      await rmTree(root)
    }
  })
})
