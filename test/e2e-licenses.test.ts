import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'

interface LicensePayload {
  mode?: string
  licenseBreakdown: Array<{
    type: string
    packages: number
    size: number
    production: boolean
    copyleft: boolean
  }>
}

/**
 * web (§8.2):
 * - deps:     mit-pkg (MIT), gpl-pkg (GPL-3.0-or-later → copyleft+production),
 *             oldstyle (licenses:[{type}] legacy shape), bare (no license → unknown)
 * - devDeps:  apache-pkg ({type} object shape)
 * - peerDeps: peerfix (MPL → copyleft but never production-flagged)
 */
async function fixture(label: string): Promise<string> {
  const root = await tmpRoot(label)
  const web = path.join(root, 'web')
  const writes: Array<[string, Record<string, unknown>]> = [
    ['mit-pkg', { name: 'mit-pkg', version: '1.0.0', license: 'MIT' }],
    ['gpl-pkg', { name: 'gpl-pkg', version: '1.0.0', license: 'GPL-3.0-or-later' }],
    ['oldstyle-pkg', { name: 'oldstyle-pkg', version: '1.0.0', licenses: [{ type: 'BSD-3-Clause' }] }],
    ['bare-pkg', { name: 'bare-pkg', version: '1.0.0' }],
    ['apache-pkg', { name: 'apache-pkg', version: '1.0.0', license: { type: 'Apache-2.0' } }],
    ['peerfix', { name: 'peerfix', version: '1.0.0', license: 'MPL-2.0' }],
  ]
  for (const [dir, manifest] of writes) {
    const pkgDir = path.join(web, 'node_modules', dir)
    await fs.mkdir(pkgDir, { recursive: true })
    await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify(manifest))
  }
  await fs.writeFile(
    path.join(web, 'package.json'),
    JSON.stringify({
      name: 'web',
      version: '1.0.0',
      dependencies: { 'mit-pkg': '^1', 'gpl-pkg': '^1', 'oldstyle-pkg': '^1' },
      devDependencies: { 'apache-pkg': '^1' },
      peerDependencies: { peerfix: '^1' },
    }),
  )
  return root
}

describe('license scan e2e (--licenses / --by licenses)', () => {
  it('focuses the LICENSES section with counts, sizes and the copyleft-in-prod flag', async () => {
    const root = await fixture('lic-both')
    try {
      const run = await runCli(['stats', '.', '--licenses'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('LICENSES')
      expect(run.stdout).toContain('MIT')
      expect(run.stdout).toContain('GPL-3.0-or-later')
      expect(run.stdout).toContain('copyleft di production dependencies')
      expect(run.stdout).toContain('unknown')
      // unfocused sections (TOP packages) stay hidden on a focused run
      expect(run.stdout).not.toContain('TOP PACKAGES')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('buckets every historical license shape, sizes sum, unknown lands last in JSON', async () => {
    const root = await fixture('lic-json')
    try {
      const json = JSON.parse((await runCli(['stats', '.', '--licenses', '--json'], { cwd: root, home: root })).stdout) as LicensePayload
      expect(json.mode).toBe('licenses')
      const byType = new Map(json.licenseBreakdown.map((row) => [row.type, row]))
      expect(byType.size).toBe(6) // MIT, GPL, BSD (legacy array shape), Apache (object shape), MPL, unknown
      expect(byType.get('BSD-3-Clause')?.packages).toBe(1) // licenses:[{type}] recognized
      expect(byType.get('Apache-2.0')?.packages).toBe(1) // license:{type} recognized
      expect(byType.get('unknown')?.packages).toBe(1) // manifest without license field
      expect(byType.get('GPL-3.0-or-later')).toMatchObject({ production: true, copyleft: true })
      expect(byType.get('MPL-2.0')).toMatchObject({ production: false, copyleft: true })
      expect(byType.get('MIT')).toMatchObject({ production: true, copyleft: false })
      // every bucket carries the instance size (bare manifest is the smallest → unknown sort-last check)
      for (const row of json.licenseBreakdown) expect(row.size).toBeGreaterThan(0)
      expect(json.licenseBreakdown.at(-1)?.type).toBe('unknown')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('JSON omits licenseBreakdown data when the flags are absent', async () => {
    const root = await fixture('lic-absent')
    try {
      const json = JSON.parse((await runCli(['stats', '.', '--json'], { cwd: root, home: root })).stdout) as LicensePayload
      expect(json.licenseBreakdown).toEqual([])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('guards: --licenses outside stats and invalid --by value both exit 1', async () => {
    const root = await fixture('lic-guard')
    try {
      const misuse = await runCli(['scan', '.', '--licenses'], { cwd: root, home: root })
      expect(misuse.code).toBe(1)
      expect(misuse.stderr).toContain('--licenses')
      const badBy = await runCli(['stats', '.', '--by', 'licensesx'], { cwd: root, home: root })
      expect(badBy.code).toBe(1)
      expect(badBy.stderr).toContain('invalid --by')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('symlinked (pnpm-style) instances still report their license via the store manifest', async () => {
    const root = await tmpRoot('lic-link')
    try {
      const web = path.join(root, 'web')
      const store = path.join(root, '.pnpm-virtual')
      await fs.mkdir(path.join(store, 'linked-pkg'), { recursive: true })
      await fs.writeFile(path.join(store, 'linked-pkg', 'package.json'), JSON.stringify({ name: 'linked-pkg', version: '2.0.0', license: 'MIT' }))
      await fs.mkdir(path.join(web, 'node_modules'), { recursive: true })
      await fs.symlink(path.join(store, 'linked-pkg'), path.join(web, 'node_modules', 'linked-pkg'))
      await fs.writeFile(path.join(web, 'package.json'), JSON.stringify({ name: 'web', version: '1.0.0', dependencies: { 'linked-pkg': '^2' } }))
      const json = JSON.parse((await runCli(['stats', '.', '--licenses', '--json'], { cwd: root, home: root })).stdout) as LicensePayload
      const mit = json.licenseBreakdown.find((row) => row.type === 'MIT')
      expect(mit).toBeDefined()
      expect(mit?.packages).toBe(1)
      expect(mit?.size).toBe(0) // symlinked instance carries no measured size
      expect(mit?.production).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
