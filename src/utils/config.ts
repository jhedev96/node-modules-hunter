import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { expandTilde } from './paths.ts'
import { warn, verboseLog } from './logger.ts'
import type { DeleteMode } from '../core/result.ts'

export class ConfigError extends Error {
  /** Machine reason for the hand-off in cli.ts — no message string-matching. */
  readonly code: string

  constructor(message: string, code = 'invalid') {
    super(message)
    this.code = code
  }
}

export interface NmhConfig {
  /** Default delete mode for bare `--delete` and the wizard's pre-highlighted option. */
  defaultMode: DeleteMode
  /** Max scan depth when --depth is not given. */
  depth: number
  exclude: string[]
  keep: string[]
  color: boolean
  animate: boolean
  /** --update-check opt-in from the config file (PRD §5.5); CLI flag wins the same way. */
  updateCheck?: boolean
  /** Tilde-expanded recovery-log directory. */
  logDir: string
}

export interface LoadedConfig {
  values: Partial<NmhConfig>
  /** Absolute path of the file the values came from, or null when everything is default. */
  source: string | null
}

const FILE_NAMES = ['.nmhrc', '.nmhrc.json']
const VALID_MODES = new Set(['hard', 'soft', 'trash'])

function parseConfigBody(body: string, file: string): Partial<NmhConfig> {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (err) {
    throw new ConfigError(`invalid config: ${file} is not valid JSON (${err instanceof Error ? err.message : String(err)})`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`invalid config: ${file} must contain a JSON object`)
  }

  const values: Partial<NmhConfig> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    switch (key) {
      case 'defaultMode':
        if (typeof value !== 'string' || !VALID_MODES.has(value)) {
          throw new ConfigError(`invalid config: ${file}: defaultMode must be 'hard' | 'soft' | 'trash' (got ${JSON.stringify(value)})`)
        }
        // 'soft' is a documented alias of 'trash' (same as --delete)
        values.defaultMode = (value === 'soft' ? 'trash' : value) as DeleteMode
        break
      case 'depth':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
          throw new ConfigError(`invalid config: ${file}: depth must be a non-negative integer (got ${JSON.stringify(value)})`)
        }
        values.depth = value
        break
      case 'exclude':
      case 'keep':
        if (
          !Array.isArray(value) ||
          value.some((item) => typeof item !== 'string' || item.length === 0)
        ) {
          throw new ConfigError(`invalid config: ${file}: ${key} must be an array of non-empty strings`)
        }
        values[key] = value
        break
      case 'color':
      case 'animate':
      case 'updateCheck':
        if (typeof value !== 'boolean') {
          throw new ConfigError(`invalid config: ${file}: ${key} must be true or false (got ${JSON.stringify(value)})`)
        }
        values[key] = value
        break
      case 'logDir':
        if (typeof value !== 'string' || value.length === 0) {
          throw new ConfigError(`invalid config: ${file}: logDir must be a non-empty string`)
        }
        values.logDir = expandTilde(value)
        break
      default:
        warn(`${file}: unknown config key "${key}" — ignored`)
    }
  }
  return values
}

async function readMaybe(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (code === 'EISDIR') return null
    throw new ConfigError(`config unreadable: ${file} (${code ?? String(err)})`)
  }
}

/**
 * Load `.nmhrc` (PRD §10). Explicit `--config <file>` replaces the lookup entirely.
 * Implicit lookup: nearest `.nmhrc`/`.nmhrc.json` walking from cwd up to the home
 * directory (inclusive); outside home the walk tops out at the filesystem root.
 */
export async function loadConfig(explicitPath: string | null, cwd: string): Promise<LoadedConfig> {
  if (explicitPath !== null) {
    const raw = expandTilde(explicitPath)
    const abs = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw)
    const body = await readMaybe(abs)
    if (body === null) {
      throw new ConfigError(`config file not found: ${abs}`, 'file-not-found')
    }
    verboseLog(`config: using ${abs}`)
    return { values: parseConfigBody(body, abs), source: abs }
  }

  let current = path.resolve(cwd)
  const home = path.resolve(homedir())
  for (;;) {
    for (const name of FILE_NAMES) {
      const candidate = path.join(current, name)
      const body = await readMaybe(candidate)
      if (body !== null) {
        verboseLog(`config: found ${candidate}`)
        return { values: parseConfigBody(body, candidate), source: candidate }
      }
    }
    // stop AFTER the home dir; also stop at the filesystem root (cwd outside home)
    if (current === home || current === path.dirname(current)) break
    current = path.dirname(current)
  }
  return { values: {}, source: null }
}
