import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { checkDeleteTarget } from '../src/core/guards.ts'
import { tmpRoot } from './helpers.ts'

describe('checkDeleteTarget (PRD §6 hard guards)', () => {
  it('blocks the filesystem root', async () => {
    const verdict = await checkDeleteTarget('/')
    expect(verdict.safe).toBe(false)
    expect(verdict.code).toBe('name') // basename '/' isn't node_modules — still refused
  })

  it('blocks $HOME itself', async () => {
    const verdict = await checkDeleteTarget(os.homedir())
    expect(verdict.safe).toBe(false)
  })

  it('blocks paths not named node_modules', async () => {
    const dir = await tmpRoot('guard-name')
    try {
      const verdict = await checkDeleteTarget(dir)
      expect(verdict.safe).toBe(false)
      expect(verdict.code).toBe('name')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('blocks a self-symlink loop (ELOOP resolves unresolvable)', async () => {
    const dir = await tmpRoot('guard-loop')
    try {
      const looped = path.join(dir, 'node_modules')
      await fs.symlink('node_modules', looped)
      const verdict = await checkDeleteTarget(looped)
      expect(verdict.safe).toBe(false)
      expect(verdict.code).toBe('symlink-loop')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('allows a real node_modules folder', async () => {
    const dir = await tmpRoot('guard-ok')
    try {
      const target = path.join(dir, 'node_modules')
      await fs.mkdir(target)
      const verdict = await checkDeleteTarget(target)
      expect(verdict.safe).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('flags a missing target as not-found (not a crash)', async () => {
    const verdict = await checkDeleteTarget(path.join(await tmpRoot('guard-missing'), 'node_modules'))
    expect(verdict.code).toBe('not-found')
    expect(verdict.safe).toBe(false)
  })
})
