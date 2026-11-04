import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'

/**
 * v1.2 wizard targeting: `wizard` is a registered command now, explicit --dir targets
 * skip the auto-climb, `nmh --wizard` is the flag form, and the `--` router opens a
 * read-only view before the menu. Every one of these is a TTY feature — piped runs
 * refuse loud (rc 1), which is exactly what the e2e gate can assert deterministically.
 */
describe('wizard targeting & the -- router (v1.2)', () => {
  it('`nmh wizard` is a registered command — non-TTY refuses with directions, rc 1', async () => {
    const fx = await tmpRoot('wizard-cmd')
    try {
      const run = await runCli(['wizard'], { cwd: fx })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('the wizard needs a TTY')
      // not the v1.1.1 unknown-command lapse — the command is known and refused for the right reason
      expect(run.stderr).not.toContain('unknown command')
    } finally {
      await fs.rm(fx, { recursive: true, force: true })
    }
  })

  it('`nmh --wizard` (flag form) refuses the same way in a pipe', async () => {
    const fx = await tmpRoot('wizard-flag')
    try {
      const run = await runCli(['--wizard'], { cwd: fx })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('the wizard needs a TTY')
    } finally {
      await fs.rm(fx, { recursive: true, force: true })
    }
  })

  it('explicit --dir targets are accepted syntax — the TTY refusal still wins in a pipe', async () => {
    const fx = await tmpRoot('wizard-dir')
    try {
      await fs.mkdir(path.join(fx, 'repo1', 'node_modules'), { recursive: true })
      const run = await runCli(['wizard', '--dir=./repo1'], { cwd: fx })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('the wizard needs a TTY')
    } finally {
      await fs.rm(fx, { recursive: true, force: true })
    }
  })

  it('router: an unknown view is a usage error BEFORE the TTY check', async () => {
    const fx = await tmpRoot('wizard-router-bad')
    try {
      const bogus = await runCli(['wizard', '--', 'bogus', '--dir=./x'], { cwd: fx })
      expect(bogus.code).toBe(1)
      expect(bogus.stderr).toContain('unknown wizard view: bogus')

      const destructive = await runCli(['wizard', '--', 'clean'], { cwd: fx })
      expect(destructive.code).toBe(1)
      expect(destructive.stderr).toContain('unknown wizard view: clean')
    } finally {
      await fs.rm(fx, { recursive: true, force: true })
    }
  })

  it('router: every allowed view name passes validation (TTY check then applies)', async () => {
    const fx = await tmpRoot('wizard-router-views')
    try {
      for (const view of ['stats', 'analyze', 'info', 'map', 'search', 'why', 'treemap']) {
        const run = await runCli(['wizard', '--', view], { cwd: fx })
        expect(run.code).toBe(1)
        expect(run.stderr).toContain('the wizard needs a TTY')
        expect(run.stderr).not.toContain('unknown wizard view')
      }
    } finally {
      await fs.rm(fx, { recursive: true, force: true })
    }
  })

  it('a stray `--` without the wizard is refused — the router belongs to the wizard', async () => {
    const fx = await tmpRoot('router-orphan')
    try {
      const run = await runCli(['scan', '--', '--top', '5'], { cwd: fx })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('router belongs to the wizard')
    } finally {
      await fs.rm(fx, { recursive: true, force: true })
    }
  })

  it('positional targets are the scan shortcut, not wizard syntax — refused with directions', async () => {
    const fx = await tmpRoot('wizard-positional')
    try {
      await fs.mkdir(path.join(fx, 'repo1'), { recursive: true })
      const run = await runCli(['wizard', './repo1'], { cwd: fx })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('wizard takes no positional targets')
      expect(run.stderr).toContain('--dir')
    } finally {
      await fs.rm(fx, { recursive: true, force: true })
    }
  })

  it('the bare `nmh` non-TTY fallback is untouched — compact banner + read-only scan, rc 0', async () => {
    const fx = await tmpRoot('wizard-bare-fallback')
    const nm = path.join(fx, 'proj', 'node_modules')
    try {
      await fs.mkdir(path.join(nm, 'pkg'), { recursive: true })
      await fs.writeFile(path.join(nm, 'pkg', 'package.json'), '{"name":"pkg","version":"1.0.0"}')
      const run = await runCli([], { cwd: fx })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('read-only scan')
      expect(run.stdout).toContain('proj')
    } finally {
      await fs.rm(fx, { recursive: true, force: true })
    }
  })
})
