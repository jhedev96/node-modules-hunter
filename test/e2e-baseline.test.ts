import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'

interface StatsPayload {
  overview: { totalSize: number; instances: number }
  baseline: {
    saved?: { name: string; createdAt: string; file: string }
    compare: {
      baselineName: string
      totalDelta: number
      packagesDelta: number
      deltas: Array<{ rel: string; kind: string; delta: number }>
      packageMovers: Array<{ name: string; delta: number }>
    } | null
  } | null
}

interface HistoryPayload {
  baselines: Array<{ name: string; createdAt: string; totals: { size: number } }>
}

/** Tiny two-project fixture whose total size can be shifted by appending bytes. */
async function fixture(label: string): Promise<string> {
  const root = await tmpRoot(label)
  for (const dir of ['web/node_modules/lodash', 'api/node_modules/lodash']) {
    await fs.mkdir(path.join(root, dir), { recursive: true })
    await fs.writeFile(path.join(root, dir, 'package.json'), '{"name":"lodash","version":"4.17.21"}')
    await fs.writeFile(path.join(root, dir, 'blob.bin'), 'x'.repeat(1000))
  }
  await fs.writeFile(path.join(root, 'web', 'package.json'), '{"name":"web","version":"1.0.0"}')
  await fs.writeFile(path.join(root, 'api', 'package.json'), '{"name":"api","version":"1.0.0"}')
  return root
}

const opts = (root: string) => ({ cwd: root, home: root })

