import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'
import { trashBackend } from '../src/utils/trash.ts'

interface DeletePayload {
  deleted: number
  results: Array<{ path: string; status: string; backend?: 'system' | 'nmh' }>
  trashBatch?: string
  trashFallback?: boolean
}

async function rmTree(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
}

async function victim(root: string, name = 'proj'): Promise<string> {
  const dir = path.join(root, name, 'node_modules')
  await fs.mkdir(path.join(dir, 'gp'), { recursive: true })
  await fs.writeFile(path.join(dir, 'gp', 'package.json'), JSON.stringify({ name: 'gp', version: '1.0.0' }))
  return dir
}

describe('trash backends (v1.1) — --trash=system|nmh + restorable fallback', () => {
  it('explicit --trash=nmh: victim lands under ~/.nmh/trash with a manifest for restore', async () => {
    const root = await tmpRoot('trash-nmh')
    try {
      const entry = await victim(root)
      const run = await runCli(['--dir', root, '--delete=trash', '--trash=nmh', '-y', '--json'], { home: root })
      expect(run.code).toBe(0)
      const json = JSON.parse(run.stdout) as DeletePayload
      expect(json.deleted).toBe(1)
      expect(json.results[0]?.backend).toBe('nmh')
      expect(json.trashBatch).toContain(path.join('.nmh', 'trash', 'trash-'))
      expect(json.trashFallback).toBeUndefined()
      await expect(fs.access(entry)).rejects.toBeTruthy()

      const manifest = await fs.readFile(path.join(json.trashBatch!, 'manifest.jsonl'), 'utf8')
      const row = JSON.parse(manifest.trim()) as { originalPath: string; storedAs: string; via: string }
      expect(row.originalPath).toBe(entry)
      expect(row.via).toBe('explicit')
      await expect(fs.access(path.join(json.trashBatch!, row.storedAs))).resolves.toBeUndefined()
    } finally {
      await rmTree(root)
    }
  })

  it('system trash with no backend falls back to the nmh trash — loudly, still restorable', async () => {
    const root = await tmpRoot('trash-fallback')
    try {
      const entry = await victim(root)
      const jsonRun = await runCli(['--dir', root, '--delete=trash', '-y', '--json'], {
        home: root,
        envExtra: { NMH_TRASH_BACKEND: 'none' },
      })
      expect(jsonRun.code).toBe(0)
      const json = JSON.parse(jsonRun.stdout) as DeletePayload
      expect(json.results[0]?.backend).toBe('nmh')
      expect(json.trashFallback).toBe(true)
      expect(json.trashBatch).toContain(path.join('.nmh', 'trash', 'trash-'))
      await expect(fs.access(entry)).rejects.toBeTruthy()

      // the plain run announces the fallback on stderr (side-channel, stdout stays clean)
      const plainRoot = await tmpRoot('trash-fallback2')
      await victim(plainRoot)
      const plain = await runCli(['--dir', plainRoot, '--delete=trash', '-y'], {
        home: plainRoot,
        envExtra: { NMH_TRASH_BACKEND: 'none' },
      })
      expect(plain.code).toBe(0)
      expect(plain.stderr).toContain('fell back to the restorable nmh trash')
      await rmTree(plainRoot)
    } finally {
      await rmTree(root)
    }
  })

  it('--trash=system with a working gio backend keeps the v1.0 path (no nmh batch)', async () => {
    // Meaningful only where gio actually exists (it is forced, but the CLI must
    // be able to run it): the natural detection gates the branch per platform.
    if (await trashBackend() !== 'linux-gio') return
    const root = await tmpRoot('trash-system')
    try {
      const entry = await victim(root)
      const run = await runCli(['--dir', root, '--delete=trash', '--trash=system', '-y', '--json'], {
        home: root,
        envExtra: { NMH_TRASH_BACKEND: 'linux-gio' },
      })
      expect(run.code).toBe(0)
      const json = JSON.parse(run.stdout) as DeletePayload
      expect(json.results[0]?.backend).toBe('system')
      expect(json.trashBatch).toBeUndefined()
      await expect(fs.access(entry)).rejects.toBeTruthy()
    } finally {
      await rmTree(root)
    }
  })

  it('guards: bare/multi/invalid exit 1; --trash with hard delete is refused; scans just warn', async () => {
    const root = await tmpRoot('trash-guards')
    try {
      await victim(root)
      const bare = await runCli(['--dir', root, '--delete=trash', '--trash', '-y'], { home: root })
      expect(bare.code).toBe(1)
      expect(bare.stderr).toContain('--trash needs a value')
      const twice = await runCli(['--dir', root, '--delete=trash', '--trash=nmh', '--trash=system', '-y'], { home: root })
      expect(twice.code).toBe(1)
      expect(twice.stderr).toContain('--trash given more than once')
      const bad = await runCli(['--dir', root, '--delete=trash', '--trash=fast', '-y'], { home: root })
      expect(bad.code).toBe(1)
      expect(bad.stderr).toContain('invalid --trash')
      const hard = await runCli(['--dir', root, '--delete=hard', '--trash=nmh', '-y'], { home: root })
      expect(hard.code).toBe(1)
      expect(hard.stderr).toContain('permanent by design')
      const scan = await runCli(['--dir', root, '--trash=nmh', '--json'], { home: root })
      expect(scan.code).toBe(0)
      expect(scan.stderr).toContain('ignored for scans')
    } finally {
      await rmTree(root)
    }
  })

  it('manifest records via=fallback when the system facility was the ask but was absent', async () => {
    const root = await tmpRoot('trash-via')
    try {
      await victim(root)
      const run = await runCli(['--dir', root, '--delete=trash', '-y', '--json'], {
        home: root,
        envExtra: { NMH_TRASH_BACKEND: 'none' },
      })
      const json = JSON.parse(run.stdout) as DeletePayload
      const manifest = await fs.readFile(path.join(json.trashBatch!, 'manifest.jsonl'), 'utf8')
      const row = JSON.parse(manifest.trim()) as { via: string }
      expect(row.via).toBe('fallback')
    } finally {
      await rmTree(root)
    }
  })
})
