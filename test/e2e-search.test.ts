import fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { monorepoFixture, runCli } from './helpers.ts'

interface SearchPayload {
  pattern: string
  totals: { matchedEntries: number; matches: number; matchedSize: number }
  results: Array<{
    path: string
    pm: string
    pmVp: boolean
    nested: boolean
    entrySize: number
    pathMatch: boolean
    matches: Array<{ name: string; version: string | null; size: number; symlinked: boolean }>
  }>
}

const searchJson = async (args: string[]): Promise<{ code: number; payload: SearchPayload; stderr: string }> => {
  const run = await runCli([...args, '--json'])
  return { code: run.code, payload: JSON.parse(run.stdout) as SearchPayload, stderr: run.stderr }
}

describe('search e2e (spawned CLI, non-TTY)', () => {
  it('finds an installed package by substring, with version and lazy size', async () => {
    const fx = await monorepoFixture('search-pkg')
    try {
      const { code, payload } = await searchJson(['search', 'react', fx.root])
      expect(code).toBe(0)
      expect(payload.pattern).toBe('react')
      expect(payload.totals.matchedEntries).toBe(1)
      expect(payload.totals.matches).toBe(1)
      const result = payload.results[0]
      expect(result.path).toBe(fx.paths.webEntry)
      expect(result.pathMatch).toBe(false)
      expect(result.matches[0]).toMatchObject({ name: 'react', version: '1.0.0', symlinked: false })
      expect(result.matches[0].size).toBeGreaterThanOrEqual(4096)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('plain patterns are case-insensitive; missing version stays null', async () => {
    const fx = await monorepoFixture('search-case')
    try {
      const { payload } = await searchJson(['search', 'EXP', fx.root])
      expect(payload.totals.matches).toBe(1)
      expect(payload.results[0].path).toBe(fx.paths.apiEntry)
      expect(payload.results[0].matches[0]).toMatchObject({ name: 'express', version: null })
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('/regex/ form anchors as written', async () => {
    const fx = await monorepoFixture('search-regex')
    try {
      const anchored = await searchJson(['search', '/^vi/', fx.root])
      expect(anchored.payload.totals.matches).toBe(1)
      expect(anchored.payload.results[0].matches[0].name).toBe('vite')

      // Note: '/od/' would collide with every path ("n-o-d-e_modules") — anchor it.
      const loose = await searchJson(['search', '/^z.d$/', fx.root])
      expect(loose.payload.totals.matches).toBe(1)
      expect(loose.payload.results[0].matches[0].name).toBe('zod')
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('glob form matches whole package names', async () => {
    const fx = await monorepoFixture('search-glob')
    try {
      const { payload } = await searchJson(['search', 'v*', fx.root])
      const names = payload.results.flatMap((result) => result.matches.map((pkg) => pkg.name)).sort()
      expect(names).toEqual(['vite', 'vue'])
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('matches scoped packages and pnpm symlinks', async () => {
    const fx = await monorepoFixture('search-scope')
    try {
      const scoped = await searchJson(['search', 'scope/lib', fx.root])
      expect(scoped.payload.totals.matches).toBe(1)
      expect(scoped.payload.results[0].matches[0].name).toBe('@scope/lib')

      const linked = await searchJson(['search', 'linked', fx.root])
      expect(linked.payload.results[0].matches[0]).toMatchObject({ name: 'linked', symlinked: true })
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('-r searches nested node_modules too; without -r nested stays invisible', async () => {
    const fx = await monorepoFixture('search-nested')
    try {
      const flat = await searchJson(['search', 'foo', fx.root])
      expect(flat.code).toBe(2)
      expect(flat.payload.results).toHaveLength(0)

      const deep = await searchJson(['search', 'foo', fx.root, '-r'])
      expect(deep.code).toBe(0)
      expect(deep.payload.results).toHaveLength(1)
      expect(deep.payload.results[0].nested).toBe(true)
      expect(deep.payload.results[0].matches[0].name).toBe('foo')
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('a path match shows the entry even without package hits', async () => {
    const fx = await monorepoFixture('search-path')
    try {
      const { payload } = await searchJson(['search', 'mobile', fx.root])
      expect(payload.totals.matchedEntries).toBe(1)
      expect(payload.results[0].path).toBe(fx.paths.mobileEntry)
      expect(payload.results[0].pathMatch).toBe(true)
      expect(payload.results[0].matches).toHaveLength(0)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('honors --pm filter and reports no-match as exit 2', async () => {
    const fx = await monorepoFixture('search-pm')
    try {
      const filtered = await searchJson(['search', 'express', fx.root, '--pm', 'pnpm'])
      expect(filtered.code).toBe(2)

      const kept = await searchJson(['search', 'express', fx.root, '--pm', 'npm'])
      expect(kept.code).toBe(0)
      expect(kept.payload.totals.matches).toBe(1)

      const none = await searchJson(['search', 'never-exists', fx.root])
      expect(none.code).toBe(2)
      expect(none.payload.results).toHaveLength(0)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('--search flag form behaves like the subcommand', async () => {
    const fx = await monorepoFixture('search-flag')
    try {
      const viaFlag = await searchJson(['--dir', fx.root, '--search', 'react'])
      expect(viaFlag.code).toBe(0)
      expect(viaFlag.payload.totals.matches).toBe(1)
      expect(viaFlag.payload.results[0].path).toBe(fx.paths.webEntry)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('text output lists matched packages with versions', async () => {
    const fx = await monorepoFixture('search-text')
    try {
      const run = await runCli(['search', 'react', fx.root])
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('🔍')
      expect(run.stdout).toContain('react@1.0.0')
      expect(run.stdout).toContain('web/node_modules')
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('usage errors: no pattern (exit 1) and --search combined with delete (exit 1)', async () => {
    const fx = await monorepoFixture('search-usage')
    try {
      const noPattern = await runCli(['search'])
      expect(noPattern.code).toBe(1)
      expect(noPattern.stderr).toContain('search needs a pattern')

      const withDelete = await runCli(['--dir', fx.root, '--search', 'react', '--delete=hard', '-y'])
      expect(withDelete.code).toBe(1)
      expect(withDelete.stderr).toContain('read-only')
      expect(await fs.lstat(fx.paths.webEntry).then(() => true, () => false)).toBe(true)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })
})
