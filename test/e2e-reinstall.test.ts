import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildReinstall, REINSTALL_MS_PER_PACKAGE, REINSTALL_NATIVE_MS, REINSTALL_BYTES_PER_SECOND, buildReinstallNativeCount } from '../src/commands/stats.ts'
import { formatDuration } from '../src/utils/format.ts'
import { runCli, tmpRoot } from './helpers.ts'

interface ReinstallPayload {
  mode?: string
  reinstall: {
    seconds: number
    packages: number
    nativePackages: number
    formula: string
    msPerPackage: number
    bytesPerSecond: number
    nativeMs: number
  } | null
}

describe('reinstall estimate (unit math + naive native proxy)', () => {
  it('seconds = pkg×60ms + bytes/50MBs + native×3s, deterministic', () => {
    const overview = { totalSize: 100 * 1024 * 1024, entryCount: 1, instances: 300, unique: 300, dupFactor: 1, waste: 0, wastePercent: 0, declared: 3 } as const
    const estimate = buildReinstall(overview, ['typescript', 'sharp', '@img/sharp-linux-x64', 'grpc-tools'])
    // 300×60ms + 100MB/50MBs + 3 native families (sharp, sharp-linux-x64 counts 1 distinct name? names distinct: sharp + @img/sharp-linux-x64 = 2 native? 'grpc-tools' too → 3)
    expect(estimate.packages).toBe(300)
    expect(estimate.nativePackages).toBe(3)
    expect(estimate.msPerPackage).toBe(REINSTALL_MS_PER_PACKAGE)
    expect(estimate.bytesPerSecond).toBe(REINSTALL_BYTES_PER_SECOND)
    expect(estimate.nativeMs).toBe(REINSTALL_NATIVE_MS)
    expect(estimate.seconds).toBeCloseTo((300 * 60 + (100 * 1024 * 1024 * 1000) / (50 * 1024 * 1024) + 3 * 3000) / 1000, 1)
    expect(estimate.formula).toContain('300 pkg × 60 ms')
    expect(estimate.formula).toContain('100.0 MB / 50 MB/s')
    expect(estimate.formula).toContain('3 native × 3 s')
  })

  it('native proxy counts distinct names only and is case-insensitive', () => {
    expect(buildReinstallNativeCount([])).toBe(0)
    expect(buildReinstallNativeCount(['typescript', 'chalk', 'tinyglobby'])).toBe(0)
    expect(buildReinstallNativeCount(['@img/sharp-linux-x64', 'sharp-linux-musl', 'GRPC-Tools-Linux'])).toBe(3)
  })

  it('formatDuration keeps sub-minute decimals and rolls up to m/h', () => {
    expect(formatDuration(4.7)).toBe('4.7s')
    expect(formatDuration(59)).toBe('59s')
    expect(formatDuration(60)).toBe('1m 0s')
    expect(formatDuration(192)).toBe('3m 12s')
    expect(formatDuration(3600)).toBe('1h 0m')
    expect(formatDuration(7260)).toBe('2h 1m')
  })
})

describe('nmh stats --reinstall (e2e)', () => {
  async function fixture(label: string): Promise<string> {
    const root = await tmpRoot(label)
    const project = path.join(root, 'app')
    await fs.mkdir(path.join(project, 'node_modules', 'better-sqlite3'), { recursive: true })
    await fs.writeFile(path.join(project, 'node_modules', 'better-sqlite3', 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '11.0.0' }))
    await fs.writeFile(path.join(project, 'node_modules', 'better-sqlite3', 'blob.bin'), 'x'.repeat(2048))
    await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'app', dependencies: { 'better-sqlite3': '^11' } }))
    return root
  }

  it('focuses the REINSTALL section and surfaces the naive formula', async () => {
    const root = await fixture('rs-text')
    try {
      const run = await runCli(['stats', 'app', '--reinstall'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('REINSTALL')
      expect(run.stdout).toContain('naif')
      expect(run.stdout).toContain('pasang ulang semuanya sekali')
      expect(run.stdout).toContain('1 native × 3 s')
      expect(run.stdout).toContain('pkg × 60 ms')
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('json payload carries the fields with all assumption constants', async () => {
    const root = await fixture('rs-json')
    try {
      const run = await runCli(['stats', 'app', '--reinstall', '--json'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as ReinstallPayload
      expect(payload.mode).toBe('reinstall')
      expect(payload.reinstall).not.toBeNull()
      expect(payload.reinstall!.packages).toBe(1)
      expect(payload.reinstall!.nativePackages).toBe(1)
      expect(payload.reinstall!.msPerPackage).toBe(60)
      expect(payload.reinstall!.bytesPerSecond).toBe(50 * 1024 * 1024)
      expect(payload.reinstall!.nativeMs).toBe(3000)
      // 1×60ms + 2KB/50MBps + 3000ms ≈ 3.1s
      expect(payload.reinstall!.seconds).toBeCloseTo(3.1, 1)
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('flag absent → reinstall null; guards reject it outside stats and in global mode', async () => {
    const root = await fixture('rs-guards')
    try {
      const absent = await runCli(['stats', 'app', '--json'], { cwd: root, home: root })
      expect((JSON.parse(absent.stdout) as ReinstallPayload).reinstall).toBeNull()

      const mapRun = await runCli(['map', '.', '--reinstall'], { cwd: root, home: root })
      expect(mapRun.code).toBe(1)
      expect(mapRun.stderr).toContain('--reinstall only work with the stats command')
      const globalRun = await runCli(['stats', '--global', '--reinstall'], { cwd: root, home: root })
      expect(globalRun.code).toBe(1)
      expect(globalRun.stderr).toContain('shape per-project stats')
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})
