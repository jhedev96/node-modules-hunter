import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scanForNodeModules } from '../src/core/walker.ts'
import { measureEntry } from '../src/core/sizer.ts'
import { monorepoFixture, type MonorepoFixture } from './helpers.ts'

const KB = 1024

describe('scanForNodeModules', () => {
  it('finds top-level node_modules only, never descends into a found one', async () => {
    const fx = await monorepoFixture('walker')
    try {
      const { entries } = await scanForNodeModules([fx.root])
      const names = entries.map((entry) => path.relative(fx.root, entry)).sort()
      expect(names).toEqual([
        path.join('api', 'node_modules'),
        path.join('bun-app', 'node_modules'),
        path.join('mobile', 'node_modules'),
        path.join('web', 'node_modules'),
      ])
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('respects maxDepth (depth counts levels below the root)', async () => {
    const fx = await monorepoFixture('depth')
    try {
      const found = await scanForNodeModules([fx.root], { maxDepth: 2 })
      expect(found.entries).toContain(path.join(fx.root, 'web', 'node_modules'))
      const shallow = await scanForNodeModules([fx.root], { maxDepth: 1 })
      expect(shallow.entries).toEqual([])
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })
})

describe('measureEntry', () => {
  let fx: MonorepoFixture
  beforeAll(async () => {
    fx = await monorepoFixture('sizer')
  })
  afterAll(async () => {
    await fs.rm(fx.root, { recursive: true, force: true })
  })

  it('sums real files only: symlink targets excluded, nested included in owner entry', async () => {
    const issues: string[] = []
    const measure = await measureEntry(fx.paths.webEntry, issues)
    const expected = 4 * KB * 3 + 2 * KB // react + scope + pnpm store + cache dotdir
    // nested node_modules (its package.json ~1KB max) must NOT make the entry bigger;
    // dangling/outside symlinks are never followed
    expect(measure.size).toBeGreaterThanOrEqual(expected)
    expect(measure.size).toBeLessThan(expected + KB)
    expect(issues).toEqual([])

    const api = await measureEntry(fx.paths.apiEntry, issues)
    const pkgBytes = (await fs.readFile(path.join(fx.paths.apiEntry, 'express', 'package.json'))).byteLength
    expect(api.size).toBe(4 * KB + pkgBytes) // includes express/package.json — it IS content
  })

  it('package counts: scopes expand, dotdirs skipped, symlinked dir counts once', async () => {
    const count = (await measureEntry(fx.paths.webEntry)).packageCount
    // react + @scope/lib = 2 real, linked = 1 symlink dir, dangling excluded, .pnpm/.cache excluded
    expect(count).toBe(3)
  })
})

describe('walker+sizer hard rules', () => {
  it('explicit alias target resolves once; nested links never inflate sizes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nmh-link-'))
    try {
      const real = path.join(root, 'data')
      await fs.mkdir(real, { recursive: true })
      await fs.writeFile(path.join(real, 'blob.bin'), Buffer.alloc(8 * KB))
      const nm = path.join(root, 'node_modules')
      await fs.symlink(real, nm)

      // In nmh flows entries always come from the walker (real dirs): nested links are skipped.
      // A DIRECT user target through a symlink is resolved once via readdir — content counts once.
      const measure = await measureEntry(nm)
      expect(measure.size).toBe(8 * KB)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
