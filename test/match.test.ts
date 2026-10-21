import { describe, expect, it } from 'vitest'
import { globToRegExp, makeGlobMatcher, makeSearchMatcher } from '../src/utils/match.ts'

describe('globToRegExp', () => {
  it('anchors the whole string', () => {
    expect(globToRegExp('api').test('api')).toBe(true)
    expect(globToRegExp('api').test('api/v1')).toBe(false)
    expect(globToRegExp('api').test('myapi')).toBe(false)
  })

  it('* stays inside one segment', () => {
    const re = globToRegExp('node_modules/*.bin')
    expect(re.test('node_modules/.bin')).toBe(true)
    expect(re.test('node_modules/a/b/.bin')).toBe(false)
  })

  it('** crosses segments; **/ also matches zero segments', () => {
    const re = globToRegExp('**/e2e/**')
    expect(re.test('e2e/fixtures')).toBe(true)
    expect(re.test('a/b/e2e/c/d')).toBe(true)
    expect(re.test('a/b/e2e')).toBe(false)

    const all = globToRegExp('**')
    expect(all.test('a/b/c')).toBe(true)
    expect(all.test('x')).toBe(true)
  })

  it('? matches exactly one character', () => {
    expect(globToRegExp('a?c').test('abc')).toBe(true)
    expect(globToRegExp('a?c').test('a/c')).toBe(false)
    expect(globToRegExp('a?c').test('abbc')).toBe(false)
  })

  it('{a,b} alternates and regex specials are escaped', () => {
    expect(globToRegExp('{api,web}').test('api')).toBe(true)
    expect(globToRegExp('{api,web}').test('web')).toBe(true)
    expect(globToRegExp('{api,web}').test('mobile')).toBe(false)
    expect(globToRegExp('c++').test('c++')).toBe(true)
    expect(globToRegExp('c++').test('cXX')).toBe(false)
  })

  it('normalizes windows backslashes', () => {
    expect(globToRegExp('a\\b').test('a/b')).toBe(true)
  })
})

describe('makeGlobMatcher', () => {
  it('matches any of the given patterns (anchored; walker supplies basename candidates separately)', () => {
    const matcher = makeGlobMatcher(['api', '**/mobile/**'])
    expect(matcher('api')).toBe(true)
    expect(matcher('/x/api')).toBe(false) // bare names need the basename candidate from the walker
    expect(matcher('/x/mobile/node_modules')).toBe(true)
    expect(matcher('/x/web/node_modules')).toBe(false)
  })

  it('matches candidates with windows separators too', () => {
    const matcher = makeGlobMatcher(['**/mobile/**'])
    expect(matcher('C:\\proj\\mobile\\node_modules')).toBe(true)
  })

  it('caseInsensitive option relaxes matching for keep lists', () => {
    const matcher = makeGlobMatcher(['React-Native'], { caseInsensitive: true })
    expect(matcher('react-native')).toBe(true)
  })
})

describe('makeSearchMatcher', () => {
  it('/re/ form becomes a regex with flags', () => {
    const matcher = makeSearchMatcher('/^re/')
    expect(matcher('react')).toBe(true)
    expect(matcher('vreact')).toBe(false)
  })

  it('glob form matches whole names', () => {
    const matcher = makeSearchMatcher('re*ct')
    expect(matcher('react')).toBe(true)
    expect(matcher('react-dom')).toBe(false)
  })

  it('plain text is a case-insensitive substring match', () => {
    const matcher = makeSearchMatcher('lod')
    expect(matcher('lodash')).toBe(true)
    expect(matcher('Lodash.merge')).toBe(true)
    expect(matcher('vue')).toBe(false)
  })
})
