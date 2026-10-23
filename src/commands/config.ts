import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { ConfigError, loadConfig, type NmhConfig } from '../utils/config.ts'
import { errorLog, log, payload, colors } from '../utils/logger.ts'
import { expandTilde } from '../utils/paths.ts'

export type ConfigOp = 'info' | 'set' | 'add' | 'remove' | 'unset'

export interface ConfigCommandRequest {
  op: ConfigOp
  cwd: string
  json?: boolean
  /** --config <file>: manage exactly this file instead of ~/.nmhrc. */
  explicitFile?: string
  /** --default-exclude=… (string / repeated / comma list); bare `true` = flag given without a value. */
  defaultExclude?: string | boolean | Array<string | boolean>
  /** --default-keep=… — same shapes. */
  defaultKeep?: string | boolean | Array<string | boolean>
  defaultMode?: string | boolean | Array<string | boolean>
  logDir?: string | boolean | Array<string | boolean>
  depth?: string | number | boolean | Array<string | number | boolean>
  animate?: boolean | string | Array<boolean | string>
  color?: boolean | string | Array<boolean | string>
  updateCheck?: boolean | string | Array<boolean | string>
}

const VALID_MODES = new Set(['hard', 'soft', 'trash'])
const KNOWN_KEYS = ['defaultMode', 'depth', 'exclude', 'keep', 'color', 'animate', 'updateCheck', 'logDir'] as const
type KnownKey = (typeof KNOWN_KEYS)[number]

const KEY_TO_FLAG: Record<KnownKey, string> = {
  defaultMode: 'default-mode',
  depth: 'depth',
  exclude: 'default-exclude',
  keep: 'default-keep',
  color: 'color',
  animate: 'animate',
  updateCheck: 'update-check',
  logDir: 'log-dir',
}
const LIST_KEYS: Record<'default-exclude' | 'default-keep', KnownKey> = {
  'default-exclude': 'exclude',
  'default-keep': 'keep',
}

const DEFAULT_TARGET = '.nmhrc' // relative to $HOME

/** Some(=value) or none (bare flag) book-keeping for scalar/list inputs. */
interface Given<T> {
  given: boolean
  value: T | null
}

function scalar(raw: unknown): Given<string | number | boolean> {
  if (raw === undefined) return { given: false, value: null }
  if (Array.isArray(raw)) {
    // cac repeated-tag quirk: repeated scalars arrive as arrays; last real value wins, trailing trues ignored
    const last = [...raw].reverse().find((item) => String(item) !== 'true')
    return last === undefined ? { given: true, value: null } : { given: true, value: last as string | number | boolean }
  }
  return { given: true, value: raw as string | number | boolean }
}

/** Comma list and/or repeated flags → flat trimmed strings. */
function listValues(raw: ConfigCommandRequest['defaultExclude']): Given<string[]> {
  if (raw === undefined) return { given: false, value: null }
  if (raw === true) return { given: true, value: null } // bare flag — clear/remove semantics (or a usage error)
  const items = (Array.isArray(raw) ? raw : [raw]).filter((item) => item !== true)
  const out: string[] = []
  for (const item of items) {
    for (const part of String(item).split(',')) {
      const trimmed = part.trim()
      if (trimmed.length > 0) out.push(trimmed)
    }
  }
  return { given: true, value: out }
}

function flagBool(raw: unknown): Given<boolean> {
  if (raw === undefined) return { given: false, value: null }
  if (typeof raw === 'boolean') return { given: true, value: raw }
  if (Array.isArray(raw)) {
    const booleans = raw.filter((item): item is boolean => typeof item === 'boolean')
    // last explicit boolean wins (--flag → true, --no-flag → false, repeated → last)
    return booleans.length > 0 ? { given: true, value: booleans[booleans.length - 1] } : { given: true, value: null }
  }
  const text = String(raw).toLowerCase()
  if (text === 'true' || text === 'false') return { given: true, value: text === 'true' }
  return { given: true, value: null }
}

function parseDepth(raw: unknown): number {
  const given = scalar(raw)
  if (!given.given || given.value === null) {
    throw new ConfigError('--depth needs a non-negative integer — nmh config set --depth 2')
  }
  const numeric = typeof given.value === 'number' ? given.value : Number(String(given.value).trim())
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new ConfigError(`invalid --depth value: ${JSON.stringify(given.value)} (expected a non-negative integer)`)
  }
  return numeric
}

function parseMode(raw: unknown): 'hard' | 'trash' {
  const value = scalar(raw).value
  if (typeof value !== 'string' || !VALID_MODES.has(value)) {
    throw new ConfigError(`invalid --default-mode: ${JSON.stringify(value ?? null)} (expected hard | soft | trash)`)
  }
  return value === 'soft' ? 'trash' : (value as 'hard' | 'trash')
}

function parseBool(raw: unknown, label: string): boolean {
  const given = flagBool(raw)
  if (given.value === null) {
    throw new ConfigError(`${label} needs true or false — e.g. nmh config set --animate=false`)
  }
  return given.value
}

