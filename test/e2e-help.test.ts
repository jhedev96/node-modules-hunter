import { describe, expect, it } from 'vitest'
import { runCli } from './helpers.ts'

describe('full help table (v1.1.1 — manual renderer replaces cac help)', () => {
  it('nmh help lists commands, stat subcommands, all option groups and examples', async () => {
    const run = await runCli(['help'])
    expect(run.code).toBe(0)
    // every command family is present — previously the cac help showed only flags
    expect(run.stdout).toContain('nmh update')
    expect(run.stdout).toContain('nmh config <op>')
    expect(run.stdout).toContain('nmh why <pkg>')
    expect(run.stdout).toContain('nmh treemap [dir]')
    expect(run.stdout).toContain('nmh stats -g')
    expect(run.stdout).toContain('Stats subcommands')
    // the v1.1 features and every grouped option family
    expect(run.stdout).toContain('Options — Stale hunting')
    expect(run.stdout).toContain('--stale <days>')
    expect(run.stdout).toContain('--fast-size')
    expect(run.stdout).toContain('--sort <key>')
    expect(run.stdout).toContain('--trash system|nmh')
    expect(run.stdout).toContain('Options — Config family')
    expect(run.stdout).toContain('Options — Stats suite')
    expect(run.stdout).toContain('Examples')
    // cac's misleading "(default: true)" suffix on negated flags stays gone
    expect(run.stdout).not.toContain('(default: true)')
  })

  it('--help and -h render the same screen and exit 0', async () => {
    for (const flag of ['--help', '-h']) {
      const run = await runCli([flag])
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('Commands')
      expect(run.stdout).toContain('nmh <command|targets> [options]')
      expect(run.stdout).toContain('Exit codes')
      expect(run.stdout).toContain('Safety first')
    }
  })
})
