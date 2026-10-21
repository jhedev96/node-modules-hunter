import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createPmDetector } from '../src/core/pm-detect.ts'
import { monorepoFixture } from './helpers.ts'

describe('createPmDetector (mirrors vp priority)', () => {
  it('detects all four families from lockfiles', async () => {
    const fx = await monorepoFixture('pm')
    try {
      const detect = createPmDetector()

      const web = await detect(fx.paths.webEntry)
      expect(web.family).toBe('pnpm')
      expect(web.sources).toEqual(['pnpm-lock.yaml'])
      expect(web.projectRoot).toBe(fx.paths.web)

      expect((await detect(fx.paths.apiEntry)).family).toBe('npm')
      expect((await detect(fx.paths.mobileEntry)).family).toBe('yarn')
      expect((await detect(fx.paths.bunEntry)).family).toBe('bun')
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('walks up from a nested package to the closest ancestor lockfile', async () => {
    const fx = await monorepoFixture('pm-up')
    try {
      // nested folder's ancestor chain reaches web/pnpm-lock.yaml
      const detect = createPmDetector()
      const nested = await detect(path.join(fx.paths.webEntry, 'react', 'nested', 'node_modules'))
      expect(nested.family).toBe('pnpm')
      expect(nested.projectRoot).toBe(fx.paths.web)
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true })
    }
  })

  it('packageManager field wins over lockfiles; devEngines is next; nothing → unknown', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nmh-pmfield-'))
    try {
      await fs.mkdir(path.join(root, 'field'), { recursive: true })
      await fs.writeFile(
        path.join(root, 'field', 'package.json'),
        '{"packageManager":"pnpm@10.4.1+sha512.abc"}',
      )
      await fs.writeFile(path.join(root, 'field', 'package-lock.json'), '{}') // conflict on purpose
      const detector = createPmDetector()
      const field = await detector(path.join(root, 'field', 'node_modules'))
      expect(field.family).toBe('pnpm')
      expect(field.sources).toEqual(['packageManager'])

      await fs.mkdir(path.join(root, 'devengines'), { recursive: true })
      await fs.writeFile(
        path.join(root, 'devengines', 'package.json'),
        '{"devEngines":{"packageManager":[{"name":"bun"}]}}',
      )
      const engines = await detector(path.join(root, 'devengines', 'node_modules'))
      expect(engines.family).toBe('bun')
      expect(engines.sources).toEqual(['devEngines.packageManager'])

      await fs.mkdir(path.join(root, 'bare', 'node_modules'), { recursive: true })
      expect((await detector(path.join(root, 'bare', 'node_modules'))).family).toBe('unknown')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('tags [multiple] when several families live at the same level', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nmh-multi-'))
    try {
      await fs.writeFile(path.join(dir, 'yarn.lock'), '# yarn lockfile')
      await fs.writeFile(path.join(dir, 'package-lock.json'), '{}')
      await fs.writeFile(path.join(dir, 'package.json'), '{"name":"multi"}')
      const detector = createPmDetector()
      const verdict = await detector(path.join(dir, 'node_modules'))
      expect(verdict.family).toBe('yarn') // priority: yarn lockfile before package-lock
      expect(verdict.multiple).toBe(true)
      expect(verdict.sources).toEqual(['yarn.lock', 'package-lock.json'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
