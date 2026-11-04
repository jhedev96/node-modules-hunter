/**
 * i18n core (v1.3.0): one catalog, one lookup, zero hard-coded user-facing strings
 * in src/ outside src/i18n/. Keys are flat domain paths (`scan.warn.noMatch`),
 * interpolation uses `{placeholder}` — never concatenation, so word-order-heavy
 * locales (zh, ru, es) and CJK widths stay safe.
 *
 * Resolution chain (agreed design): --language CLI > .nmhrc (`nmh config set
 * --language`) > NMH_LANG > LANG/LC_ALL > 'en'. A missing key falls back to the
 * English catalog silently — never a crash, never a mixed-locale sentence.
 */

export type Locale = 'en' | 'id' | 'zh' | 'ru' | 'es'

export const LOCALES: Locale[] = ['en', 'id', 'zh', 'ru', 'es']
export const DEFAULT_LOCALE: Locale = 'en'

import en from './locales/en.ts'
import id from './locales/id.ts'
import zh from './locales/zh.ts'
import ru from './locales/ru.ts'
import es from './locales/es.ts'

const CATALOGS: Record<Locale, Record<string, string>> = { en, id, zh, ru, es }

export function isLocale(value: string): value is Locale {
  return (LOCALES as string[]).includes(value)
}

let current: Locale = DEFAULT_LOCALE

export function setLocale(locale: Locale): void {
  current = locale
}

export function getLocale(): Locale {
  return current
}

/** First valid locale in the chain; unknown values are skipped (never fatal). */
export function resolveLocale(...candidates: (string | undefined | null)[]): Locale {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && isLocale(candidate.trim().toLowerCase())) {
      return candidate.trim().toLowerCase() as Locale
    }
  }
  return DEFAULT_LOCALE
}

export type TranslateParams = Record<string, string | number>

/** `{name}` slots — unknown placeholders stay literal so bugs are visible, never silent. */
function interpolate(template: string, params: TranslateParams | undefined): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  )
}

/** Missing key → English catalog → the key itself (visible, honest, never a crash). */
export function t(key: string, params?: TranslateParams): string {
  const template = CATALOGS[current][key] ?? CATALOGS[DEFAULT_LOCALE][key] ?? key
  return interpolate(template, params)
}
