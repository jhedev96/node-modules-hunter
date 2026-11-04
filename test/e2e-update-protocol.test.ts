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
      expect(fresh.stdout).toContain('sudah versi terbaru')
      expect(fresh.stdout).toContain(currentVersion)

      await fs.writeFile(path.join(root, 'latest.json'), JSON.stringify({ version: '9.9.9' }))
      const stale = await runCli(['update', '--check'], { home: root, envExtra: seams(root, '9.9.9', '0') })
      expect(stale.code).toBe(0)
      expect(stale.stdout).toContain('update tersedia')
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
      expect(run.stdout).toContain('update      tersedia')
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
      expect(run.stderr).toContain('-y untuk menginstall')
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
      expect(declined.stdout).toContain('tidak diinstall')
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
      expect(forced.stdout).toContain('terupdate')
      expect(await fs.readFile(fake, 'utf8')).toBe('npm install -g node-modules-hunter@9.9.9\n')

      // force + up-to-date: check, report, DO NOT reinstall
      await fs.rm(fake, { force: true })
      await fs.writeFile(path.join(root, 'same.json'), JSON.stringify({ version: currentVersion }))
      const fresh = await runCli(['update', '--force'], {
        home: root,
        envExtra: { NMH_UPDATE_LATEST_JSON: path.join(root, 'same.json'), NMH_UPDATE_GLOBAL: '1', NMH_UPDATE_FAKE_INSTALL: fake },
      })
      expect(fresh.code).toBe(0)
      expect(fresh.stdout).toContain('sudah versi terbaru')
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
})