/** The file being managed: --config <file>, else $HOME/.nmhrc. Tilde/relative are resolved. */
export function configWriteTarget(explicitFile: string | undefined, cwd: string): string {
  if (explicitFile !== undefined && explicitFile.length > 0) {
    const raw = expandTilde(explicitFile)
    return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw)
  }
  return path.join(homedir(), DEFAULT_TARGET)
}

type ListMode = 'replace' | 'append' | 'remove' | 'clear'

interface Mutation {
  scalars: Partial<Record<Exclude<KnownKey, 'exclude' | 'keep'>, unknown>>
  lists: Array<{ key: KnownKey; mode: ListMode; values: string[] }>
  unsetKeys: KnownKey[]
}

function listMutation(op: ConfigOp, flag: 'default-exclude' | 'default-keep', given: Given<string[]>): Mutation['lists'][number] {
  const key = LIST_KEYS[flag]
  const bare = given.value === null
  switch (op) {
    case 'set':
      if (bare) throw new ConfigError(`config set --${flag} needs the list value — e.g. --${flag}=.npm,.nvm`)
      return { key, mode: 'replace', values: given.value ?? [] }
    case 'add':
      if (bare) throw new ConfigError(`config add --${flag} needs items to append — e.g. --${flag}=.cache,self`)
      return { key, mode: 'append', values: given.value ?? [] }
    default:
      if (bare) return { key, mode: 'clear', values: [] }
      return { key, mode: 'remove', values: given.value ?? [] }
  }
}

function assemble(request: ConfigCommandRequest): Mutation {
  const mutation: Mutation = { scalars: {}, lists: [], unsetKeys: [] }
  const defaultExclude = listValues(request.defaultExclude)
  const defaultKeep = listValues(request.defaultKeep)

  if (request.op === 'set') {
    if (defaultExclude.given) mutation.lists.push(listMutation('set', 'default-exclude', defaultExclude))
    if (defaultKeep.given) mutation.lists.push(listMutation('set', 'default-keep', defaultKeep))
    if (scalar(request.depth).given) mutation.scalars.depth = parseDepth(request.depth)
    if (scalar(request.defaultMode).given) mutation.scalars.defaultMode = parseMode(request.defaultMode)
    if (scalar(request.logDir).given) {
      const value = scalar(request.logDir).value
      if (typeof value !== 'string' || value.length === 0) throw new ConfigError('--log-dir needs a non-empty directory path')
      mutation.scalars.logDir = value
    }
    for (const key of ['animate', 'color', 'updateCheck'] as const) {
      if (flagBool(request[key]).given) mutation.scalars[key] = parseBool(request[key], `--${KEY_TO_FLAG[key]}`)
    }
    if (mutation.lists.length === 0 && Object.keys(mutation.scalars).length === 0) {
      throw new ConfigError('config set needs at least one key — nmh config set --depth 2 | --default-mode trash | --default-exclude .npm,self | …')
    }
    return mutation
  }

  if (request.op === 'add' || request.op === 'remove') {
    let used = false
    if (defaultExclude.given) {
      mutation.lists.push(listMutation(request.op, 'default-exclude', defaultExclude))
      used = true
    }
    if (defaultKeep.given) {
      mutation.lists.push(listMutation(request.op, 'default-keep', defaultKeep))
      used = true
    }
    if (!used) {
      throw new ConfigError(`config ${request.op} works on list keys — use --default-exclude or --default-keep`)
    }
    return mutation
  }

  // unset: the flags mark which keys to delete from the file (back to defaults)
  if (defaultExclude.given) mutation.unsetKeys.push('exclude')
  if (defaultKeep.given) mutation.unsetKeys.push('keep')
  for (const key of ['defaultMode', 'logDir', 'depth', 'animate', 'color', 'updateCheck'] as const) {
    if (request[key] !== undefined) mutation.unsetKeys.push(key)
  }
  if (mutation.unsetKeys.length === 0) {
    throw new ConfigError('config unset needs a key — e.g. nmh config unset --default-exclude (or --depth)')
  }
  return mutation
}

