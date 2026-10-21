import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export function tmpRoot(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `nmh-${label}-`)).then((dir) => fs.realpath(dir))
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Spawn the built CLI like a real user would (non-TTY by construction). */
export async function runCli(
  args: string[],
  options: { cwd?: string; home?: string; timeout?: number; envExtra?: Record<string, string> } = {},
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (options.home) env.HOME = options.home
  if (options.envExtra) Object.assign(env, options.envExtra)
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [path.join(PROJECT_ROOT, 'dist', 'cli.js'), ...args],
      {
        cwd: options.cwd,
        env,
        timeout: options.timeout ?? 45_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
    )
    return { code: 0, stdout, stderr }
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

const KB = 1024

export interface MonorepoFixture {
  root: string
  paths: {
    web: string
    webEntry: string
    api: string
    apiEntry: string
    mobile: string
    mobileEntry: string
    bun: string
    bunEntry: string
    outside: string
    loop: string
    loopEntry: string
  }
}

/**
 * Deterministic mini-monorepo:
 *  - web: pnpm (lockfile), nested node_modules, .pnpm/.cache dotdirs, scope + symlink + broken symlink
 *  - api: npm lockfile
 *  - mobile: yarn lockfile
 *  - bun: bun.lock
 *  - loop: self-symlinked node_modules (ELOOP)
 */
export async function monorepoFixture(label = 'mono'): Promise<MonorepoFixture> {
  const root = await tmpRoot(label)
  const web = path.join(root, 'web')
  const webEntry = path.join(web, 'node_modules')
  const api = path.join(root, 'api')
  const apiEntry = path.join(api, 'node_modules')
  const mobile = path.join(root, 'mobile')
  const mobileEntry = path.join(mobile, 'node_modules')
  const bun = path.join(root, 'bun-app')
  const bunEntry = path.join(bun, 'node_modules')
  const outside = path.join(root, 'outside-lib')
  const loop = path.join(root, 'loop')

  // web — pnpm project
  await fs.mkdir(path.join(webEntry, 'react'), { recursive: true })
  await fs.mkdir(path.join(webEntry, '@scope', 'lib'), { recursive: true })
  await fs.mkdir(path.join(webEntry, '.pnpm', 'store'), { recursive: true })
  await fs.mkdir(path.join(webEntry, '.cache'), { recursive: true })
  await fs.mkdir(path.join(webEntry, 'react', 'nested', 'node_modules', 'foo'), { recursive: true })
  await fs.writeFile(path.join(web, 'package.json'), '{"name":"web"}')
  await fs.writeFile(path.join(web, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0')
  await fs.writeFile(path.join(webEntry, 'react', 'package.json'), '{"name":"react","version":"1.0.0"}')
  await fs.writeFile(path.join(webEntry, 'react', 'index.js'), Buffer.alloc(4 * KB))
  await fs.writeFile(path.join(webEntry, '@scope', 'lib', 'package.json'), '{"name":"@scope/lib"}')
  await fs.writeFile(path.join(webEntry, '@scope', 'lib', 'index.js'), Buffer.alloc(4 * KB))
  await fs.writeFile(path.join(webEntry, '.pnpm', 'store', 'file.bin'), Buffer.alloc(4 * KB))
  await fs.writeFile(path.join(webEntry, '.cache', 'junk.bin'), Buffer.alloc(2 * KB))
  await fs.writeFile(
    path.join(webEntry, 'react', 'nested', 'node_modules', 'foo', 'package.json'),
    '{"name":"nested"}',
  )
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(outside, 'package.json'), '{"name":"outside"}')
  await fs.symlink(path.relative(webEntry, outside), path.join(webEntry, 'linked'))
  // dangling symlink: never followed, never sized
  await fs.symlink('../does-not-exist-anywhere', path.join(webEntry, 'dangling'))

  // api — npm project
  await fs.mkdir(path.join(apiEntry, 'express'), { recursive: true })
  await fs.writeFile(path.join(api, 'package.json'), '{"name":"api"}')
  await fs.writeFile(path.join(api, 'package-lock.json'), '{"lockfileVersion":3}')
  await fs.writeFile(path.join(apiEntry, 'express', 'package.json'), '{"name":"express"}')
  await fs.writeFile(path.join(apiEntry, 'express', 'index.js'), Buffer.alloc(4 * KB))

  // mobile — yarn project
  await fs.mkdir(path.join(mobileEntry, 'vue'), { recursive: true })
  await fs.mkdir(path.join(mobileEntry, 'vite'), { recursive: true })
  await fs.writeFile(path.join(mobile, 'package.json'), '{"name":"mobile"}')
  await fs.writeFile(path.join(mobile, 'yarn.lock'), '# yarn lockfile v1')
  await fs.writeFile(path.join(mobileEntry, 'vue', 'package.json'), '{"name":"vue"}')
  await fs.writeFile(path.join(mobileEntry, 'vite', 'package.json'), '{"name":"vite"}')

  // bun project
  await fs.mkdir(path.join(bunEntry, 'zod'), { recursive: true })
  await fs.writeFile(path.join(bun, 'package.json'), '{"name":"bun-app"}')
  await fs.writeFile(path.join(bun, 'bun.lock'), '{"lockfileVersion":0}')
  await fs.writeFile(path.join(bunEntry, 'zod', 'package.json'), '{"name":"zod"}')

  // loop — self-symlink victim for guard tests
  await fs.mkdir(loop, { recursive: true })
  await fs.symlink('node_modules', path.join(loop, 'node_modules'))

  return {
    root,
    paths: { web, webEntry, api, apiEntry, mobile, mobileEntry, bun, bunEntry, outside, loop, loopEntry: path.join(loop, 'node_modules') },
  }
}

export interface VpFixture {
  root: string
  project: string
  entry: string
}

/** pnpm project that declares the vite-plus wrapper (drives the v0.2 `[vp]` tag). */
export async function vpFixture(label = 'vp'): Promise<VpFixture> {
  const root = await tmpRoot(label)
  const project = path.join(root, 'app')
  const entry = path.join(project, 'node_modules')
  await fs.mkdir(path.join(entry, 'vite'), { recursive: true })
  await fs.writeFile(
    path.join(project, 'package.json'),
    '{"name":"app","dependencies":{"vite-plus":"^0.1.0"},"devDependencies":{"vite":"^5.0.0"}}',
  )
  await fs.writeFile(path.join(project, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0')
  await fs.writeFile(path.join(entry, 'vite', 'package.json'), '{"name":"vite"}')
  return { root, project, entry }
}
