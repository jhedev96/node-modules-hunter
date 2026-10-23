import os from 'node:os'
import { createRequire } from 'node:module'
import { colors } from './logger.ts'

let cached: string | null = null

/** Tool version, read from package.json relative to the built entry; safe fallback for odd runtimes. */
export function toolVersion(): string {
  if (cached) return cached
  const fallback = '0.1.0'
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('../package.json') as { version?: unknown }
    cached = typeof pkg.version === 'string' ? pkg.version : fallback
  } catch {
    cached = fallback
  }
  return cached
}

/** Everything the enriched `nmh version` report can say about the current runtime. */
export interface VersionDetail {
  version: string
  /** `process.version`, e.g. `v24.22.1`. */
  node: string
  /** V8/Node ABI (`process.versions.modules`) — useful when a native module breaks. */
  abi: string | null
  platform: string
  arch: string
  /** Kernel release (`os.release()`), e.g. `6.1.0-generic`. */
  kernel: string
  /** Distribution string (`os.version()`), when the OS publishes one. */
  distro: string | null
  /** Whether stdout is a terminal right now. */
  stdoutTty: boolean
}

/** Rich `nmh version` payload (v0.7): tool + runtime + system + io, all cheap sync calls. */
export function versionDetail(): VersionDetail {
  let distro: string | null = null
  try {
    const value = os.version()
    // Linux kernel build stamps ('#1 SMP …') appear when no os-release exists — those are kernel noise, not a distro.
    if (typeof value === 'string' && value.trim().length > 0 && !value.trim().startsWith('#')) distro = value.trim()
  } catch {
    distro = null
  }
  return {
    version: toolVersion(),
    node: process.version,
    abi: process.versions.modules ?? null,
    platform: process.platform,
    arch: process.arch,
    kernel: os.release(),
    distro,
    stdoutTty: process.stdout.isTTY === true,
  }
}

/** Human view: title + tagline, then aligned `runtime` / `system` / `io` rows. */
export function renderVersionDetail(detail: VersionDetail): string {
  const row = (key: string, value: string): string => `${colors.dim(key.padEnd(9, ' '))}${value}`
  const systemParts = [`${detail.platform} ${detail.arch}`, `kernel ${detail.kernel}`]
  if (detail.distro !== null) systemParts.push(detail.distro)
  return [
    colors.bold(`node-modules-hunter v${detail.version}`),
    colors.dim('hunt node_modules — scan · measure · clean safely'),
    row('runtime', `node ${detail.node}${detail.abi === null ? '' : ` (abi ${detail.abi})`}`),
    row('system', systemParts.join(' · ')),
    row('io', `stdout tty: ${detail.stdoutTty ? 'yes' : 'no'}`),
  ].join('\n')
}
