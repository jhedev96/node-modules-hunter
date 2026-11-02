import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'

const KB = 1024

interface ScanPayload {
  code?: number
  entries: Array<{ path: string; size: number; packageCount: number }>
}

/** gp ships one odd-sized bundle so du's per-file KiB rounding has something to round up. */
async function makeProject(root: string, name: string): Promise<string> {
  const dir = path.join(root, name)
  await fs.mkdir(path.join(dir, 'node_modules', 'gp'), { recursive: true })
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
  await fs.writeFile(path.join(dir, 'node_modules', 'gp', 'package.json'), JSON.stringify({ name: 'gp', version: '1.0.0' }))
  await fs.writeFile(path.join(dir, 'node_modules', 'gp', 'bundle.bin'), Buffer.alloc(1536 + 777))
  return path.join(dir, 'node_modules')
}

async function rmTree(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
}

describe('fast-size (v1.1) — du backend with silent walker fallback', () => {
  it('fast sizes equal a local `du -sk` exactly and never undershoot the walker', async () => {
    const root = await tmpRoot('fastsize')
    try {
      const entry = await makeProject(root, 'proj')
      const walk = await runCli(['--dir', root, '--json'], { home: root })
      const fast = await runCli(['--dir', root, '--fast-size', '--json'], { home: root })
      expect(walk.code).toBe(0)
      expect(fast.code).toBe(0)
      const walked = (JSON.parse(walk.stdout) as ScanPayload).entries[0]
      const dued = (JSON.parse(fast.stdout) as ScanPayload).entries[0]
      // ground truth: the very same du invocation the CLI is expected to make —
      // directory blocks can be huge on exotic fs (Android fuse), so equality with
      // du (not a delta vs the walker) is the honest contract here
      const duOut = execFileSync('du', ['-sk', '--', entry], { encoding: 'utf8' })
      const kb = Number.parseInt(duOut.split('\t')[0] ?? '', 10)
      expect(dued.size).toBe(kb * KB)
      expect(dued.size % KB).toBe(0) // KiB granularity is the whole deal
      expect(dued.size).toBeGreaterThanOrEqual(walked.size) // rounding up + dir blocks
      expect(dued.packageCount).toBe(walked.packageCount)
      expect(dued.packageCount).toBe(1)
    } finally {
      await rmTree(root)
    }
  })

  it('a missing du binary falls back silently to the exact walker (Windows behavior)', async () => {
    const root = await tmpRoot('fastsize-fb')
    try {
      const entry = await makeProject(root, 'proj')
      const fast = await runCli(['--dir', root, '--fast-size', '--json'], {
        home: root,
        envExtra: { PATH: '/nmh-no-such-dir' },
      })
      const plain = await runCli(['--dir', root, '--json'], { home: root })
      expect(fast.code).toBe(0)
      const dued = (JSON.parse(fast.stdout) as ScanPayload).entries[0]
      const walked = (JSON.parse(plain.stdout) as ScanPayload).entries[0]
      expect(dued.size).toBe(walked.size) // exact bytes — no du rounding happened
      expect(dued.size % KB).not.toBe(0)
      expect(dued.path).toBe(entry)
    } finally {
      await rmTree(root)
    }
  })
})