async function readRawConfig(file: string): Promise<Record<string, unknown>> {
  let body: string | null
  try {
    body = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {} // fresh file
    throw new ConfigError(`config unreadable: ${file} (${(err as NodeJS.ErrnoException).code ?? String(err)})`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (err) {
    throw new ConfigError(`invalid config: ${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — fix it before nmh config writes`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`invalid config: ${file} must contain a JSON object`)
  }
  return raw as Record<string, unknown>
}

function applyList(current: unknown, mutation: Mutation['lists'][number]): string[] {
  if (mutation.mode === 'replace') return mutation.values
  const base = Array.isArray(current) ? current.filter((item): item is string => typeof item === 'string') : []
  if (mutation.mode === 'clear') return []
  if (mutation.mode === 'append') {
    const merged = [...base]
    for (const value of mutation.values) {
      if (!merged.includes(value)) merged.push(value)
    }
    return merged
  }
  const drop = new Set(mutation.values) // remove: idempotent, unknown items tolerated
  return base.filter((item) => !drop.has(item))
}

export async function writeConfigMutation(file: string, mutation: Mutation): Promise<Partial<NmhConfig>> {
  // Unknown keys survive untouched: the loader ignores them (honny tolerance), writes must preserve them.
  const raw = await readRawConfig(file)
  const applied: Partial<NmhConfig> = {}

  for (const [key, value] of Object.entries(mutation.scalars)) {
    raw[key] = value
    ;(applied as Record<string, unknown>)[key] = value
  }
  for (const list of mutation.lists) {
    const result = applyList(raw[list.key], list)
    raw[list.key] = result
    ;(applied as Record<string, unknown>)[list.key] = result
  }
  for (const key of mutation.unsetKeys) {
    delete raw[key]
  }

  const body = `${JSON.stringify(raw, null, 2)}\n`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body, 'utf8')
  return applied
}

const INFO_DEFAULTS: Record<KnownKey, string> = {
  defaultMode: 'trash',
  depth: '(scan default: unlimited; menus use 3)',
  exclude: '(empty)',
  keep: '(empty)',
  color: '(auto)',
  animate: '(auto: TTY only)',
  updateCheck: 'off',
  logDir: '~/.nmh',
}

function renderInfo(source: string | null, values: Partial<NmhConfig>): string {
  const row = (key: string, value: string): string => `  ${colors.dim(key.padEnd(12, ' '))}${value}`
  const lines = [
    '',
    colors.bold('⚙  nmh config'),
    row('active file', source ?? 'none — defaults in effect (create one: nmh config set …)'),
  ]
  for (const key of KNOWN_KEYS) {
    const value = (values as Record<string, unknown>)[key]
    const shown =
      value === undefined ? INFO_DEFAULTS[key] : Array.isArray(value) ? `${value.length} item(s): ${value.join(', ')}` : String(value)
    lines.push(row(key, shown))
  }
  lines.push(
    '',
    colors.dim('manage: nmh config set · add · remove · unset (lists: --default-exclude / --default-keep)'),
    colors.dim('special value "self" in exclude/keep = protect the folder nmh runs from (scan-level guard)'),
  )
  return lines.join('\n')
}

/** `nmh config` family (v0.9): info · set · add · remove · unset — persisted .nmhrc, prompt-free. */
export async function runConfigCommand(request: ConfigCommandRequest): Promise<number> {
  try {
    if (request.op === 'info') {
      if (request.defaultExclude !== undefined || request.defaultKeep !== undefined) {
        throw new ConfigError('nmh config info is read-only — key flags belong to set/add/remove')
      }
      const loaded = await loadConfig(request.explicitFile ?? null, request.cwd)
      if (request.json === true) {
        // payload, not log — `--json` must survive `--quiet` (v0.9.2: the config family was muted)
        payload(
          JSON.stringify({
            nmh: 'node-modules-hunter',
            command: 'config',
            source: loaded.source,
            values: loaded.values,
          }),
        )
        return 0
      }
      log(renderInfo(loaded.source, loaded.values))
      return 0
    }

    const file = configWriteTarget(request.explicitFile, request.cwd)
    const mutation = assemble(request)
    const applied = await writeConfigMutation(file, mutation)

    if (request.json === true) {
      // payload, not log — `--json` must survive `--quiet` (v0.9.2: the config family was muted)
      payload(
        JSON.stringify({
          nmh: 'node-modules-hunter',
          command: 'config',
          op: request.op,
          file,
          applied,
          unset: mutation.unsetKeys,
        }),
      )
      return 0
    }

    const lines = [`${colors.green('✅')} ${request.op} — ${file}`]
    for (const [key, value] of Object.entries(applied)) {
      const label = `--${KEY_TO_FLAG[key as KnownKey]}`
      lines.push(
        Array.isArray(value)
          ? `  ${colors.dim(label.padEnd(18, ' '))}${value.length} item(s): ${value.join(', ')}`
          : `  ${colors.dim(label.padEnd(18, ' '))}${String(value)}`,
      )
    }
    for (const key of mutation.unsetKeys) {
      lines.push(`  ${colors.dim(`--${KEY_TO_FLAG[key]}`.padEnd(18, ' '))}(removed from file)`)
    }
    log(lines.join('\n'))
    return 0
  } catch (err) {
    if (err instanceof ConfigError) {
      errorLog(err.message)
      return 1
    }
    throw err
  }
}

/** The documented special value (PRD v0.9): "self" in exclude/keep protects the cwd subtree. */
export const SELF_TOKEN = 'self'

export function listHasSelf(items: string[] | undefined): boolean {
  return items?.includes(SELF_TOKEN) === true
}

/** True when an absolute entry path sits inside (or is exactly) the guarded root. */
export function insideRoot(entryPath: string, root: string): boolean {
  return entryPath === root || entryPath.startsWith(root + path.sep)
}
