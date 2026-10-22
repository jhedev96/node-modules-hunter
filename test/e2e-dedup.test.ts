import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'

interface SuggestionPayload {
  dedupSuggestions: Array<{
    name: string
    version: string | null
    save: number
    hint: string
    instances: Array<{ displayPath: string; pm: string; size: number | null; projectName: string | null; declaredRange: string | null; declaredField: string | null }>
  }>
}

/** A project dir with its own node_modules holding one real package instance. */
async function project(root: string, name: string, deps: Record<string, string>, pkgName: string, pkgVersion: string, bytes: number): Promise<void> {
  const dir = path.join(root, name)
  await fs.mkdir(path.join(dir, 'node_modules', pkgName), { recursive: true })
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', dependencies: deps, devDependencies: {} }))
  await fs.writeFile(path.join(dir, 'node_modules', pkgName, 'package.json'), JSON.stringify({ name: pkgName, version: pkgVersion }))
  await fs.writeFile(path.join(dir, 'node_modules', pkgName, 'blob.bin'), 'x'.repeat(bytes))
}

describe('dedup suggestion e2e (lockfile-aware ranges, PRD §8.2)', () => {
  it('same declared range → suggestion lists both copies + dedupe hint; save = (copies−1)×median', async () => {
    const root = await tmpRoot('dd-same')
    try {
      await project(root, 'p', { zod: '^3.23.0' }, 'zod', '3.23.0', 1000)
      await project(root, 'q', { zod: '^3.23.0' }, 'zod', '3.23.0', 3000)
      const run = await runCli(['stats', '.', '--json'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as SuggestionPayload
      expect(payload.dedupSuggestions).toHaveLength(1)
      const zod = payload.dedupSuggestions[0]!
      expect(zod.name).toBe('zod')
      expect(zod.version).toBe('3.23.0')
      expect(zod.instances).toHaveLength(2)
      expect(zod.instances.map((inst) => inst.projectName).sort()).toEqual(['p', 'q'])
      expect(zod.instances.every((inst) => inst.declaredRange === '^3.23.0' && inst.declaredField === 'dependencies')).toBe(true)
      expect(zod.save).toBe(1033) // copies−1 × lower-median size (blob 1000 B + package.json bytes); q copy is larger → median = p's size
      expect(zod.hint).toContain('identik')

      const text = await runCli(['stats', '.'], { cwd: root, home: root })
      expect(text.stdout).toContain('DEDUP SUGGESTION')
      expect(text.stdout).toContain('zod@3.23.0')
      // displayPath form depends on HOME (pinned to the fixture here) → assert the un-prefixed part
      expect(text.stdout).toContain('p/node_modules')
      expect(text.stdout).toContain('p declared ^3.23.0 (dependencies)')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('different declared ranges → align-the-package.json hint, field attribution honored', async () => {
    const root = await tmpRoot('dd-mixed')
    try {
      await project(root, 'p', { left: '^1.0.0' }, 'left', '1.0.0', 2000)
      const qDir = path.join(root, 'q')
      await fs.mkdir(path.join(qDir, 'node_modules', 'left'), { recursive: true })
      await fs.writeFile(path.join(qDir, 'package.json'), JSON.stringify({ name: 'q', version: '1.0.0', devDependencies: { left: '^1.2.0' } }))
      await fs.writeFile(path.join(qDir, 'node_modules', 'left', 'package.json'), JSON.stringify({ name: 'left', version: '1.0.0' }))
      await fs.writeFile(path.join(qDir, 'node_modules', 'left', 'blob.bin'), 'x'.repeat(1500))

      const run = await runCli(['stats', '.', '--json'], { cwd: root, home: root })
      const suggestion = (JSON.parse(run.stdout) as SuggestionPayload).dedupSuggestions[0]!
      expect(suggestion.hint).toContain('beda')
      expect(suggestion.hint).toContain('^1.0.0 vs ^1.2.0')
      expect(suggestion.instances.map((inst) => inst.projectName).sort()).toEqual(['p', 'q'])
      // the dev-only copy keeps its devDependencies attribution
      expect(suggestion.instances.find((inst) => inst.projectName === 'q')?.declaredField).toBe('devDependencies')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('transitive copies (no manifest entry) → honest no-knob hint; no dups → empty list', async () => {
    const root = await tmpRoot('dd-trans')
    try {
      await project(root, 'p', {}, 'accidental', '0.1.0', 800)
      await project(root, 'q', {}, 'accidental', '0.1.0', 500)
      const run = await runCli(['stats', '.', '--json'], { cwd: root, home: root })
      const suggestion = (JSON.parse(run.stdout) as SuggestionPayload).dedupSuggestions[0]!
      expect(suggestion.hint).toContain('parent')
      expect(suggestion.instances.every((inst) => inst.declaredRange === null && inst.projectName === null)).toBe(true)

      // singleton package → no suggestion at all
      const solo = await tmpRoot('dd-solo')
      try {
        await project(solo, 'p', {}, 'lonely', '1.0.0', 700)
        const clean = await runCli(['stats', '.', '--json'], { cwd: solo, home: solo })
        expect((JSON.parse(clean.stdout) as SuggestionPayload).dedupSuggestions).toEqual([])
      } finally {
        await fs.rm(solo, { recursive: true, force: true })
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('symlinked copies are sizeless → never counted as a dedupable second copy', async () => {
    const root = await tmpRoot('dd-symlink')
    try {
      await project(root, 'p', { real: '1.0.0' }, 'real', '1.0.0', 900)
      const link = path.join(root, 'linked-parent', 'node_modules', 'real')
      await fs.mkdir(path.dirname(link), { recursive: true })
      await fs.writeFile(path.join(root, 'linked-parent', 'package.json'), '{"name":"linked-parent","version":"1.0.0"}')
      await fs.symlink(path.join(root, 'p', 'node_modules', 'real'), link, 'dir')

      const run = await runCli(['stats', '.', '--json'], { cwd: root, home: root })
      expect((JSON.parse(run.stdout) as SuggestionPayload).dedupSuggestions).toEqual([])

      // a second REAL copy is needed to make the group dedupable — the symlink must not be one
      await project(root, 'r', { real: '1.0.0' }, 'real', '1.0.0', 900)
      const withReal = await runCli(['stats', '.', '--json'], { cwd: root, home: root })
      const suggestion = (JSON.parse(withReal.stdout) as SuggestionPayload).dedupSuggestions[0]!
      expect(suggestion.instances).toHaveLength(2)
      expect(suggestion.instances.every((inst) => inst.displayPath !== './linked-parent/node_modules')).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('suggestion list is capped at the top 5 groups by save', async () => {
    const root = await tmpRoot('dd-cap')
    try {
      const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
      for (const name of names) {
        await project(root, `host-${name}`, {}, name, '1.0.0', 1000)
        await project(root, `peer-${name}`, {}, name, '1.0.0', 1000) // same sizes → save equal
      }
      const run = await runCli(['stats', '.', '--json'], { cwd: root, home: root })
      const suggestions = (JSON.parse(run.stdout) as SuggestionPayload).dedupSuggestions
      expect(suggestions).toHaveLength(5)
      for (const suggestion of suggestions) expect(suggestion.instances).toHaveLength(2)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
