import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'
import { buildScore, buildCo2, STORAGE_GCO2_PER_GB_YEAR, TRANSFER_GCO2_PER_GB } from '../src/commands/stats.ts'
import { formatCo2 } from '../src/utils/format.ts'
import type { StatsOverview } from '../src/core/result.ts'

interface ScorePayload {
  mode?: string
  score: { score: number; grade: string; components: { wastePercent: number; wastePoints: number; dupFactor: number; dupPoints: number; deadPercent: number; deadPoints: number; deadPackages: number; sizePoints: number } } | null
  co2: { totalSize: number; storageGrams: number; transferGrams: number } | null
}

function overview(partial: Partial<StatsOverview>): StatsOverview {
  return {
    totalSize: 0,
    entryCount: 1,
    instances: 1,
    unique: 1,
    dupFactor: 1,
    waste: 0,
    wastePercent: 0,
    declared: null,
    ...partial,
  }
}

describe('bloat score math (unit, PRD §8.2 experimental)', () => {
  it('perfectly flat tiny install scores 0 / grade A', () => {
    const result = buildScore(overview({ wastePercent: 0, dupFactor: 1, totalSize: 1024, instances: 8, unique: 8 }), 0)
    expect(result).toMatchObject({ score: 0, grade: 'A' })
    expect(result.components).toMatchObject({ wastePoints: 0, dupPoints: 0, deadPoints: 0, sizePoints: 0 })
  })

  it('waste dominates: 90% waste caps at 40 pt, dup factor 2× gives 20 pt', () => {
    const result = buildScore(overview({ wastePercent: 90, dupFactor: 2, instances: 10, unique: 5 }), 0)
    expect(result.components.wastePoints).toBe(40)
    expect(result.components.dupPoints).toBe(20)
    // still under the dead threshold: 40+20 = 60 → grade C
  })

  it('dead declarations: 1 dead of 4 instances → 25% → 20 pt (capped at threshold 50%)', () => {
    const result = buildScore(overview({ instances: 4, unique: 4, dupFactor: 1 }), 1)
    expect(result.components.deadPackages).toBe(1)
    expect(result.components.deadPercent).toBe(25)
    expect(result.components.deadPoints).toBe(20)
  })

  it('size reference: 512 MB reaches the full 20 pt', () => {
    const result = buildScore(overview({ totalSize: 512 * 1024 * 1024 }), 0)
    expect(result.components.sizePoints).toBe(20)
    expect(result.score).toBe(20)
    expect(result.grade).toBe('B')
  })

  it('total score is capped at 100 and grades F', () => {
    const result = buildScore(overview({ wastePercent: 80, dupFactor: 3, instances: 9, unique: 3, totalSize: 1024 ** 3 }), 5)
    expect(result.score).toBe(100)
    expect(result.grade).toBe('F')
  })
})

describe('co2 estimate math (unit)', () => {
  it('exactly 1 GiB uses the documented constants', () => {
    const result = buildCo2(overview({ totalSize: 1024 ** 3 }))
    expect(result.storageGrams).toBe(STORAGE_GCO2_PER_GB_YEAR)
    expect(result.transferGrams).toBe(TRANSFER_GCO2_PER_GB)
  })

  it('zero size stays zero', () => {
    expect(buildCo2(overview({ totalSize: 0 }))).toMatchObject({ storageGrams: 0, transferGrams: 0 })
  })

  it('formatCo2 scales grams → kg and keeps small values honest', () => {
    expect(formatCo2(0.02)).toBe('0.020 g CO2e')
    expect(formatCo2(0.5)).toBe('0.50 g CO2e')
    expect(formatCo2(45.67)).toBe('45.7 g CO2e')
    expect(formatCo2(2345)).toBe('2.35 kg CO2e')
  })
})

/**
 * dup fixture: web + api both install lodash@4.17.21, identical blob → waste = full
 * duplicate, and manifests declared without any src/ imports → every instance is dead.
 */
