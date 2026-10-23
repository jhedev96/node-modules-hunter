import fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { monorepoFixture, runCli, vpFixture } from './helpers.ts'

interface MapPayload {
  mode: string
  dependPkg: string | null
  totals: { projects: number; topPackages: number }
  projects: Array<{
    project: string | null
    path: string
    pm: string
    pmVp: boolean
    nested: boolean
    ownerPath: string
    size: number
    topPackagesCount: number
    topPackages: Array<{ name: string; version: string | null; symlinked: boolean }>
    declared: {
      projectDir: string
      projectName: string | null
      dependencies: string[]
      devDependencies: string[]
    } | null
  }>
}

const mapJson = async (args: string[]): Promise<{ code: number; payload: MapPayload; stderr: string }> => {
  const run = await runCli([...args, '--json'])
  return { code: run.code, payload: JSON.parse(run.stdout) as MapPayload, stderr: run.stderr }
}

describe('map e2e (spawned CLI, non-TTY)', () => {
  it('default table lists every project with PM, size, and counts (sorted by size)', async () => {
    const fx = await monorepoFixture('map-table')
    try {
      const { code, payload } = await mapJson(['map', fx.root])
      expect(code).toBe(0)
      expect(payload.mode).toBe('table')
      expect(payload.totals.projects).toBe(4)
      expect(payload.projects[0].project).toBe('web')
      const projects = payload.projects.map((project) => project.project)
      expect(projects).toEqual(expect.arrayContaining(['web', 'api', 'mobile', 'bun-app']))
      const families = payload.projects.map((project) => project.pm).sort()
      expect(families).toEqual(['bun', 'npm', 'pnpm', 'yarn'])
      for (const project of payload.projects) {
        expect(project.declared).toBeNull() // fixture manifests declare no deps
      }
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('declared deps appear as counts and lists (vp fixture)', async () => {
    const fx = await vpFixture('map-deps')
    try {
      const { payload } = await mapJson(['map', fx.root])
      expect(payload.totals.projects).toBe(1)
      const project = payload.projects[0]
      expect(project.project).toBe('app')
      expect(project.pm).toBe('pnpm')
      expect(project.pmVp).toBe(true)
      expect(project.topPackages).toHaveLength(1)
      expect(project.declared).not.toBeNull()
      expect(project.declared?.dependencies).toEqual(['vite-plus'])
      expect(project.declared?.devDependencies).toEqual(['vite'])
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('--tree lists package names with versions where present (names only, no sizes)', async () => {
    const fx = await monorepoFixture('map-tree')
    try {
      const run = await runCli(['map', fx.root, '--tree'])
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('├─')
      expect(run.stdout).toContain('react@1.0.0')
      expect(run.stdout).toContain('@scope/lib') // fixture declares no version here
      expect(run.stdout).toContain('linked (link)')
      expect(run.stdout).not.toContain('1.0.0}') // plain names, not JSON-ish blobs
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('--depend (no value) lists declared deps per project', async () => {
    const fx = await vpFixture('map-dep-list')
    try {
      const run = await runCli(['map', fx.root, '--depend'])
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('dependencies: vite-plus')
      expect(run.stdout).toContain('devDependencies: vite')
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('--depend <pkg> reverse lookup; no hits → exit 2', async () => {
    const vp = await vpFixture('map-dep-rev')
    const fx = await monorepoFixture('map-dep-miss')
    try {
      const hit = await runCli(['map', vp.root, '--depend', 'vite-plus'])
      expect(hit.code).toBe(0)
      expect(hit.stdout).toContain("'vite-plus' is declared by")
      expect(hit.stdout).toContain('[dependencies]')

      const miss = await runCli(['map', fx.root, '--depend', 'left-pad'])
      expect(miss.code).toBe(2)
      expect(miss.stderr).toContain("no project declares 'left-pad'")
    } finally {
      await fs.rm(vp.root, { recursive: true, force: true })
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('-r maps nested node_modules as their own project rows', async () => {
    const fx = await monorepoFixture('map-nested')
    try {
      const { payload } = await mapJson(['map', fx.root, '-r'])
      expect(payload.totals.projects).toBe(5)
      const nested = payload.projects.find((project) => project.nested)
      expect(nested).toBeDefined()
      expect(nested?.ownerPath).toBe(fx.paths.webEntry)
      expect(nested?.project).toBe('react') // nearest manifest above the nested entry
      expect(nested?.topPackages.map((pkg) => pkg.name)).toEqual(['foo'])
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('--map flag form and --pm filter work', async () => {
    const fx = await monorepoFixture('map-flags')
    try {
      const viaFlag = await mapJson(['--dir', fx.root, '--map'])
      expect(viaFlag.code).toBe(0)
      expect(viaFlag.payload.totals.projects).toBe(4)

      const filtered = await mapJson(['map', fx.root, '--pm', 'npm'])
      expect(filtered.payload.totals.projects).toBe(1)
      expect(filtered.payload.projects[0].project).toBe('api')
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('usage: --tree/--depend outside map (exit 1); --map + --delete (exit 1)', async () => {
    const fx = await monorepoFixture('map-usage')
    try {
      const treeAlone = await runCli(['scan', fx.root, '--tree'])
      expect(treeAlone.code).toBe(1)
      expect(treeAlone.stderr).toContain('--tree works with map or stats, --depend is map-only')

      const dependAlone = await runCli(['--depend', 'react', fx.root])
      expect(dependAlone.code).toBe(1)
      expect(dependAlone.stderr).toContain('--depend only works with the map command')

      const mapDelete = await runCli(['map', fx.root, '--delete=hard', '-y'])
      expect(mapDelete.code).toBe(1)
      expect(mapDelete.stderr).toContain('--map is read-only')
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })
})
