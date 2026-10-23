import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scanForNodeModules } from '../src/core/walker.ts'
import { measureEntry } from '../src/core/sizer.ts'
import { monorepoFixture, tmpRoot, type MonorepoFixture } from './helpers.ts'

const KB = 1024

describe('scanForNodeModules', () => {
  it('finds top-level node_modules only, never descends into a found one', async () => {
    const fx = await monorepoFixture('walker')
    try {
      const { entries } = await scanForNodeModules([fx.root])
      const names = entries.map((entry) => path.relative(fx.root, entry.path)).sort()
      expect(names).toEqual([
        path.join('api', 'node_modules'),
        path.join('bun-app', 'node_modules'),
        path.join('mobile', 'node_modules'),
        path.join('web', 'node_modules'),
      ])
      expect(entries.every((entry) => !entry.nested && entry.ownerPath === entry.path)).toBe(true)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('respects maxDepth (depth counts levels below the root)', async () => {
    const fx = await monorepoFixture('depth')
    try {
      const found = await scanForNodeModules([fx.root], { maxDepth: 2 })
      expect(found.entries.map((entry) => entry.path)).toContain(path.join(fx.root, 'web', 'node_modules'))
      const shallow = await scanForNodeModules([fx.root], { maxDepth: 1 })
      expect(shallow.entries).toEqual([])
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('wide bushy workspace tree never deadlocks (v0.7.1 regression: recursive limiter circular wait)', async () => {
    const root = await tmpRoot('walker-bushy')
    try {
      // Geometry that froze v0.1–v0.7.0: N packages × node_modules × bushy subdirs —
      // running chains all await children queued behind saturated slots → silent exit 0.
      const PACKAGES = 12
      const SUBDIRS = 6
      const LEAVES = 6
      const dirs: Promise<unknown>[] = []
      const manifests: Array<{ where: string; body: string }> = []
      for (let p = 0; p < PACKAGES; p += 1) {
        const nm = path.join(root, `p${p}`, 'node_modules')
        for (let s = 0; s < SUBDIRS; s += 1) {
          for (let m = 0; m < LEAVES; m += 1) {
            dirs.push(fs.mkdir(path.join(nm, `s${s}`, `m${m}`), { recursive: true }))
          }
        }
        manifests.push({ where: path.join(root, `p${p}`, 'package.json'), body: `{"name":"p${p}"}` })
      }
      // Await every mkdir before starting any write — a pushed writeFile promise
      // begins immediately, which raced fresh-mount mkdirs into ENOENT once.
      await Promise.all(dirs)
      await Promise.all(manifests.map((file) => fs.writeFile(file.where, file.body)))

      const started = Date.now()
      const { entries } = await scanForNodeModules([root], { maxDepth: 3 })
      expect(Date.now() - started).toBeLessThan(30_000)
      expect(entries.filter((entry) => entry.nested)).toHaveLength(0)
      expect(entries).toHaveLength(PACKAGES)
      expect(entries.every((entry) => entry.ownerPath === entry.path)).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('-r discovers nested node_modules and marks them nested under their owner', async () => {
    const fx = await monorepoFixture('walker-recursive')
    try {
      const { entries } = await scanForNodeModules([fx.root], { recursive: true })
      const nested = entries.filter((entry) => entry.nested)
      expect(nested).toHaveLength(1)
      expect(path.relative(fx.root, nested[0].path)).toBe(
        path.join('web', 'node_modules', 'react', 'nested', 'node_modules'),
      )
      expect(nested[0].ownerPath).toBe(path.join(fx.root, 'web', 'node_modules'))
      expect(entries.filter((entry) => !entry.nested)).toHaveLength(4)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('honors exclude globs on absolute paths, paths relative to the root, and bare names', async () => {
    const fx = await monorepoFixture('walker-exclude')
    try {
      const bare = await scanForNodeModules([fx.root], { excludes: ['api'] })
      expect(bare.entries.map((entry) => path.relative(fx.root, entry.path))).not.toContain(
        path.join('api', 'node_modules'),
      )
      expect(bare.entries.map((entry) => path.relative(fx.root, entry.path))).toContain(
        path.join('web', 'node_modules'),
      )

      const relative = await scanForNodeModules([fx.root], { excludes: ['web/node_modules'] })
      expect(relative.entries.map((entry) => path.relative(fx.root, entry.path))).not.toContain(
        path.join('web', 'node_modules'),
      )

      const globbed = await scanForNodeModules([fx.root], { excludes: ['**/mobile/**'] })
      expect(globbed.entries.map((entry) => path.relative(fx.root, entry.path))).not.toContain(
        path.join('mobile', 'node_modules'),
      )
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
