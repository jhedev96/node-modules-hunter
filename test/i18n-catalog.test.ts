import { describe, expect, it } from 'vitest'
import { t, setLocale, getLocale, resolveLocale, LOCALES } from '../src/i18n/index.ts'
import en from '../src/i18n/locales/en.ts'
import id from '../src/i18n/locales/id.ts'
import zh from '../src/i18n/locales/zh.ts'
import ru from '../src/i18n/locales/ru.ts'
import es from '../src/i18n/locales/es.ts'

const CATALOGS: Record<string, Record<string, string>> = { en, id, zh, ru, es }
const placeholders = (value: string): string[] => (value.match(/\{\w+\}/g) ?? []).sort()

describe('i18n catalog completeness gate (v1.3.0) — 1:1 per locale vs en', () => {
  it('every locale carries the exact key set of en', () => {
    const enKeys = Object.keys(en).sort()
    expect(enKeys.length).toBeGreaterThan(400)
    for (const locale of LOCALES) {
      expect(Object.keys(CATALOGS[locale]).sort(), `locale ${locale}`).toEqual(enKeys)
    }
  })

  it('no locale value is empty or whitespace-only', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(CATALOGS[locale])) {
        expect(value.trim().length, `${locale}:${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('placeholder slots match en for every key and locale (interpolation safety)', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(en)) {
        expect(placeholders(CATALOGS[locale][key]), `${locale}:${key}`).toEqual(placeholders(value))
      }
    }
  })
})

describe('t() interpolation & fallback', () => {
  it('interpolates {placeholders} in the active locale', () => {
    setLocale('es')
    expect(t('format.ago', { n: '5m' })).toBe('hace 5m')
    expect(t('delete.spin.progress', { done: 1, total: 3 })).toBe('🗑  1/3 carpetas…')
  })

  it('unknown placeholders stay literal (visible, never silently swallowed)', () => {
    setLocale('en')
    expect(t('banner.updateLine')).toContain('{version}')
  })

  it('missing keys fall back visibly to the key itself — never a crash', () => {
    expect(t('no.such.key')).toBe('no.such.key')
  })

  it('locale state switches and restores', () => {
    setLocale('id')
    expect(getLocale()).toBe('id')
    expect(t('banner.compact')).toBe('scan read-only')
    setLocale('en')
    expect(getLocale()).toBe('en')
    expect(t('banner.compact')).toBe('read-only scan')
  })
})

describe('resolveLocale chain — CLI flag > rc > NMH_LANG > LC_ALL/LANG > en', () => {
  it('first valid candidate wins', () => {
    expect(resolveLocale('es', 'id', 'en')).toBe('es')
  })

  it('invalid candidates are skipped silently', () => {
    expect(resolveLocale('klingon', ' fr ', 'id')).toBe('id')
  })

  it('values are trimmed and case-folded', () => {
    expect(resolveLocale('  ES ')).toBe('es')
  })

  it('no valid candidate anywhere → en (default & fallback)', () => {
    expect(resolveLocale(undefined, null, '', 'xx')).toBe('en')
  })
})
