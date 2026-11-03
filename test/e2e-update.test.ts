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
}

async function rmTree(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
}

/** Hermetic registry: NMH_UPDATE_LATEST_JSON replaces the `npm view` spawn. */
async function latestFile(dir: string, version: string): Promise<string> {
  const file = path.join(dir, 'latest.json')
  await fs.writeFile(file, JSON.stringify({ version }), 'utf8')
  return file
}

/** Empty npm prefix → `npm ls -g` answers rc 1 → "not npm-global", deterministically. */
async function emptyPrefix(dir: string): Promise<string> {
  const prefix = path.join(dir, 'npm-prefix')
  await fs.mkdir(prefix, { recursive: true })
  return prefix
}

describe('nmh update (v1.1) — explicit self-update', () => {
  it('already latest: rc 0, updated=false, no install, --json payload present', async () => {
    const root = await tmpRoot('update-latest')
    try {
      const latest = await latestFile(root, currentVersion)
      const prefix = await emptyPrefix(root)
      const run = await runCli(['update', '--json'], {
        home: root,
        envExtra: { NMH_UPDATE_LATEST_JSON: latest, NPM_CONFIG_PREFIX: prefix },
      })
      expect(run.code).toBe(0)
      const json = JSON.parse(run.stdout) as UpdatePayload
      expect(json.current).toBe(currentVersion)
      expect(json.latest).toBe(currentVersion)
      expect(json.updated).toBe(false)
      expect(json.method).toBe('manual')
    } finally {
      await rmTree(root)
    }
  })

  it('outdated but not npm-global: manual advice, nothing installed, rc 0', async () => {
    const root = await tmpRoot('update-manual')
    try {
      const latest = await latestFile(root, '9.9.9')
      const prefix = await emptyPrefix(root)
      const run = await runCli(['update'], {
        home: root,
        envExtra: { NMH_UPDATE_LATEST_JSON: latest, NPM_CONFIG_PREFIX: prefix },
      })
      expect(run.code).toBe(0)
      // advice is a side-channel note (stderr) — stdout stays payload/table-clean
      expect(run.stderr).toContain('update manual')
      expect(run.stderr).toContain('npm i -g node-modules-hunter')
      expect(run.stdout).toBe('')
      const json = await runCli(['update', '--json'], {
        home: root,
        envExtra: { NMH_UPDATE_LATEST_JSON: latest, NPM_CONFIG_PREFIX: prefix },
      })
      const payload = JSON.parse(json.stdout) as UpdatePayload
      expect(payload.updated).toBe(false)
      expect(payload.method).toBe('manual')
      expect(payload.latest).toBe('9.9.9')
    } finally {
      await rmTree(root)
    }
  })

  it('outdated + npm-global: installs via npm (recorded by the fake-install hatch)', async () => {
    const root = await tmpRoot('update-global')
    try {
      const latest = await latestFile(root, '9.9.9')
      const prefix = path.join(root, 'npm-prefix')
      // a global-looking install: <prefix>/lib/node_modules/node-modules-hunter
      await fs.mkdir(path.join(prefix, 'lib', 'node_modules', 'node-modules-hunter'), { recursive: true })
      await fs.writeFile(
        path.join(prefix, 'lib', 'node_modules', 'node-modules-hunter', 'package.json'),
        JSON.stringify({ name: 'node-modules-hunter', version: '0.0.1' }),
        'utf8',
      )
      const fake = path.join(root, 'fake-install.txt')
      const run = await runCli(['update', '--json'], {
        home: root,
        envExtra: { NMH_UPDATE_LATEST_JSON: latest, NPM_CONFIG_PREFIX: prefix, NMH_UPDATE_FAKE_INSTALL: fake },
      })
      expect(run.code).toBe(0)
      const json = JSON.parse(run.stdout) as UpdatePayload
      expect(json.current).toBe(currentVersion)
      expect(json.latest).toBe('9.9.9')
      expect(json.updated).toBe(true)
      expect(json.method).toBe('npm-global')
      const recorded = await fs.readFile(fake, 'utf8')
      expect(recorded).toBe('npm install -g node-modules-hunter@9.9.9\n')
    } finally {
      await rmTree(root)
    }
  })

  it('unreachable registry (override file missing) → rc 1 with a clear message; args are refused', async () => {
    const root = await tmpRoot('update-fail')
    try {
      const prefix = await emptyPrefix(root)
      const run = await runCli(['update', '--json'], {
        home: root,
        envExtra: { NMH_UPDATE_LATEST_JSON: path.join(root, 'nope.json'), NPM_CONFIG_PREFIX: prefix },
      })
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('cannot read the latest version')

      const args = await runCli(['update', 'extra'], { home: root, envExtra: { NPM_CONFIG_PREFIX: await emptyPrefix(root) } })
      expect(args.code).toBe(1)
      expect(args.stderr).toContain('takes no arguments')
    } finally {
      await rmTree(root)
    }
  })
})
