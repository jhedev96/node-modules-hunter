import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { resolveRoots, splitTargets, expandTilde } from '../src/utils/paths.ts'
import { formatBytes, formatAge } from '../src/utils/format.ts'
import { detectFutureFlags } from '../src/utils/future-flags.ts'
import { monorepoFixture } from './helpers.ts'

describe('splitTargets', () => {
  it('splits commas, trims, handles arrays and empties', () => {
    expect(splitTargets('./a, ./b ,')).toEqual(['./a', './b'])
    expect(splitTargets(['./a', './b,c'])).toEqual(['./a', './b', 'c'])
    expect(splitTargets(undefined)).toEqual([])
  })
})

describe('expandTilde', () => {
  it('expands ~ and ~/sub', () => {
    expect(expandTilde('~')).toBe(os.homedir())
    expect(expandTilde('~/x')).toBe(path.join(os.homedir(), 'x'))
    expect(expandTilde('/plain')).toBe('/plain')
  })
})

describe('resolveRoots', () => {
  it('dedupes overlapping targets by real path', async () => {
    const fx = await monorepoFixture('resolve')
    try {
      const { roots } = await resolveRoots(
        [fx.root, fx.root + '/', path.relative(process.cwd(), fx.root)],
        process.cwd(),
      )
      expect(roots).toEqual([await fs.realpath(fx.root)])
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('expands globs for packages/*/node_modules style patterns', async () => {
    const fx = await monorepoFixture('resolve-glob')
    try {
      const { roots, unmatched } = await resolveRoots(['*/node_modules'], fx.root)
      expect(unmatched).toEqual([])
      expect(roots.sort()).toEqual([fx.paths.apiEntry, fx.paths.bunEntry, fx.paths.mobileEntry, fx.paths.webEntry].sort())
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('classifies missing paths as unmatched, symlink loops as unresolvable', async () => {
    const fx = await monorepoFixture('resolve-guard')
    try {
      const { unmatched, unresolvable, roots } = await resolveRoots(
        [path.join(fx.root, 'missing-dir'), fx.paths.loopEntry],
        process.cwd(),
      )
      expect(unmatched.length).toBe(1)
      expect(unresolvable).toEqual([fx.paths.loopEntry])
      expect(roots).toEqual([])
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })
})

describe('format utils', () => {
  it('1024-based formatting with one decimal', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(1.84 * 1024 * 1024 * 1024)).toBe('1.8 GB')
  })

  it('human age labels', () => {
    const now = Date.now()
    expect(formatAge(now, now)).toBe('now')
    expect(formatAge(now - 3 * 60_000, now)).toBe('3m ago')
    expect(formatAge(now - 5 * 3_600_000, now)).toBe('5h ago')
    expect(formatAge(now - 4 * 86_400_000, now)).toBe('4d ago')
    expect(formatAge(null)).toBe('—')
  })
})

describe('future flags detector', () => {
  it('maps camelCase keys back to dashed flags', () => {
    const hits = detectFutureFlags(['stats', 'why', 'online', 'dir', 'json', 'size'])
    expect(hits).toEqual(['--why', '--online']) // --stats & --save-baseline became real in v0.3/v0.4
  })
})