describe('baseline e2e (--save-baseline / --compare / --history)', () => {
  it('save writes ~/.nmh/baselines/<name>.json (schema 1) + stderr note; JSON stamps the save', async () => {
    const root = await fixture('bl-save')
    try {
      const run = await runCli(['stats', '.', '--save-baseline', 't0', '--json'], opts(root))
      expect(run.code).toBe(0)
      expect(run.stderr).toContain('baseline saved')
      const payload = JSON.parse(run.stdout) as StatsPayload
      expect(payload.baseline?.saved?.name).toBe('t0')

      const file = JSON.parse(
        await fs.readFile(path.join(root, '.nmh', 'baselines', 't0.json'), 'utf8'),
      ) as { schema: number; totals: { size: number }; entries: unknown[] }
      expect(file.schema).toBe(1)
      expect(file.entries).toHaveLength(2)
      expect(file.totals.size).toBe(payload.overview.totalSize)
      expect(file.totals.size).toBeGreaterThan(0)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('growing an entry → compare shows the delta, the mover and the changed path table', async () => {
    const root = await fixture('bl-grow')
    try {
      await runCli(['stats', '.', '--save-baseline', 'before', '--json'], opts(root))
      await fs.appendFile(path.join(root, 'api', 'node_modules', 'lodash', 'blob.bin'), 'y'.repeat(5000))

      const run = await runCli(['stats', '.', '--compare', 'before'], opts(root))
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('BASELINE COMPARE')
      expect(run.stdout).toContain("'before'")
      expect(run.stdout).toMatch(/Total size       : \+/)
      expect(run.stdout).toContain('api/node_modules')
      expect(run.stdout).toContain('1. lodash') // package mover

      const jsonRun = await runCli(['stats', '.', '--compare', 'before', '--json'], opts(root))
      const payload = JSON.parse(jsonRun.stdout) as StatsPayload
      expect(payload.baseline?.compare?.baselineName).toBe('before')
      expect(payload.baseline?.compare?.totalDelta).toBeGreaterThan(0)
      expect(payload.baseline?.compare?.deltas.some((delta) => delta.rel === 'api/node_modules' && delta.kind === 'grew')).toBe(true)
      expect(payload.baseline?.compare?.packageMovers.find((mover) => mover.name === 'lodash')?.delta).toBeGreaterThan(0)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('removing a scanned node_modules between runs → "gone" row with negative delta', async () => {
    const root = await fixture('bl-gone')
    try {
      await runCli(['stats', '.', '--save-baseline', 'b', '--json'], opts(root))
      await fs.rm(path.join(root, 'web'), { recursive: true, force: true })

      const run = await runCli(['stats', '.', '--compare', 'b', '--json'], opts(root))
      const payload = JSON.parse(run.stdout) as StatsPayload
      expect(run.code).toBe(0)
      expect(payload.baseline?.compare?.deltas.some((delta) => delta.rel === 'web/node_modules' && delta.kind === 'gone' && delta.delta < 0)).toBe(true)
      expect(payload.baseline?.compare?.totalDelta).toBeLessThanOrEqual(0)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('usage errors: missing baseline (exit 1 + saved hint), invalid names, bare flags, wrong command', async () => {
    const root = await fixture('bl-bad')
    try {
      const missing = await runCli(['stats', '.', '--compare', 'ghost'], opts(root))
      expect(missing.code).toBe(1)
      expect(missing.stderr).toContain("no baseline named 'ghost'")

      await runCli(['stats', '.', '--save-baseline', 'kept'], opts(root))
      const missingWithHint = await runCli(['stats', '.', '--compare', 'ghost'], opts(root))
      expect(missingWithHint.stderr).toContain('saved: kept')

      const traversal = await runCli(['stats', '.', '--save-baseline', '../evil'], opts(root))
      expect(traversal.code).toBe(1)
      expect(traversal.stderr).toContain('invalid baseline name')
      expect((await listBaselineFiles(root))).not.toContain(path.join('..', 'evil.json'))

      const bareSave = await runCli(['stats', '.', '--save-baseline'], opts(root))
      expect(bareSave.code).toBe(1)
      expect(bareSave.stderr).toContain('--save-baseline needs a name')

      const bareCompare = await runCli(['stats', '.', '--compare'], opts(root))
      expect(bareCompare.code).toBe(1)

      const wrongCommand = await runCli(['scan', '.', '--save-baseline', 'x'], opts(root))
      expect(wrongCommand.code).toBe(1)
      expect(wrongCommand.stderr).toContain('only work with the stats command')

      const bareHistory = await runCli(['--history'], opts(root))
      expect(bareHistory.code).toBe(1)

      // the earlier save must still exist after all the failed runs
      expect(await loadBaselineTotals(root, 'kept')).toBeGreaterThan(0)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('history lists saved baselines newest-first (exit 2 when none); overwriting keeps one file per name', async () => {
    const root = await fixture('bl-history')
    try {
      const none = await runCli(['stats', '--history'], opts(root))
      expect(none.code).toBe(2)

      await runCli(['stats', '.', '--save-baseline', 'aaa'], opts(root))
      await new Promise((resolve) => setTimeout(resolve, 20)) // distinct createdAt timestamps
      await runCli(['stats', '.', '--save-baseline', 'bbb'], opts(root))

      const listed = await runCli(['stats', '--history', '--json'], opts(root))
      expect(listed.code).toBe(0)
      const payload = JSON.parse(listed.stdout) as HistoryPayload
      expect(payload.baselines.map((item) => item.name)).toEqual(['bbb', 'aaa']) // newest first

      // same name twice → still exactly one baseline file for it (overwritten)
      await runCli(['stats', '.', '--save-baseline', 'bbb'], opts(root))
      const after = JSON.parse((await runCli(['stats', '--history', '--json'], opts(root))).stdout) as HistoryPayload
      expect(after.baselines.filter((item) => item.name === 'bbb')).toHaveLength(1)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('empty scan still saves an honest empty snapshot and skips the comparison', async () => {
    const root = await tmpRoot('bl-empty')
    try {
      const save = await runCli(['stats', '.', '--save-baseline', 'clean-slate'], opts(root))
      expect(save.code).toBe(2) // nothing found
      expect(save.stderr).toContain('baseline saved')
      expect(save.stderr).toContain('empty snapshot')

      // now grow real content and compare against the empty baseline
      const grown = await fixture('bl-empty-grown')
      await fs.rename(path.join(grown, 'web'), path.join(root, 'web'))
      await fs.rename(path.join(grown, 'api'), path.join(root, 'api'))
      await fs.rm(grown, { recursive: true, force: true })

      const run = await runCli(['stats', '.', '--compare', 'clean-slate'], opts(root))
      expect(run.code).toBe(0)
      expect(run.stdout).toMatch(/Total size       : \+/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

async function listBaselineFiles(home: string): Promise<string[]> {
  try {
    return await fs.readdir(path.join(home, '.nmh', 'baselines'))
  } catch {
    return [] // no baselines dir yet
  }
}

async function loadBaselineTotals(home: string, name: string): Promise<number> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(home, '.nmh', 'baselines', `${name}.json`), 'utf8')) as { totals: { size: number } }
    return parsed.totals.size
  } catch {
    return 0
  }
}
