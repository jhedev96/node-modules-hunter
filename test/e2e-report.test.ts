import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'

interface ScanPayload {
  totals: { folders: number; size: number }
}

/** Two small node_modules so the scan output has real content to save. */
async function twoEntryFixture(label: string): Promise<string> {
  const root = await tmpRoot(label)
  for (const rel of ['a/node_modules', 'b/node_modules']) {
    await fs.mkdir(path.join(root, rel), { recursive: true })
    await fs.writeFile(path.join(root, rel, 'package.json'), '{"name":"x","version":"1.0.0"}')
  }
  return root
}

describe('report e2e (--save-report / --report)', () => {
  it('.json copy parses and matches the on-screen totals; stdout stays the table', async () => {
    const root = await twoEntryFixture('sr-json')
    try {
      const run = await runCli(['scan', root, '--save-report', 'rep.json'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('Path') // table still on screen
      expect(run.stderr).toContain('report saved') // note on stderr, not stdout
      const payload = JSON.parse(await fs.readFile(path.join(root, 'rep.json'), 'utf8')) as ScanPayload
      expect(payload.totals.folders).toBe(2)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('.md and .txt copies are the plain text view with zero ANSI escapes', async () => {
    const root = await twoEntryFixture('sr-md')
    try {
      await runCli(['scan', root, '--save-report', 'doc.md'], { cwd: root, home: root })
      const md = await fs.readFile(path.join(root, 'doc.md'), 'utf8')
      expect(md).not.toMatch(/\x1b\[/)
      expect(md).toContain('Path')
      expect(md).toContain('a/node_modules')

      await runCli(['scan', root, '--report', 'plain.txt'], { cwd: root, home: root })
      const txt = await fs.readFile(path.join(root, 'plain.txt'), 'utf8')
      expect(txt).not.toMatch(/\x1b\[/)
      expect(txt).toContain('Path')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('missing parent directories are created; with --json the screen stays JSON while the file renders by extension', async () => {
    const root = await twoEntryFixture('sr-mk')
    try {
      const run = await runCli(['scan', root, '--json', '--save-report', 'out/deep/scan.md'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(() => JSON.parse(run.stdout) as ScanPayload).not.toThrow()
      const md = await fs.readFile(path.join(root, 'out', 'deep', 'scan.md'), 'utf8')
      expect(md).not.toMatch(/^\{/) // file copy is the text view, not the JSON view
      expect(md).toContain('Path')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('usage errors: unknown extension, bare --report, delete/clean pairing → exit 1', async () => {
    const root = await twoEntryFixture('sr-bad')
    try {
      const badExt = await runCli(['scan', root, '--save-report', 'rep.csv'], { cwd: root, home: root })
      expect(badExt.code).toBe(1)
      expect(badExt.stderr).toContain('unknown report format')

      const bare = await runCli(['scan', root, '--report'], { cwd: root, home: root })
      expect(bare.code).toBe(1)
      expect(bare.stderr).toContain('needs a file path')

      const withDelete = await runCli(['--dir', root, '--delete=trash', '-y', '--save-report', 'r.json'], { cwd: root, home: root })
      expect(withDelete.code).toBe(1)
      expect(withDelete.stderr).toContain('--save-report rides along with scan')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('animate e2e (live counter gate)', () => {
  it('non-TTY default keeps the counter hidden; --animate forces it visible', async () => {
    const root = await twoEntryFixture('an-mode')
    try {
      const quiet = await runCli(['scan', root], { cwd: root, home: root })
      expect(quiet.code).toBe(0)
      expect(quiet.stdout).not.toContain('⠋')

      const animated = await runCli(['scan', root, '--animate'], { cwd: root, home: root })
      expect(animated.code).toBe(0)
      expect(animated.stdout).toContain('⠋')
      expect(animated.stdout).toContain('measuring')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('config animate:false mutes the default; CLI --animate still wins; --json always stays clean', async () => {
    const root = await twoEntryFixture('an-cfg')
    try {
      await fs.writeFile(path.join(root, '.nmhrc'), JSON.stringify({ animate: false }))
      const muted = await runCli(['scan', root], { cwd: root, home: root })
      expect(muted.stdout).not.toContain('⠋')

      const overridden = await runCli(['scan', root, '--animate'], { cwd: root, home: root })
      expect(overridden.stdout).toContain('⠋')

      const jsonRun = await runCli(['scan', root, '--json', '--animate'], { cwd: root, home: root })
      expect(jsonRun.code).toBe(0)
      expect(() => JSON.parse(jsonRun.stdout) as ScanPayload).not.toThrow() // counter must not pollute stdout
      expect(JSON.parse(jsonRun.stdout).totals.folders).toBe(2)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
