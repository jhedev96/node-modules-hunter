import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'
import { isNewer, parseLatestVersion, updateNote, UPDATE_CACHE_TTL_MS } from '../src/utils/update-check.ts'

describe('update-check utils (unit)', () => {
  it('isNewer: plain and prerelease compares', () => {
    expect(isNewer('0.4.0', '0.5.0')).toBe(true)
    expect(isNewer('0.4.0', '1.0.0')).toBe(true)
    expect(isNewer('1.0.0', '0.99.99')).toBe(false)
    expect(isNewer('0.4.0', '0.4.0')).toBe(false)
    expect(isNewer('0.4.0', '0.3.9')).toBe(false)
    expect(isNewer('0.4.0', '0.4.1')).toBe(true)
    expect(isNewer('0.4.10', '0.4.9')).toBe(false) // numeric, not lexicographic
    expect(isNewer('0.4.0', '0.5.0-beta.1')).toBe(true) // newer bump + suffix
    expect(isNewer('0.4.0', 'future-version-is-junk')).toBe(false)
  })

  it('parseLatestVersion only accepts registry shapes with a version string', () => {
    expect(parseLatestVersion({ version: '0.5.0' })).toBe('0.5.0')
    expect(parseLatestVersion({ version: '0.5.0-beta.2' })).toBe('0.5.0-beta.2')
    expect(parseLatestVersion({ version: '' })).toBeNull()
    expect(parseLatestVersion({})).toBeNull()
    expect(parseLatestVersion('0.5.0')).toBeNull()
    expect(parseLatestVersion(null)).toBeNull()
    expect(parseLatestVersion({ version: 'not-semver' })).toBeNull()
  })

  it('updateNote mentions both versions and the install command', () => {
    const note = updateNote('0.5.0', '0.4.0')
    expect(note).toContain('0.4.0 → 0.5.0')
    expect(note).toContain('npm i -g node-modules-hunter')
  })

  it('cache TTL is the documented 24 hours', () => {
    expect(UPDATE_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000)
  })
})

describe('update-check e2e (--update-check opt-in, 24h cache)', () => {
  const roots: string[] = []
  async function scratch(): Promise<string> {
    const root = await tmpRoot('uc-e2e')
    roots.push(root)
    return root
  }

  afterAll(async () => {
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
  })

  async function seed(root: string, latest: string, ageMs = 0): Promise<void> {
    const dir = path.join(root, '.nmh', 'cache')
    await fs.mkdir(dir, { recursive: true })
    const entry = { checkedAt: new Date(Date.now() - ageMs).toISOString(), latest }
    await fs.writeFile(path.join(dir, 'update-check.json'), JSON.stringify(entry))
  }

  /**
   * A real scanned node_modules so the underlying command exits 0 — proves the
   * notice is side-channel-only (stderr), never a code change.
   */
  async function content(root: string): Promise<void> {
    await fs.mkdir(path.join(root, 'web', 'node_modules', 'zod'), { recursive: true })
    await fs.writeFile(path.join(root, 'web', 'package.json'), '{"name":"web","version":"1.0.0"}')
    await fs.writeFile(path.join(root, 'web', 'node_modules', 'zod', 'package.json'), '{"name":"zod","version":"3.0.0"}')
  }

  it('fresh cache with a newer release → notice on stderr, JSON stdout clean, exit 0', async () => {
    const root = await scratch()
    await content(root)
    await seed(root, '9.9.9')

    const run = await runCli(['stats', '.', '--update-check'], { cwd: root, home: root })
    expect(run.code).toBe(0)
    expect(run.stderr).toContain('update tersedia:')
    expect(run.stderr).toContain('→ 9.9.9')
    expect(run.stdout).toContain('OVERVIEW') // the stats output keeps flowing

    const jsonRun = await runCli(['stats', '.', '--update-check', '--json'], { cwd: root, home: root })
    expect(jsonRun.code).toBe(0)
    expect(() => JSON.parse(jsonRun.stdout)).not.toThrow() // JSON stays machine-readable
    expect(jsonRun.stderr).toContain('9.9.9')
  }, 60_000)

  it('same-version cache and stale cache + unreachable registry stay silent, exit code intact', async () => {
    const root = await scratch()
    await content(root)
    await seed(root, '0.0.1') // ancient — the tool is always "newer" → silent whatever the bump cycle
    const sameRun = await runCli(['stats', '.', '--update-check'], { cwd: root, home: root })
    expect(sameRun.code).toBe(0)
    expect(sameRun.stderr).not.toContain('update tersedia')

    // stale cache (>24h) + refused connection → silent, exit code reflects the scan only
    await seed(root, '9.9.9', UPDATE_CACHE_TTL_MS + 60_000)
    const offlineRun = await runCli(['stats', '.', '--update-check'], {
      cwd: root,
      home: root,
      envExtra: { NMH_REGISTRY_JSON: 'http://127.0.0.1:1/latest' },
    })
    expect(offlineRun.code).toBe(0)
    expect(offlineRun.stderr).not.toContain('update tersedia')
  }, 60_000)

  it('.nmhrc updateCheck: true opt-in works without the CLI flag', async () => {
    const root = await scratch()
    await content(root)
    await seed(root, '9.9.9')
    await fs.writeFile(path.join(root, '.nmhrc'), JSON.stringify({ updateCheck: true }), 'utf8')

    const run = await runCli(['stats', '.'], { cwd: root, home: root })
    expect(run.code).toBe(0)
    expect(run.stderr).toContain('update tersedia:')
    expect(run.stderr).toContain('→ 9.9.9')

    // CLI flag absent + config absent → nothing runs (no note, no cache access crash)
    const bare = await scratch()
    await content(bare)
    const noOpt = await runCli(['stats', '.'], { cwd: bare, home: bare })
    expect(noOpt.code).toBe(0)
    expect(noOpt.stderr).not.toContain('update tersedia')
  }, 60_000)
})
