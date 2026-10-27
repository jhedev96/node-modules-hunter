import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'

interface DeprecatedPayload {
  mode?: string
  deprecations: {
    count: number
    refs: Array<{ name: string; version: string | null; displayPath: string; source: 'manifest' | 'registry'; message?: string }>
    truncated: boolean
    online: boolean
  } | null
}

/**
 * web: old-lodash carries npm's installed `deprecated` note (offline path);
 * fresh is fine (no note, registry answers "no deprecation"); reg-only has no
 * local note — only the registry fixture knows it's deprecated.
 */
async function fixture(label: string, opts: { ansi?: boolean } = {}): Promise<string> {
  const root = await tmpRoot(label)
  const web = path.join(root, 'web')
  const pkgs: Array<[string, boolean, string | undefined]> = [
    ['old-lodash', false, 'This version has a prototype pollution bug — please upgrade to 4.17.20+'],
    ['fresh', false, undefined],
    ['reg-only', false, undefined],
  ]
  if (opts.ansi) {
    pkgs.push(['ansi-pkg', false, '\u001b[31mBAD note still readable\u001b[0m'])
  }
  for (const [name, , note] of pkgs) {
    const pkgDir = path.join(web, 'node_modules', name)
    await fs.mkdir(pkgDir, { recursive: true })
    await fs.writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify(note !== undefined ? { name, version: '4.17.19', deprecated: note } : { name, version: '1.0.0' }),
    )
  }
  await fs.writeFile(
    path.join(web, 'package.json'),
    JSON.stringify({
      name: 'web',
      version: '1.0.0',
      dependencies: {
        'old-lodash': '^4',
        fresh: '^1',
        'reg-only': '^1',
        ...(opts.ansi ? { 'ansi-pkg': '^1' } : {}),
      },
    }),
  )
  return root
}

/** Tiny registry stub: deprecations for reg-only@1.0.0 only; counts every handled request. */
async function startRegistry(port: number | undefined = undefined): Promise<{ url: string; hits: { n: number }; close: () => Promise<void> }> {
  const hits = { n: 0 }
  const server = http.createServer((request, response) => {
    hits.n += 1
    if (request.url === '/reg-only/1.0.0') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ name: 'reg-only', version: '1.0.0', deprecated: 'This release is not supported anymore' }))
      return
    }
    response.statusCode = 200
    response.end(JSON.stringify({ name: 'x', version: 'y' }))
  })
  await new Promise<void>((resolve) => server.listen(port ?? 0, '127.0.0.1', resolve))
  const address = server.address()
  const url = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : 'http://127.0.0.1:0'
  return {
    url,
    hits,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      }),
  }
}

describe('deprecated scan e2e (--online)', () => {
  it('flags local manifest notes offline-style, silences fine packages', async () => {
    const root = await fixture('dep-local')
    try {
      const run = await runCli(['stats', '.', '--online'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('DEPRECATED')
      expect(run.stdout).toContain('1 instance deprecated')
      expect(run.stdout).toContain('old-lodash@4.17.19')
      expect(run.stdout).toContain('prototype pollution')

      const json = JSON.parse((await runCli(['stats', '.', '--online', '--json'], { cwd: root, home: root })).stdout) as DeprecatedPayload
      expect(json.mode).toBe('deprecated')
      expect(json.deprecations?.count).toBe(1)
      expect(json.deprecations?.refs).toHaveLength(1)
      expect(json.deprecations?.refs[0]).toMatchObject({ name: 'old-lodash', version: '4.17.19', source: 'manifest' })
      expect(json.deprecations?.truncated).toBe(false)
      // without --online: no deprecated section at all
      const plain = JSON.parse((await runCli(['stats', '.', '--json'], { cwd: root, home: root })).stdout) as DeprecatedPayload
      expect(plain.deprecations).toBeNull()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('fills missing notes from a registry (lazy), then serves repeats from cache with the server closed', async () => {
    const root = await fixture('dep-online')
    const registry = await startRegistry()
    try {
      const envExtra = { NMH_REGISTRY_URL: registry.url }
      const first = JSON.parse((await runCli(['stats', '.', '--online', '--json'], { cwd: root, home: root, envExtra })).stdout) as DeprecatedPayload
      const refs = first.deprecations?.refs ?? []
      expect(refs).toHaveLength(2) // manifest note + registry note
      expect(refs.find((ref) => ref.name === 'reg-only')).toMatchObject({ source: 'registry', message: 'This release is not supported anymore' })
      const served = registry.hits.n
      expect(served).toBeGreaterThanOrEqual(2) // reg-only + fresh both consulted
      expect(served).toBeLessThanOrEqual(25) // cap sanity (fixture only asks 2)

      // second run: registry is gone — the cache under ~/.nmh must answer identically
      await registry.close()
      const second = JSON.parse((await runCli(['stats', '.', '--online', '--json'], { cwd: root, home: root, envExtra: { NMH_REGISTRY_URL: 'http://127.0.0.1:1' } })).stdout) as DeprecatedPayload
      expect(second.deprecations?.refs.map((ref) => [ref.name, ref.version, ref.source, ref.message])).toEqual(
        refs.map((ref) => [ref.name, ref.version, ref.source, ref.message]),
      )
      // and the cache actually sits in the fixture home
      const cached = await fs.readFile(path.join(root, '.nmh', 'cache', 'registry-deprecated', 'reg-only@1.0.0.json'), 'utf8')
      expect(JSON.parse(cached)).toMatchObject({ message: 'This release is not supported anymore' })
    } finally {
      await registry.close().catch(() => undefined)
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('strips ANSI escape bytes from deprecated notes (manifest text, v0.9.4)', async () => {
    const root = await fixture('dep-ansi', { ansi: true })
    try {
      const run = await runCli(['stats', '.', '--online', '--json'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      const json = JSON.parse(run.stdout) as DeprecatedPayload
      const ref = json.deprecations?.refs.find((item) => item.name === 'ansi-pkg')
      expect(ref).toBeDefined()
      expect(ref && JSON.stringify(ref)).not.toMatch(/\x1b/)
      expect(ref?.message).toBe('BAD note still readable')
      // note text unchanged apart from the escape stripping
      expect(json.deprecations?.count).toBeGreaterThanOrEqual(1)
      const text = await runCli(['stats', '.', '--online'], { cwd: root, home: root })
      expect(text.stdout).not.toMatch(/\x1b\[31m/)
      expect(text.stdout).toContain('BAD note still readable')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('guards: --online outside stats exits 1', async () => {    const root = await fixture('dep-guard')
    try {
      const misuse = await runCli(['scan', '.', '--online'], { cwd: root, home: root })
      expect(misuse.code).toBe(1)
      expect(misuse.stderr).toContain('--online')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
