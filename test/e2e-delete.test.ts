import path from 'node:path'
import fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { monorepoFixture, runCli, tmpRoot } from './helpers.ts'
import { trashBackend, type TrashBackend } from '../src/utils/trash.ts'

const exists = async (p: string): Promise<boolean> => !!(await fs.lstat(p).then(() => true, () => false))

describe('delete flow e2e (spawned CLI, non-TTY)', () => {
  it('--dry-run touches nothing and reports the plan (JSON)', async () => {
    const fx = await monorepoFixture('dry')
    try {
      const run = await runCli(['--dir', fx.paths.apiEntry, '--delete=hard', '--dry-run', '--json', '-y'])
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as { dryRun: boolean; results: Array<{ status: string }> }
      expect(payload.dryRun).toBe(true)
      expect(payload.results[0].status).toBe('would-hard')
      expect(await exists(fx.paths.apiEntry)).toBe(true)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('text dry-run shows [DRY RUN] and folder count', async () => {
    const fx = await monorepoFixture('dry-text')
    try {
      const run = await runCli(['--dir', fx.root, '--delete=hard', '--dry-run'])
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('[DRY RUN] Would DELETE (permanent) 4 folder(s)')
      expect(await exists(fx.paths.webEntry)).toBe(true)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('non-TTY without --yes refuses everything (exit 1, folder intact)', async () => {
    const fx = await monorepoFixture('refuse')
    try {
      const run = await runCli(['--dir', fx.paths.apiEntry, '--delete=hard'])
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('non-interactive shell')
      expect(await exists(fx.paths.apiEntry)).toBe(true)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('--delete without a value in non-TTY is a usage error (exit 1)', async () => {
    const fx = await monorepoFixture('no-mode')
    try {
      const run = await runCli(['--dir', fx.paths.apiEntry, '--delete', '-y'])
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('interactive terminal')
      expect(await exists(fx.paths.apiEntry)).toBe(true)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('hard delete -y: real rm, exit 0, JSON says deleted, recovery log written under $HOME/.nmh/logs', async () => {
    const fx = await monorepoFixture('hard')
    const fakeHome = await tmpRoot('fakehome')
    try {
      const run = await runCli(['--dir', fx.paths.apiEntry, '--delete=hard', '-y', '--json'], { home: fakeHome })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as { freed: number; results: Array<{ status: string; size: number }> }
      expect(payload.results[0].status).toBe('deleted')
      expect(payload.freed).toBeGreaterThanOrEqual(4096)
      expect(await exists(fx.paths.apiEntry)).toBe(false)

      const logs = await fs.readdir(path.join(fakeHome, '.nmh', 'logs'))
      expect(logs.length).toBeGreaterThanOrEqual(1)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
      await fs.rm(fakeHome, { recursive: true, force: true })
    }
  })

  it('self-symlink loop target → guard exit 3, nothing touched', async () => {
    const fx = await monorepoFixture('loop-e2e')
    try {
      const run = await runCli(['--dir', fx.paths.loopEntry, '--delete=hard', '-y'])
      expect(run.code).toBe(3)
      expect(run.stderr).toContain('refusing')
      expect(await exists(fx.paths.loop)).toBe(true)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('trash fallback (system backend absent): restorable nmh trash, loud warning, rc 0 (v1.1)', async () => {
    // The backend decision is forced hermetically (NMH_TRASH_BACKEND=none) so this
    // single test covers the fallback branch on EVERY platform — Windows runners
    // do have a Recycle Bin, Linux CI sometimes has neither gio nor trash-cli,
    // and the natural branch is covered by the OS-specific test below.
    const fx = await monorepoFixture('trash-none')
    try {
      const run = await runCli(
        ['--dir', fx.paths.mobileEntry, '--delete=trash', '-y', '--json'],
        { home: fx.root, envExtra: { NMH_TRASH_BACKEND: 'none' } },
      )
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as {
        results: Array<{ status: string; backend: string }>
        trashBatch?: string
        trashFallback?: boolean
      }
      expect(payload.results[0].status).toBe('trashed')
      expect(payload.results[0].backend).toBe('nmh')
      expect(payload.trashBatch).toBeTruthy() // batch dir for the restore
      expect(payload.trashFallback).toBe(true) // the loud claim lives in the payload too
      expect(await exists(fx.paths.mobileEntry)).toBe(false)
      // restorability: the batch manifest records the original path (JSON-escaped)
      const batch = payload.trashBatch as string
      const raw = await fs.readFile(path.join(batch, 'manifest.jsonl'), 'utf8')
      const rows = raw.trim().split('\n').map((line) => JSON.parse(line) as { originalPath: string })
      expect(rows.map((row) => row.originalPath)).toContain(fx.paths.mobileEntry)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('trash system mode: the real OS backend when one is detected', async () => {
    const backend: TrashBackend = await trashBackend()
    // Windows Recycle Bin via PowerShell cannot be verified from this Linux-authored
    // suite (SendToRecycleBin behavior differs under CI); its path stays a follow-up —
    // the fallback test above keeps the delete flow itself covered everywhere.
    if (backend === 'none' || process.platform === 'win32') return
    const fx = await monorepoFixture('trash')
    try {
      const run = await runCli(['--dir', fx.paths.mobileEntry, '--delete=trash', '-y', '--json'], { home: fx.root })
      expect(run.code).toBe(0)
      expect(JSON.parse(run.stdout).results[0].status).toBe('trashed')
      expect(await exists(fx.paths.mobileEntry)).toBe(false)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('clean uses trash by default and filter semantics; empty target → exit 2', async () => {
    const backend: TrashBackend = await trashBackend()
    const fx = await monorepoFixture('clean')
    const empty = await tmpRoot('clean-empty')
    try {
      const emptyRun = await runCli(['clean', fx.paths.outside])
      expect(emptyRun.code).toBe(2)

      if (backend !== 'none') {
        const run = await runCli(['clean', fx.root, '-y', '--json'])
        expect(run.code).toBe(0)
        // every entry was safe here; sizes were measured — folders gone afterwards
        expect(await exists(fx.paths.webEntry)).toBe(false)
        expect(await exists(fx.paths.apiEntry)).toBe(false)
      }
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
      await fs.rm(empty, { recursive: true, force: true })
    }
  })

  it('victims directly inside $HOME refuse to delete (v0.9 guard hardening)', async () => {
    const root = await tmpRoot('guard-home')
    try {
      await fs.mkdir(path.join(root, 'node_modules', 'guineapig'), { recursive: true })
      await fs.writeFile(path.join(root, 'node_modules', 'guineapig', 'package.json'), '{"name":"guineapig","version":"1.0.0"}')
      // walk-discovered victim (target = home root itself)
      const walked = await runCli(['--dir', '.', '--delete=hard', '-y'], { cwd: root, home: root })
      expect(walked.code, walked.stderr).toBe(3)
      expect(walked.stderr).toContain('refusing: node_modules directly inside the home directory')
      expect(await exists(path.join(root, 'node_modules'))).toBe(true)
      // direct target pinned onto the very same victim
      const direct = await runCli(['--dir', 'node_modules', '--delete=hard', '-y'], { cwd: root, home: root })
      expect(direct.code, direct.stderr).toBe(3)
      expect(direct.stderr).toContain('refusing')
      expect(await exists(path.join(root, 'node_modules'))).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('--json without --yes refuses the delete — gate no longer trusts the TTY (v0.9.2)', async () => {
    const fx = await monorepoFixture('json-noyes')
    try {
      const run = await runCli(['--dir', fx.paths.apiEntry, '--json', '--delete=hard'])
      expect(run.code).toBe(1)
      // wording is TTY-blind now: --json has no interactive prompt slot on either branch
      expect(run.stderr).toContain('--json deletes require an explicit --yes')
      expect(await exists(fx.paths.apiEntry)).toBe(true)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('a delete op aimed at the filesystem root refuses before scanning (v0.9.4)', async () => {
    const run = await runCli(['--dir', '/', '--delete=trash', '-y'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('refusing a delete op over the filesystem root')
    // the refusal is pre-scan: no giant walk even started
  })
})
