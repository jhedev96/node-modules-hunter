import path from 'node:path'
import fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { PROJECT_ROOT, runCli } from './helpers.ts'

describe('version e2e (spawned CLI, non-TTY)', () => {
  it('prints the rich report: tool, tagline, runtime, system, io', async () => {
    const run = await runCli(['version'])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('node-modules-hunter v')
    expect(run.stdout).toContain('hunt node_modules')
    expect(run.stdout).toContain('runtime')
    expect(run.stdout).toContain(`node ${process.version}`)
    expect(run.stdout).toMatch(/abi \d+/)
    expect(run.stdout).toContain('system')
    expect(run.stdout).toContain(process.platform)
    expect(run.stdout).toContain(process.arch)
    expect(run.stdout).toContain('kernel')
    expect(run.stdout).toContain('stdout tty: no')
  })

  it('--version flag prints the same report', async () => {
    const run = await runCli(['--version'])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('node-modules-hunter v')
    expect(run.stdout).toContain('runtime')
  })

  it('--json prints machine-readable fields matching the runtime', async () => {
    const run = await runCli(['version', '--json'])
    expect(run.code).toBe(0)
    const detail = JSON.parse(run.stdout) as {
      version: string
      node: string
      abi: string | null
      platform: string
      arch: string
      kernel: string
      distro: string | null
      stdoutTty: boolean
    }
    expect(detail.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(detail.node).toBe(process.version)
    expect(detail.platform).toBe(process.platform)
    expect(detail.arch).toBe(process.arch)
    expect(typeof detail.kernel).toBe('string')
    expect(detail.abi === null || typeof detail.abi === 'string').toBe(true)
    expect(detail.distro === null || typeof detail.distro === 'string').toBe(true)
    expect(detail.stdoutTty).toBe(false) // spawned with a pitted pipe
  })

  it('reported version tracks package.json', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string }
    const jsonRun = await runCli(['version', '--json'])
    const detail = JSON.parse(jsonRun.stdout) as { version: string }
    expect(detail.version).toBe(pkg.version)
  })
})
