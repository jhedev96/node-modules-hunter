import { describe, expect, it } from 'vitest'
import { stripJsonC } from '../src/core/lockfile.ts'

describe('stripJsonC — quote awareness (v0.9.4 hardening)', () => {
  it('drops plain and multiline trailing commas', () => {
    expect(stripJsonC('{"a":1,}')).toBe('{"a":1}')
    expect(stripJsonC('{"a":[1,2,],}')).toBe('{"a":[1,2]}')
    expect(stripJsonC('[\n  1,\n  2,\n]')).toBe('[\n  1,\n  2\n]')
    const parsed = JSON.parse(stripJsonC('{"a":[1,2,],}')) as { a: number[] }
    expect(parsed.a).toEqual([1, 2])
  })

  it('never eats a scope-closing comma inside a string literal (the v0.9.2 audit found silent corruption here)', () => {
    const input = '{"desc":"cool, ]right","n":2,}'
    const out = stripJsonC(input)
    const parsed = JSON.parse(out) as { desc: string; n: number }
    expect(parsed.desc).toBe('cool, ]right')
    expect(parsed.n).toBe(2)
  })

  it('keeps ", }" inside strings for arrays too', () => {
    const parsed = JSON.parse(stripJsonC('{"a":["x, }y"],"i":1}')) as { a: string[] }
    expect(parsed.a[0]).toBe('x, }y')
  })

  it('keeps escape sequences intact while scanning the string', () => {
    const parsed = JSON.parse(stripJsonC('{"i":"a\\"x, ]","j":1,}')) as { i: string; j: number }
    expect(parsed.i).toBe('a"x, ]')
    expect(parsed.j).toBe(1)
  })

  it('still strips comments and preserves "http://" URLs inside strings', () => {
    const input = '{\n  // note\n  "u": "http://registry.example/one", /* block */ "v": 2,\n}'
    const parsed = JSON.parse(stripJsonC(input)) as { u: string; v: number }
    expect(parsed.u).toBe('http://registry.example/one')
    expect(parsed.v).toBe(2)
  })
})
