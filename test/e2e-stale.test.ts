import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'

const execFileAsync = promisify(execFile)
const DAY = 86_400_000

/**
 * Cleanup with retries: the Android fuse layer under the tmpdir sporadically answers
 * unlink with a spurious EPERM during rapid create/delete churn — node's built-in
 * backoff (maxRetries covers EPERM) absorbs it.
 */
async function rmTree(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
}

interface ScanPayload {
  nmh: string
  command: string
  totals: { folders: number; size: number }
  entries: Array<{ path: string; idleDays?: number; activitySource?: string }>
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString()
}

/** Tiny project with a pinned git history (GIT_COMMITTER_DATE drives the idle signal). */
async function gitProject(root: string, name: string, idleDays: number): Promise<string> {
  const dir = path.join(root, name)
  await fs.mkdir(path.join(dir, 'node_modules', 'gp'), { recursive: true })
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  await fs.writeFile(path.join(dir, 'node_modules', 'gp', 'package.json'), JSON.stringify({ name: 'gp', version: '1.0.0' }))
  await execFileAsync('git', ['init'], { cwd: dir })
  await execFileAsync('git', ['add', '.'], { cwd: dir })
  await execFileAsync(
    'git',
    ['-c', 'user.email=test@nmh.local', '-c', 'user.name=nmh-test', 'commit', '-m', `pinned ${name}`, '--no-gpg-sign'],
    { cwd: dir, env: { ...process.env, GIT_COMMITTER_DATE: daysAgoIso(idleDays), GIT_AUTHOR_DATE: daysAgoIso(idleDays) } },
  )
  return dir
}

async function manifestProject(root: string, name: string, idleDays: number): Promise<string> {
  const dir = path.join(root, name)
  await fs.mkdir(path.join(dir, 'node_modules', 'gp'), { recursive: true })
  const pkg = path.join(dir, 'package.json')
  await fs.writeFile(pkg, JSON.stringify({ name, version: '1.0.0' }))
  const stamp = new Date(Date.now() - idleDays * DAY)
  await fs.utimes(pkg, stamp, stamp)
  await fs.writeFile(path.join(dir, 'node_modules', 'gp', 'package.json'), JSON.stringify({ name: 'gp', version: '1.0.0' }))
  return dir
}

describe('stale hunting (v1.1) — git activity signal', () => {
  it('--stale <days> keeps only old-enough projects and labels the source (git wins over fresh manifest)', async () => {
    const root = await tmpRoot('stale-mix')
    try {
      const staleGit = await gitProject(root, 'stale-git', 95)
      await gitProject(root, 'fresh-git', 2)
      const noGit = await manifestProject(root, 'no-git', 100)

      const run = await runCli(['--dir', root, '--stale', '90', '--json'], { home: root })
      expect(run.code).toBe(0)
      const json = JSON.parse(run.stdout) as ScanPayload
      const paths = json.entries.map((entry) => entry.path)
      expect(paths).toContain(path.join(staleGit, 'node_modules'))
      expect(paths).toContain(path.join(noGit, 'node_modules'))
      expect(paths.some((entry) => entry.includes('fresh-git'))).toBe(false)

      const gitEntry = json.entries.find((entry) => entry.path.includes('stale-git'))
      expect(gitEntry?.activitySource).toBe('git')
      expect(gitEntry?.idleDays).toBeGreaterThanOrEqual(90)
      const manifestEntry = json.entries.find((entry) => entry.path.includes('no-git'))
      expect(manifestEntry?.activitySource).toBe('manifest')
      expect(manifestEntry?.idleDays).toBeGreaterThanOrEqual(99)
    } finally {
      await rmTree(root)
    }
  })

  it('a freshly-committed project is alive even when npm install ran yesterday', async () => {
    const root = await tmpRoot('stale-fresh')
    try {
      await gitProject(root, 'active', 0)
      const run = await runCli(['--dir', root, '--stale', '30', '--json'], { home: root })
      expect(run.code).toBe(2)
      const json = JSON.parse(run.stdout) as ScanPayload
      expect(json.entries).toHaveLength(0)
      // the raw scan (no filter) still sees the project — the filter is what drops it
      const raw = await runCli(['--dir', root, '--json'], { home: root })
      expect((JSON.parse(raw.stdout) as ScanPayload).entries).toHaveLength(1)
    } finally {
      await rmTree(root)
    }
  })

  it('the table gains an Idle column when stale data exists; guards mirror the --size family', async () => {
    const root = await tmpRoot('stale-table')
    try {
      await gitProject(root, 'old', 40)
      const run = await runCli(['--dir', root, '--stale', '30'], { home: root })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('Idle')
      expect(run.stdout).toMatch(/\b40d\b/)

      const bare = await runCli(['--dir', root, '--stale'], { home: root })
      expect(bare.code).toBe(1)
      expect(bare.stderr).toContain('--stale needs a value')
      const twice = await runCli(['--dir', root, '--stale', '10', '--stale', '20'], { home: root })
      expect(twice.code).toBe(1)
      expect(twice.stderr).toContain('--stale given more than once')
      const bad = await runCli(['--dir', root, '--stale', 'abc'], { home: root })
      expect(bad.code).toBe(1)
      expect(bad.stderr).toContain('invalid --stale')
      const zero = await runCli(['--dir', root, '--stale', '0'], { home: root })
      expect(zero.code).toBe(1)
      expect(zero.stderr).toContain('invalid --stale')
    } finally {
      await rmTree(root)
    }
  })

  it('delete integration: --stale 97 --delete=trash -y only kills projects idle >= 97 days', async () => {
    const root = await tmpRoot('stale-delete')
    try {
      const mid = await gitProject(root, 'mid-95', 95)
      const old = await manifestProject(root, 'old-100', 100)
      await gitProject(root, 'fresh-2', 2)

      // Backend forced off hermetically: the delete flow itself (stale filter +
      // victim segregation) must hold on every platform; the native windows
      // Recycle-Bin branch is exercised where it is verifiable (see e2e-trash).
      const run = await runCli(
        ['--dir', root, '--stale', '97', '--delete=trash', '-y'],
        { home: root, envExtra: { NMH_TRASH_BACKEND: 'none' } },
      )
      expect(run.code).toBe(0)
      await expect(fs.access(path.join(old, 'node_modules'))).rejects.toBeTruthy()
      await expect(fs.access(path.join(mid, 'node_modules'))).resolves.toBeUndefined()
    } finally {
      await rmTree(root)
    }
  })
})
