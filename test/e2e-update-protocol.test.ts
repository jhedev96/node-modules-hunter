import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROJECT_ROOT, runCli, tmpRoot } from './helpers.ts'

const currentVersion: string = JSON.parse(
  await fs.readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
).version

interface UpdatePayload {
  current: string
  latest: string
  updated: boolean
  method: 'npm-global' | 'manual'
  updateAvailable: boolean
  tag?: string
  target?: string
  direction?: 'upgrade' | 'downgrade' | 'current'
  distTags?: Record<string, string>
  detail?: Record<string, unknown>
}

async function rmTree(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
}

function seams(dir: string, latest: string, global: '0' | '1'): Record<string, string> {
  return {
    NMH_UPDATE_LATEST_JSON: path.join(dir, 'latest.json'),
    NMH_UPDATE_GLOBAL: global,
  }
}

const infoManifest = {
  version: '9.9.9',
  description: 'hunt bloated node_modules folders',
  license: 'MIT',
  dist: { tarball: 'https://registry.npmjs.org/x.tgz', unpackedSize: 236_000, fileCount: 4 },
  engines: { node: '>=18' },
}

describe('nmh update protocol (v1.2) — read-only views, consented install', () => {
  it('--check: compact compare, never installs (up-to-date and available both exit 0)', async () => {
    const root = await tmpRoot('update-check')
    try {
      await fs.writeFile(path.join(root, 'same.json'), JSON.stringify({ version: currentVersion }))
      const fresh = await runCli(['update', '--check'], {
        home: root,
        envExtra: { NMH_UPDATE_LATEST_JSON: path.join(root, 'same.json'), NMH_UPDATE_GLOBAL: '0' },
      })
      expect(fresh.code).toBe(0)
      expect(fresh.stdout).toContain('is already the latest version')
      expect(fresh.stdout).toContain(currentVersion)

      await fs.writeFile(path.join(root, 'latest.json'), JSON.stringify({ version: '9.9.9' }))
      const stale = await runCli(['update', '--check'], { home: root, envExtra: seams(root, '9.9.9', '0') })
      expect(stale.code).toBe(0)
      expect(stale.stdout).toContain('update available')
      expect(stale.stdout).toContain('9.9.9')
    } finally {
      await rmTree(root)
    }
  })

  it('--check --json: the payload gains updateAvailable (additive); frozen keys intact', async () => {
    const root = await tmpRoot('update-check-json')
    try {
      await fs.writeFile(path.join(root, 'latest.json'), JSON.stringify({ version: '9.9.9' }))
      const run = await runCli(['update', '--check', '--json'], { home: root, envExtra: seams(root, '9.9.9', '0') })
      expect(run.code).toBe(0)
      const payload = JSON.parse(run.stdout) as UpdatePayload
      expect(payload.updateAvailable).toBe(true)
      expect(payload.updated).toBe(false)
      expect(payload.method).toBe('manual')
      expect(Object.keys(payload)).toEqual(expect.arrayContaining(['current', 'latest', 'updated', 'method']))
    } finally {
      await rmTree(root)
    }
  })

  it('--info: npm-view style registry detail, stdout, never installs', async () => {
    const root = await tmpRoot('update-info')
    try {
      await fs.writeFile(path.join(root, 'latest.json'), JSON.stringify(infoManifest))
      const run = await runCli(['update', '--info'], { home: root, envExtra: seams(root, '9.9.9', '0') })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('info registry')
      expect(run.stdout).toContain('summary     hunt bloated node_modules folders')
      expect(run.stdout).toContain('license     MIT')
      expect(run.stdout).toContain('engines     node >=18')
      expect(run.stdout).toContain('230.5 KB')
      expect(run.stdout).toContain('update      available')
      // read-only: no install hatch touched
      expect(await fs.readFile(path.join(root, 'fake-install.txt'), 'utf8').then(() => false, () => true)).toBe(true)

      const json = await runCli(['update', '--info', '--json'], { home: root, envExtra: seams(root, '9.9.9', '0') })
      const payload = JSON.parse(json.stdout) as UpdatePayload
      expect(payload.detail?.description).toBe('hunt bloated node_modules folders')
      expect(payload.detail?.fileCount).toBe(4)
    } finally {
      await rmTree(root)
    }
  })

  it('--check and --info are mutually exclusive views → rc 1', async () => {
    const root = await tmpRoot('update-exclusive')
    try {
      const run = await runCli(['update', '--check', '--info'], { home: root, envExtra: seams(root, currentVersion, '0') })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('--check and --info')
    } finally {
      await rmTree(root)
    }
  })

  it('plain update, non-TTY, no answer → refused loud like a delete without -y (rc 1)', async () => {
    const root = await tmpRoot('update-unanswered')
    try {
      await fs.writeFile(path.join(root, 'latest.json'), JSON.stringify({ version: '9.9.9' }))
      const run = await runCli(['update'], { home: root, envExtra: seams(root, '9.9.9', '1') })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('-y to install')
      // --json is machine mode — same refusal (no interactive prompt possible)
      const jsonRun = await runCli(['update', '--json'], { home: root, envExtra: seams(root, '9.9.9', '1') })
      expect(jsonRun.code).toBe(1)
    } finally {
      await rmTree(root)
    }
  })

  it('-n declines with rc 0 and nothing installs; -y installs (fake hatch records it)', async () => {
    const root = await tmpRoot('update-answer')
    try {
      await fs.writeFile(path.join(root, 'latest.json'), JSON.stringify({ version: '9.9.9' }))
      const fake = path.join(root, 'fake.txt')
      const declined = await runCli(['update', '-n'], {
        home: root,
        envExtra: { ...seams(root, '9.9.9', '1'), NMH_UPDATE_FAKE_INSTALL: fake },
      })
      expect(declined.code).toBe(0)
      expect(declined.stdout).toContain('was not installed')
      expect(await fs.readFile(fake, 'utf8').then(() => true, () => false)).toBe(false)

      const installed = await runCli(['update', '-y', '--json'], {
        home: root,
        envExtra: { ...seams(root, '9.9.9', '1'), NMH_UPDATE_FAKE_INSTALL: fake },
      })
      expect(installed.code).toBe(0)
      const payload = JSON.parse(installed.stdout) as UpdatePayload
      expect(payload.updated).toBe(true)
      expect(await fs.readFile(fake, 'utf8')).toBe('npm install -g node-modules-hunter@9.9.9\n')
    } finally {
      await rmTree(root)
    }
  })

  it('--force skips the ask when an update exists — but an already-latest install is never reinstalled', async () => {
    const root = await tmpRoot('update-force')
    try {
      const fake = path.join(root, 'fake.txt')
      // force + available: straight to install, no answer flags needed
      await fs.writeFile(path.join(root, 'latest.json'), JSON.stringify({ version: '9.9.9' }))
      const forced = await runCli(['update', '--force'], {
        home: root,
        envExtra: { ...seams(root, '9.9.9', '1'), NMH_UPDATE_FAKE_INSTALL: fake },
      })
      expect(forced.code).toBe(0)
      expect(forced.stdout).toContain('updated')
      expect(await fs.readFile(fake, 'utf8')).toBe('npm install -g node-modules-hunter@9.9.9\n')

      // force + up-to-date: check, report, DO NOT reinstall
      await fs.rm(fake, { force: true })
      await fs.writeFile(path.join(root, 'same.json'), JSON.stringify({ version: currentVersion }))
      const fresh = await runCli(['update', '--force'], {
        home: root,
        envExtra: { NMH_UPDATE_LATEST_JSON: path.join(root, 'same.json'), NMH_UPDATE_GLOBAL: '1', NMH_UPDATE_FAKE_INSTALL: fake },
      })
      expect(fresh.code).toBe(0)
      expect(fresh.stdout).toContain('is already the latest version')
      expect(await fs.readFile(fake, 'utf8').then(() => true, () => false)).toBe(false)
    } finally {
      await rmTree(root)
    }
  })

  it('--check/--info outside the update command are refused; positional args stay refused', async () => {
    const root = await tmpRoot('update-guards')
    try {
      const scanRun = await runCli(['scan', '--check'], { home: root })
      expect(scanRun.code).toBe(1)
      expect(scanRun.stderr).toContain('--check only works with the update command')

      const infoRun = await runCli(['scan', '--info'], { home: root })
      expect(infoRun.code).toBe(1)
      expect(infoRun.stderr).toContain('--info only works with the update command')

      const args = await runCli(['update', 'extra', '-y'], { home: root, envExtra: seams(root, currentVersion, '0') })
      expect(args.code).toBe(1)
      expect(args.stderr).toContain('takes no arguments')
    } finally {
      await rmTree(root)
    }
  })

  it('regression (v1.2.0 hotfix): modern npm view --json is an abbreviated PACKUMENT ARRAY — --info must normalize it', async () => {
    const root = await tmpRoot('update-packument')
    try {
      await fs.writeFile(path.join(root, 'latest.json'), JSON.stringify({ version: '9.9.9' }))
      // the exact shape npm ≥10 prints for `npm view <pkg> --json` — no top-level `version`,
      // versions as a string list; v1.2.0 parsed this and exited "cannot read" everywhere
      await fs.writeFile(
        path.join(root, 'packument.json'),
        JSON.stringify([
          {
            _id: 'node-modules-hunter@9.9.9',
            name: 'node-modules-hunter',
            'dist-tags': { latest: '9.9.9' },
            versions: ['1.0.0', '1.1.0', '9.9.9'],
            description: 'hunt bloated node_modules folders',
            license: 'MIT',
            dist: { tarball: 'https://registry.npmjs.org/x.tgz', unpackedSize: 236_000, fileCount: 4 },
            engines: { node: '>=18' },
          },
        ]),
      )
      const run = await runCli(['update', '--info'], {
        home: root,
        envExtra: { ...seams(root, '9.9.9', '0'), NMH_UPDATE_VIEW_JSON: path.join(root, 'packument.json') },
      })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('latest      9.9.9')
      expect(run.stdout).toContain('summary     hunt bloated node_modules folders')
      expect(run.stdout).toContain('tarball     https://registry.npmjs.org/x.tgz')
      // a single-object view payload works the same way
      await fs.writeFile(path.join(root, 'single.json'), JSON.stringify(infoManifest))
      const single = await runCli(['update', '--info', '--json'], {
        home: root,
        envExtra: { ...seams(root, '9.9.9', '0'), NMH_UPDATE_VIEW_JSON: path.join(root, 'single.json') },
      })
      const payload = JSON.parse(single.stdout) as UpdatePayload
      expect(payload.detail?.fileCount).toBe(4)
      // an unreadable detail fetch must not sink the run — facts minus detail, rc 0
      await fs.writeFile(path.join(root, 'broken.json'), 'not json{')
      const broken = await runCli(['update', '--info'], {
        home: root,
        envExtra: { ...seams(root, '9.9.9', '0'), NMH_UPDATE_VIEW_JSON: path.join(root, 'broken.json') },
      })
      expect(broken.code).toBe(0)
      expect(broken.stdout).toContain('latest      9.9.9')
      expect(broken.stdout).not.toContain('summary')
    } finally {
      await rmTree(root)
    }
  })
})