async function dupFixture(label: string): Promise<string> {
  const root = await tmpRoot(label)
  for (const name of ['web', 'api']) {
    const pkgDir = path.join(root, name, 'node_modules', 'lodash')
    await fs.mkdir(pkgDir, { recursive: true })
    await fs.writeFile(path.join(pkgDir, 'blob.bin'), Buffer.alloc(16 * 1024 * 1024))
    await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'lodash', version: '4.17.21', license: 'MIT' }))
    await fs.writeFile(path.join(root, name, 'package.json'), JSON.stringify({ name, version: '1.0.0', dependencies: { lodash: '^4.17.21' } }))
  }
  return root
}

describe('score & co2 e2e (--score / --co2)', () => {
  it('focuses the BLOAT SCORE section with a bar, dead audit auto-run and exact JSON', async () => {
    const root = await dupFixture('sco-focus')
    try {
      const run = await runCli(['stats', '.', '--score'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('BLOAT SCORE')
      expect(run.stdout).toContain('experimental')
      expect(run.stdout).toContain('81 / 100')
      expect(run.stdout).toContain('grade F')
      // the audit runs implicitly for --score, even without --dead
      expect(run.stdout).not.toContain('tidak diaudit')
      // focused: TOP PACKAGES stays hidden
      expect(run.stdout).not.toContain('TOP PACKAGES')

      const json = JSON.parse((await runCli(['stats', '.', '--score', '--json'], { cwd: root, home: root })).stdout) as ScorePayload
      expect(json.mode).toBe('score')
      expect(json.score?.components).toMatchObject({
        wastePercent: 50,
        wastePoints: 40,
        dupFactor: 2,
        dupPoints: 20,
        deadPercent: 50,
        deadPoints: 20,
        sizePoints: 1,
      })
      expect(json.score?.score).toBe(81)
      expect(json.score?.grade).toBe('F')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('--co2 alone focuses a CO2 section; the two lines keep the 10:2 constant ratio', async () => {
    const root = await dupFixture('sco-co2')
    try {
      const run = await runCli(['stats', '.', '--co2'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('CO2 ESTIMATE')
      expect(run.stdout).toContain('simpan setahun')
      expect(run.stdout).toContain('men-download ulang')
      const grams = [...run.stdout.matchAll(/([\d.]+) (g|kg) CO2e/g)].map((match) => Number(match[1]) * (match[2] === 'kg' ? 1000 : 1))
      expect(grams.length).toBe(2)
      const [storage, transfer] = grams
      // transfer constant 10×, storage 2× per GB → same size ⇒ ratio 5, subject to 2-decimal rounding
      expect(transfer).toBeGreaterThan(0)
      expect(transfer / storage).toBeGreaterThan(4.4)
      expect(transfer / storage).toBeLessThan(5.6)

      const json = JSON.parse((await runCli(['stats', '.', '--co2', '--json'], { cwd: root, home: root })).stdout) as ScorePayload
      expect(json.mode).toBe('co2')
      expect(json.co2?.totalSize).toBeGreaterThan(30_000)
      expect(json.score).toBeNull()

      // both flags together still work (same section, both blocks)
      const both = await runCli(['stats', '.', '--score', '--co2'], { cwd: root, home: root })
      expect(both.stdout).toContain('BLOAT SCORE')
      expect(both.stdout).toContain('CO2e')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('flags absent → score and co2 stay null in JSON', async () => {
    const root = await dupFixture('sco-absent')
    try {
      const json = JSON.parse((await runCli(['stats', '.', '--json'], { cwd: root, home: root })).stdout) as ScorePayload
      expect(json.score).toBeNull()
      expect(json.co2).toBeNull()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('guards: --score/--co2 outside stats exit 1', async () => {
    const root = await dupFixture('sco-guard')
    try {
      const misuse = await runCli(['scan', '.', '--score'], { cwd: root, home: root })
      expect(misuse.code).toBe(1)
      expect(misuse.stderr).toContain('--score')
      const viaWhy = await runCli(['map', '.', '--co2'], { cwd: root, home: root })
      expect(viaWhy.code).toBe(1)
      expect(viaWhy.stderr).toContain('--co2')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
