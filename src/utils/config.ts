import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { expandTilde } from './paths.ts'
import { warn, verboseLog } from './logger.ts'
import { t } from '../i18n/index.ts'
import { isLocale } from '../i18n/index.ts'
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
  /** UI locale (v1.3): 'en' | 'id' | 'zh' | 'ru' | 'es' — sits above the env in the chain. */
  language?: string
  /** Update dist-tag (v1.4): which npm dist-tag `nmh update`/`--check` read from (default 'latest'). */
  updateTag?: string
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

/** npm dist-tag name shape: alphanumeric, dot, underscore, hyphen; must start/end alphanumeric (max 64). */
export function isValidDistTag(tag: string): boolean {
  return tag.length > 0 && tag.length <= 64 && /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i.test(tag)
}

function parseConfigBody(body: string, file: string): Partial<NmhConfig> {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (err) {
    throw new ConfigError(t('config.err.notJson', { file, detail: err instanceof Error ? err.message : String(err) }))
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(t('config.err.notObject', { file }))
  }

  const values: Partial<NmhConfig> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    switch (key) {
      case 'defaultMode':
        if (typeof value !== 'string' || !VALID_MODES.has(value)) {
          throw new ConfigError(t('config.err.invalidMode', { file, value: JSON.stringify(value) }))
        }
        // 'soft' is a documented alias of 'trash' (same as --delete)
        values.defaultMode = (value === 'soft' ? 'trash' : value) as DeleteMode
        break
      case 'depth':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
          throw new ConfigError(t('config.err.invalidDepth', { file, value: JSON.stringify(value) }))
        }
        values.depth = value
        break
      case 'exclude':
      case 'keep':
        if (
          !Array.isArray(value) ||
          value.some((item) => typeof item !== 'string' || item.length === 0)
        ) {
          throw new ConfigError(t('config.err.invalidList', { file, key }))
        }
        values[key] = value
        break
      case 'color':
      case 'animate':
      case 'updateCheck':
        if (typeof value !== 'boolean') {
          throw new ConfigError(t('config.err.notBoolean', { file, key, value: JSON.stringify(value) }))
        }
        values[key] = value
        break
      case 'language':
        if (typeof value !== 'string' || !isLocale(value.trim().toLowerCase())) {
          throw new ConfigError(t('config.err.invalidLanguage', { file, value: JSON.stringify(value) }))
        }
        values.language = value.trim().toLowerCase()
        break
      case 'logDir':
        if (typeof value !== 'string' || value.length === 0) {
          throw new ConfigError(t('config.err.invalidLogDir', { file }))
        }
        values.logDir = expandTilde(value)
        break
      case 'updateTag':
        if (typeof value !== 'string' || !isValidDistTag(value)) {
          throw new ConfigError(t('config.err.invalidUpdateTag', { file, value: JSON.stringify(value) }))
        }
        values.updateTag = value
        break
      default:
        warn(t('config.warn.unknownKey', { file, key }))
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
    throw new ConfigError(t('config.err.unreadable', { file, code: code ?? String(err) }))
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
      throw new ConfigError(t('config.err.notFound', { file: abs }), 'file-not-found')
    }
    verboseLog(t('verbose.configUsing', { file: abs }))
    return { values: parseConfigBody(body, abs), source: abs }
  }

  let current = path.resolve(cwd)
  const home = path.resolve(homedir())
  for (;;) {
    for (const name of FILE_NAMES) {
      const candidate = path.join(current, name)
      const body = await readMaybe(candidate)
      if (body !== null) {
        verboseLog(t('verbose.configFound', { file: candidate }))
        return { values: parseConfigBody(body, candidate), source: candidate }
      }
    }
    // stop AFTER the home dir; also stop at the filesystem root (cwd outside home)
    if (current === home || current === path.dirname(current)) break
    current = path.dirname(current)
  }
  // cwd outside $HOME: the climb never passes the home dir, but a .nmhrc there is still
  // the documented fallback — config set writes to it, so scans should read it too.
  const homeChain = cwd === home || cwd.startsWith(home + path.sep)
  if (!homeChain) {
    for (const name of FILE_NAMES) {
      const candidate = path.join(home, name)
      const body = await readMaybe(candidate)
      if (body !== null) {
        verboseLog(t('verbose.configFound', { file: candidate }))
        return { values: parseConfigBody(body, candidate), source: candidate }
      }
    }
  }
  return { values: {}, source: null }
}
