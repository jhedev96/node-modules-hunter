import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'

interface AuditPayload {
  depsAudit: {
    scannedFiles: number
    phantom: Array<{ name: string; sites: string[]; declaringProjects: string[] }>
    dead: Array<{ name: string; sites: string[]; declaringProjects: string[] }>
  } | null
}

/**
 * web: declares zod (imported → clean) + unused (installed, never imported → dead);
 * src imports chalk (phantom), node:fs + ./util (skipped), dynamic + export-from extras.
 */
async function fixture(label: string): Promise<string> {
  const root = await tmpRoot(label)
  const web = path.join(root, 'web')
  await fs.mkdir(path.join(web, 'src'), { recursive: true })
  for (const name of ['zod', 'unused']) {
    await fs.mkdir(path.join(web, 'node_modules', name), { recursive: true })
    await fs.writeFile(path.join(web, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  }
  await fs.writeFile(
    path.join(web, 'package.json'),
    JSON.stringify({ name: 'web', version: '1.0.0', dependencies: { zod: '^3.0.0', unused: '^1.0.0' } }),
  )
  await fs.writeFile(
    path.join(web, 'src', 'index.ts'),
    'import { z } from "zod";\n' +
      'import chalk from "chalk";\n' +
      'import fs from "node:fs";\n' +
      'import helper from "./util";\n' +
      'const dyn = await import("hoist");\n' +
      'export * from "side-effect";\n',
  )
  return root
}

describe('deps audit e2e (--phantom / --dead, best-effort regex)', () => {
  it('combined run: phantom imports detected, dead declarations flagged, clean deps stay clean', async () => {
    const root = await fixture('au-both')
    try {
      const run = await runCli(['stats', '.', '--phantom', '--dead'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('DEPS AUDIT')
      expect(run.stdout).toContain('phantom imports')
      expect(run.stdout).toContain('chalk — src/index.ts')
      expect(run.stdout).toContain('side-effect — src/index.ts')
      expect(run.stdout).toContain('dead declarations')
      expect(run.stdout).toContain('unused — web (dependencies)')
      // relative imports + node builtins are never flagged
      expect(run.stdout).not.toContain('./util')
      expect(run.stdout).not.toContain('node:fs')

      const json = JSON.parse((await runCli(['stats', '.', '--phantom', '--dead', '--json'], { cwd: root, home: root })).stdout) as AuditPayload
      expect(json.depsAudit?.scannedFiles).toBe(1)
      expect(json.depsAudit?.phantom.map((hit) => hit.name).sort()).toEqual(['chalk', 'hoist', 'side-effect'])
      expect(json.depsAudit?.dead).toEqual([{ name: 'unused', sites: [], declaringProjects: ['web (dependencies)'] }])
      expect(json.depsAudit?.phantom.find((hit) => hit.name === 'chalk')?.sites).toEqual(['src/index.ts'])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('each flag focuses its half in text; JSON always carries both halves', async () => {
    const root = await fixture('au-focus')
    try {
      const deadOnly = await runCli(['stats', '.', '--dead'], { cwd: root, home: root })
      expect(deadOnly.stdout).toContain('dead declarations')
      expect(deadOnly.stdout).not.toContain('phantom imports')

      const phantomOnly = await runCli(['stats', '.', '--phantom'], { cwd: root, home: root })
      expect(phantomOnly.stdout).toContain('phantom imports')
      expect(phantomOnly.stdout).not.toContain('dead declarations')

      const jsonDeadOnly = JSON.parse((await runCli(['stats', '.', '--dead', '--json'], { cwd: root, home: root })).stdout) as AuditPayload
      expect(jsonDeadOnly.depsAudit?.phantom.map((hit) => hit.name)).toContain('chalk')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('peerDependencies never count as dead; the audit section is absent without the flags', async () => {
    const root = await tmpRoot('au-peer')
    try {
      const web = path.join(root, 'web')
      await fs.mkdir(path.join(web, 'node_modules', 'peerfix'), { recursive: true })
      await fs.writeFile(path.join(web, 'node_modules', 'peerfix', 'package.json'), '{"name":"peerfix","version":"1.0.0"}')
      await fs.writeFile(path.join(web, 'package.json'), JSON.stringify({ name: 'web', version: '1.0.0', peerDependencies: { peerfix: '^1.0.0' } }))

      const run = await runCli(['stats', '.', '--phantom', '--dead'], { cwd: root, home: root })
      expect(run.stdout).toContain('no phantom imports and no dead declarations detected')
      const json = JSON.parse((await runCli(['stats', '.', '--phantom', '--dead', '--json'], { cwd: root, home: root })).stdout) as AuditPayload
      expect(json.depsAudit?.dead).toEqual([])

      // default run: no audit section, depsAudit null
      const plain = JSON.parse((await runCli(['stats', '.', '--json'], { cwd: root, home: root })).stdout) as AuditPayload
      expect(plain.depsAudit).toBeNull()
      const plainText = await runCli(['stats', '.'], { cwd: root, home: root })
      expect(plainText.stdout).not.toContain('DEPS AUDIT')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('guards: --phantom/--dead need the stats command (exit 1)', async () => {
    const root = await fixture('au-flak')
    try {
      const scanAttempt = await runCli(['scan', '.', '--phantom'], { cwd: root, home: root })
      expect(scanAttempt.code).toBe(1)
      expect(scanAttempt.stderr).toContain('only work with the stats command')

      const deleteAttempt = await runCli(['stats', '.', '--dead', '--delete=trash', '-y'], { cwd: root, home: root })
      expect(deleteAttempt.code).toBe(1)
      expect(deleteAttempt.stderr).toContain('not with delete/clean')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