describe('nmh update dist-tags (v1.4) — tag compare, downgrade consent, config updateTag', () => {
  /** v1.4 seam set: LATEST_JSON (manifest) + DIST_TAGS_JSON (tag map) — fully hermetic. */
  async function tagEnv(root: string, tags: Record<string, string>, global: '0' | '1'): Promise<Record<string, string>> {
    await fs.writeFile(path.join(root, 'latest.json'), JSON.stringify({ version: tags.latest }))
    await fs.writeFile(path.join(root, 'dist-tags.json'), JSON.stringify(tags))
    return {
      NMH_UPDATE_LATEST_JSON: path.join(root, 'latest.json'),
      NMH_UPDATE_DIST_TAGS_JSON: path.join(root, 'dist-tags.json'),
      NMH_UPDATE_GLOBAL: global,
    }
  }

  it('--check <tag>: compares against the named dist-tag; bare --check still reads latest', async () => {
    const root = await tmpRoot('update-tag-check')
    try {
      const env = await tagEnv(root, { latest: '9.9.9', beta: '9.9.9-beta.2', lts: '0.5.0' }, '0')
      const beta = await runCli(['update', '--check', 'beta'], { home: root, envExtra: env })
      expect(beta.code).toBe(0)
      expect(beta.stdout).toContain('9.9.9-beta.2')
      expect(beta.stdout).toContain('dist-tag: beta')
      // the lts tag points BELOW the installed version — compare only, rc 0 either way
      const lts = await runCli(['update', '--check', 'lts'], { home: root, envExtra: env })
      expect(lts.code).toBe(0)
      expect(lts.stdout).toContain('0.5.0')
      const bare = await runCli(['update', '--check'], { home: root, envExtra: env })
      expect(bare.code).toBe(0)
      expect(bare.stdout).toContain('9.9.9')
      expect(bare.stdout).not.toContain('dist-tag:')
      // --tag names the tag for every mode; --check inherits it when bare
      const viaTag = await runCli(['update', '--tag', 'beta', '--check'], { home: root, envExtra: env })
      expect(viaTag.stdout).toContain('dist-tag: beta')
      // --json carries the additive keys: tag, target, direction
      const json = await runCli(['update', '--check', 'beta', '--json'], { home: root, envExtra: env })
      const payload = JSON.parse(json.stdout) as UpdatePayload
      expect(payload.tag).toBe('beta')
      expect(payload.target).toBe('9.9.9-beta.2')
      expect(payload.latest).toBe('9.9.9') // latest keeps its historical meaning
      expect(payload.direction).toBe('upgrade')
    } finally {
      await rmTree(root)
    }
  })

  it('--info lists every dist-tag in the text view and the distTags map in --json', async () => {
    const root = await tmpRoot('update-tag-info')
    try {
      const env = await tagEnv(root, { latest: '9.9.9', beta: '9.9.9-beta.2' }, '0')
      const run = await runCli(['update', '--info'], { home: root, envExtra: env })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('dist-tags   latest=9.9.9, beta=9.9.9-beta.2')
      const json = await runCli(['update', '--info', '--json'], { home: root, envExtra: env })
      const payload = JSON.parse(json.stdout) as UpdatePayload
      expect(payload.distTags).toEqual({ latest: '9.9.9', beta: '9.9.9-beta.2' })
      expect(payload.detail?.fileCount).toBeUndefined() // bare version override — no detail facts
    } finally {
      await rmTree(root)
    }
  })

  it('unknown tag → rc 1 with the available list; malformed tag names → rc 1 before any spawn', async () => {
    const root = await tmpRoot('update-tag-unknown')
    try {
      const env = await tagEnv(root, { latest: '9.9.9', beta: '9.9.9-beta.2' }, '0')
      const unknown = await runCli(['update', '--tag', 'nope', '--check'], { home: root, envExtra: env })
      expect(unknown.code).toBe(1)
      expect(unknown.stderr).toContain('dist-tag "nope" not found')
      expect(unknown.stderr).toContain('latest, beta')

      const malformed = await runCli(['update', '--tag', 'Bad Tag!'], { home: root, envExtra: env })
      expect(malformed.code).toBe(1)
      expect(malformed.stderr).toContain('invalid dist-tag')

      const bare = await runCli(['update', '--tag'], { home: root, envExtra: env })
      expect(bare.code).toBe(1)
      expect(bare.stderr).toContain('--tag needs a dist-tag name')

      // --tag outside update → same loud guard family as --check/--info
      const scan = await runCli(['scan', '--tag', 'beta'], { home: root })
      expect(scan.code).toBe(1)
      expect(scan.stderr).toContain('--tag only works with the update command')
    } finally {
      await rmTree(root)
    }
  })

  it('downgrade: non-TTY without -y refuses (rc 1); -y installs the OLDER target with direction=downgrade', async () => {
    const root = await tmpRoot('update-tag-downgrade')
    try {
      const fake = path.join(root, 'fake.txt')
      const env = await tagEnv(root, { latest: '0.5.0' }, '1')
      // non-TTY, no answer → refused loud, exactly like an upgrade without -y
      const refused = await runCli(['update'], { home: root, envExtra: env })
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain('-y to install')
      // -n declines with rc 0 — nothing installs
      const declined = await runCli(['update', '-n'], {
        home: root,
        envExtra: { ...env, NMH_UPDATE_FAKE_INSTALL: fake },
      })
      expect(declined.code).toBe(0)
      expect(declined.stdout).toContain('was not installed')
      expect(await fs.readFile(fake, 'utf8').then(() => true, () => false)).toBe(false)
      // -y installs the older target — the fake hatch records the exact command
      const downgraded = await runCli(['update', '-y', '--json'], {
        home: root,
        envExtra: { ...env, NMH_UPDATE_FAKE_INSTALL: fake },
      })
      expect(downgraded.code).toBe(0)
      const payload = JSON.parse(downgraded.stdout) as UpdatePayload
      expect(payload.direction).toBe('downgrade')
      expect(payload.updated).toBe(true)
      expect(payload.target).toBe('0.5.0')
      expect(payload.updateAvailable).toBe(false)
      expect(await fs.readFile(fake, 'utf8')).toBe('npm install -g node-modules-hunter@0.5.0\n')
    } finally {
      await rmTree(root)
    }
  })

  it('config --update-tag: set / invalid / unset persist; rc updateTag drives --check', async () => {
    const root = await tmpRoot('update-tag-config')
    try {
      const rc = path.join(root, 'custom.nmhrc')
      const set = await runCli(['config', 'set', '--update-tag=beta', '--config', rc], { cwd: root, home: root })
      expect(set.code).toBe(0)
      expect(JSON.parse(await fs.readFile(rc, 'utf8')).updateTag).toBe('beta')

      const bad = await runCli(['config', 'set', '--update-tag=Bad Tag!', '--config', rc], { cwd: root, home: root })
      expect(bad.code).toBe(1)
      expect(bad.stderr).toContain('--update-tag')

      // the persisted tag feeds the update check — no --tag flag needed
      const env = await tagEnv(root, { latest: '9.9.9', beta: '9.9.9-beta.2' }, '0')
      const check = await runCli(['update', '--check', '--config', rc], { home: root, envExtra: env })
      expect(check.code).toBe(0)
      expect(check.stdout).toContain('9.9.9-beta.2')
      expect(check.stdout).toContain('dist-tag: beta')

      const unset = await runCli(['config', 'unset', '--update-tag', '--config', rc], { cwd: root, home: root })
      expect(unset.code).toBe(0)
      expect('updateTag' in JSON.parse(await fs.readFile(rc, 'utf8'))).toBe(false)

      // a malformed updateTag in .nmhrc is a hard config error
      await fs.writeFile(rc, JSON.stringify({ updateTag: 'no spaces here' }))
      const rcBad = await runCli(['update', '--check', '--config', rc], { home: root, envExtra: env })
      expect(rcBad.code).toBe(1)
      expect(rcBad.stderr).toContain('updateTag')
    } finally {
      await rmTree(root)
    }
  })
})
