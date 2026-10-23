import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'

interface ConfigPayload {
  nmh: string
  command: string
  source?: string | null
  values?: Record<string, unknown>
  op?: string
  file?: string
  applied?: Record<string, unknown>
  unset?: string[]
}

interface ScanPayload {
  totals: { folders: number }
}

interface ConfigJson {
  run: import('./helpers.ts').RunResult
  payload: ConfigPayload
}

const configJson = async (args: string[], opts: { cwd: string; home?: string }): Promise<ConfigJson> => {
  const run = await runCli(['config', ...args, '--json'], opts)
  try {
    return { run, payload: JSON.parse(run.stdout) as ConfigPayload }
  } catch {
    throw new Error(`configJson: expected JSON but got (code=${run.code}); args=${JSON.stringify(args)} out=${run.stdout.slice(0, 200)}`)
  }
}

const readRc = async (file: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>

/** Flat project tree: proj/{node_modules,a/node_modules} + an OUTSIDE proj2/node_modules
 * (true sibling for --exclude=self tests) + package.json files for keep flows. */
async function selfFixture(label: string, config: Record<string, unknown>): Promise<string> {
  const root = await tmpRoot(label)
  await fs.writeFile(path.join(root, '.nmhrc'), JSON.stringify(config))
  for (const rel of ['proj/node_modules', 'proj/a/node_modules', 'proj2/node_modules']) {
    const entry = path.join(root, rel)
    await fs.mkdir(entry, { recursive: true })
    await fs.writeFile(path.join(entry, 'package.json'), '{"name":"x","version":"1.0.0"}')
  }
  await fs.writeFile(path.join(root, 'proj', 'package.json'), '{"name":"proj","version":"1.0.0"}')
  await fs.writeFile(path.join(root, 'proj2', 'package.json'), '{"name":"proj2","version":"1.0.0"}')
  return root
}

describe('nmh config — info (read-only)', () => {
  it('info --json reports the active file and its values', async () => {
    const root = await tmpRoot('cfg-info')
    try {
      const rc = path.join(root, 'mine.nmhrc')
      await fs.writeFile(rc, JSON.stringify({ depth: 2, exclude: ['.npm', 'self'] }))
      const { run, payload } = await configJson(['info', '--config', rc], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(payload.source).toBe(rc)
      expect(payload.values).toEqual({ depth: 2, exclude: ['.npm', 'self'] })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('info with no config anywhere → source null, still exit 0', async () => {
    const root = await tmpRoot('cfg-info-none')
    try {
      const { run, payload } = await configJson(['info'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(payload.source).toBeNull()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('info refuses key flags (they belong to set/add/remove)', async () => {
    const root = await tmpRoot('cfg-info-bad')
    try {
      const run = await runCli(['config', 'info', '--default-exclude=.,self'], { cwd: root, home: root })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('read-only')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('nmh config — set / add / remove / unset (write flows)', () => {
  it('set replaces lists and writes scalars; unknown keys survive untouched', async () => {
    const root = await tmpRoot('cfg-set')
    try {
      const rc = path.join(root, 'custom.nmhrc')
      await fs.writeFile(rc, JSON.stringify({ exclude: ['old'], unknownFutureKey: { keep: true } }))
      const { run, payload } = await configJson(
        ['set', '--default-exclude=.npm,.nvm,self', '--depth=2', '--config', rc],
        { cwd: root, home: root },
      )
      expect(run.code).toBe(0)
      expect(payload.file).toBe(rc)
      expect(payload.applied).toEqual({ depth: 2, exclude: ['.npm', '.nvm', 'self'] })
      const onDisk = await readRc(rc)
      expect(onDisk.exclude).toEqual(['.npm', '.nvm', 'self'])
      expect(onDisk.depth).toBe(2)
      expect(onDisk.unknownFutureKey).toEqual({ keep: true }) // honny tolerance → write-side preservation
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('add appends with dedupe; remove drops items; bare remove clears the list', async () => {
    const root = await tmpRoot('cfg-addremove')
    try {
      const rc = path.join(root, 'custom.nmhrc')
      await configJson(['add', '--default-exclude=.npm,self', '--config', rc], { cwd: root, home: root })
      expect((await readRc(rc)).exclude).toEqual(['.npm', 'self'])
      await configJson(['add', '--default-exclude=self,.cache', '--config', rc], { cwd: root, home: root })
      expect((await readRc(rc)).exclude).toEqual(['.npm', 'self', '.cache'])
      await configJson(['remove', '--default-exclude=self', '--config', rc], { cwd: root, home: root })
      expect((await readRc(rc)).exclude).toEqual(['.npm', '.cache'])
      // bare remove = clear the whole list
      const cleared = await configJson(['remove', '--default-exclude', '--config', rc], { cwd: root, home: root })
      expect(cleared.run.code).toBe(0)
      expect((await readRc(rc)).exclude).toEqual([])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('unset deletes keys from the file (back to defaults)', async () => {
    const root = await tmpRoot('cfg-unset')
    try {
      const rc = path.join(root, 'custom.nmhrc')
      await fs.writeFile(rc, JSON.stringify({ depth: 2, exclude: ['self'], animate: false, foreign: 1 }))
      await configJson(['unset', '--depth', '--default-exclude', '--animate', '--config', rc], { cwd: root, home: root })
      const onDisk = await readRc(rc)
      expect('depth' in onDisk).toBe(false)
      expect('exclude' in onDisk).toBe(false)
      expect('animate' in onDisk).toBe(false)
      expect(onDisk.foreign).toBe(1)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('config family validates: bad depth/mode, bare add, empty set, unknown op, positional junk', async () => {
    const root = await tmpRoot('cfg-valid')
    try {
      const rc = path.join(root, 'custom.nmhrc')
      const cases: Array<{ args: string[]; expectIn: string }> = [
        { args: ['set', '--depth=-1', '--config', rc], expectIn: '--depth' },
        { args: ['set', '--default-mode=bogus', '--config', rc], expectIn: '--default-mode' },
        { args: ['add', '--default-exclude', '--config', rc], expectIn: 'needs items' },
        { args: ['set', '--config', rc], expectIn: 'needs at least one key' },
        { args: ['unset', '--config', rc], expectIn: 'needs a key' },
      ]
      for (const item of cases) {
        const run = await runCli(['config', ...item.args], { cwd: root, home: root })
        expect(run.code, item.args.join(' ')).toBe(1)
        expect(run.stderr, item.args.join(' ')).toContain(item.expectIn)
      }
      const noOp = await runCli(['config'], { cwd: root, home: root })
      expect(noOp.code).toBe(1)
      expect(noOp.stderr).toContain('config needs an op')
      const junkOp = await runCli(['config', 'frobnicate'], { cwd: root, home: root })
      expect(junkOp.code).toBe(1)
      const junkArgs = await runCli(['config', 'info', 'extra'], { cwd: root, home: root })
      expect(junkArgs.code).toBe(1)
      // delete flag does not belong to the family
      const withDelete = await runCli(['config', 'set', '--depth=1', '--delete'], { cwd: root, home: root })
      expect(withDelete.code).toBe(1)
      expect(withDelete.stderr).toContain('--delete')
      // the refused writes must not have touched the file
      expect(await fs.readFile(rc, 'utf8').catch(() => null)).toBeNull()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('nmh config — the written defaults actually apply (round-trip)', () => {
  it('config add --default-exclude writes .nmhrc; the next scan honors it', async () => {
    const root = await selfFixture('cfg-apply', {})
    try {
      const prep = await configJson(['add', '--default-exclude=**/a/**', '--depth=2'], { cwd: root, home: root })
      expect(prep.run.code).toBe(0)
      expect(prep.payload.file).toBe(path.join(root, '.nmhrc')) // home-pinned default target
      const scan = await runCli(['scan', 'proj', '--json'], { cwd: root, home: root })
      const payload = JSON.parse(scan.stdout) as ScanPayload
      expect(payload.totals.folders).toBe(1) // only proj/node_modules — **/a/** landed from .nmhrc
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('nmh config — "self" token (scan-level guard)', () => {
  it('exclude self: running nmh from inside a project finds nothing there (exit 2)', async () => {
    const root = await selfFixture('cfg-self-exclude', { depth: 3, exclude: ['self'] })
    try {
      // --json keeps stderr clean (payload-pure convention) — assert the empty outcome on code only
      const guarded = await runCli(['scan', 'proj', '--json'], { cwd: root, home: root })
      expect(guarded.code).toBe(2)
      // control: other exclusion lists do NOT trigger the guard
      const bare = await selfFixture('cfg-self-exclude-control', {})
      const control = await runCli(['scan', 'proj', '--json'], { cwd: bare, home: bare })
      expect(control.code, control.stderr).toBe(0)
      await fs.rm(bare, { recursive: true, force: true })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('self via the runtime flag too: --exclude=self guards the cwd subtree', async () => {
    const root = await selfFixture('cfg-self-flag', {})
    try {
      const run = await runCli(['scan', 'proj', '--json', '--exclude=self'], { cwd: root, home: root })
      expect(run.code).toBe(2) // --json: message stays out of stderr, exit code carries it
      const sibling = await selfFixture('cfg-self-flag-sibling', {})
      try {
        // a scan rooted OUTSIDE the cwd subtree still finds its own entry —
        // the guard covers exactly the cwd subtree, nothing wider
        const fromSibling = await runCli(['scan', '../proj2', '--json', '--exclude=self'], {
          cwd: path.join(root, 'proj'),
          home: root,
        })
        const payload = JSON.parse(fromSibling.stdout) as ScanPayload
        expect(fromSibling.code, fromSibling.stderr).toBe(0)
        expect(payload.totals.folders).toBe(1)
      } finally {
        await fs.rm(sibling, { recursive: true, force: true })
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('keep self: a delete op from inside the project refuses to touch it (dir survives)', async () => {
    const root = await selfFixture('cfg-self-keep', { depth: 2, keep: ['self'] })
    try {
      const run = await runCli(['--dir', 'proj', '--delete=trash', '-y'], { cwd: root, home: root })
      expect(run.code).toBe(2) // dropped before the delete pipeline → nothing found
      expect(run.stderr).toContain('no node_modules found')
      expect(await fs.readdir(path.join(root, 'proj'))).toContain('node_modules')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
