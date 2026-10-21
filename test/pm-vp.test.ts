import path from 'node:path'
import fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createPmDetector } from '../src/core/pm-detect.ts'
import { tmpRoot, vpFixture } from './helpers.ts'

describe('vp wrapper detection (v0.2 tag)', () => {
  it('tags [vp] when the manifest declares vite-plus, keeping the underlying family', async () => {
    const fx = await vpFixture('vp-dep')
    try {
      const info = await createPmDetector()(fx.entry)
      expect(info.family).toBe('pnpm')
      expect(info.vp).toBe(true)
      expect(info.sources).toContain('vite-plus dependency')
      expect(info.sources).toContain('pnpm-lock.yaml')
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('no vite-plus dep → vp stays false', async () => {
    const fx = await vpFixture('vp-nope')
    await fs.writeFile(path.join(fx.root, 'app', 'package.json'), '{"name":"app","dependencies":{"vite":"^5.0.0"}}')
    try {
      const info = await createPmDetector()(fx.entry)
      expect(info.family).toBe('pnpm')
      expect(info.vp).toBe(false)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('peerDependencies declaration also counts', async () => {
    const fx = await vpFixture('vp-peer')
    await fs.writeFile(
      path.join(fx.root, 'app', 'package.json'),
      '{"name":"app","peerDependencies":{"@voidzero-dev/vite-plus-core":"*"}}',
    )
    try {
      const info = await createPmDetector()(fx.entry)
      expect(info.vp).toBe(true)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })
})
