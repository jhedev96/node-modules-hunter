import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, tmpRoot } from './helpers.ts'
import { squarify, buildTreemapLayout, renderTreemapHtml } from '../src/core/treemap.ts'
import type { TreemapData } from '../src/core/treemap.ts'

describe('squarify math (unit)', () => {
  it('cells tile the box exactly, proportional to weights, with sane aspect ratios', () => {
    const rects = squarify(
      [
        { label: 'a', weight: 50 },
        { label: 'b', weight: 30 },
        { label: 'c', weight: 15 },
        { label: 'd', weight: 5 },
      ],
      0,
      0,
      100,
      100,
    )
    const total = 100 * 100
    for (const rect of rects) {
      expect(rect.w).toBeGreaterThan(0)
      expect(rect.h).toBeGreaterThan(0)
    }
    expect(Math.round(rects[0].w * rects[0].h)).toBeGreaterThanOrEqual(4900)
    expect(rects[0]).toMatchObject({ label: 'a', x: 0, y: 0 })
    expect(Math.round(rects.find((r) => r.label === 'd')!.w * rects.find((r) => r.label === 'd')!.h)).toBeGreaterThanOrEqual(450)
    // everything must lie inside the 100×100 box
    for (const rect of rects) {
      expect(rect.x + rect.w).toBeLessThanOrEqual(100.001)
      expect(rect.y + rect.h).toBeLessThanOrEqual(100.001)
    }
  })

  it('extreme mismatch (heavy + tiny) still places the tiny package as a sliver', () => {
    const rects = squarify(
      [
        { label: 'heavy', weight: 921638 },
        { label: 'tiny', weight: 35 },
      ],
      0,
      0,
      1248,
      688,
    )
    expect(rects.map((r) => r.label)).toEqual(['heavy', 'tiny'])
    const tiny = rects[1]
    expect(tiny.w + tiny.h).toBeGreaterThan(0)
  })

  it('equal weights keep a deterministic order', () => {
    const rects = squarify(
      [
        { label: 'one', weight: 1 },
        { label: 'two', weight: 1 },
        { label: 'three', weight: 1 },
      ],
      0,
      0,
      30,
      30,
    )
    expect(rects.map((r) => r.label)).toEqual(['one', 'three', 'two'])
  })
})

function dataOf(overrides: Partial<TreemapData> = {}): TreemapData {
  return {
    generatedAt: '2026T',
    cwd: '/x',
    totalSize: 600,
    entries: [
      {
        label: 'web',
        displayPath: './web/node_modules',
        pm: 'npm',
        size: 500,
        packages: [
          { name: 'lodash', version: '4.17.21', size: 300, symlinked: false },
          { name: 'chalk', version: '5.0.0', size: 200, symlinked: false },
        ],
      },
      {
        label: 'api',
        displayPath: './api/node_modules',
        pm: 'pnpm',
        size: 100,
        packages: [{ name: 'express', version: '4.0.0', size: null, symlinked: true }],
      },
    ],
    ...overrides,
  }
}

describe('treemap html (unit)', () => {
  it('layout keeps 5:1 between entries and marks the symlink sliver', () => {
    const layout = buildTreemapLayout(dataOf())
    const web = layout.entryRects.find((rect) => rect.label === 'web')!
    const api = layout.entryRects.find((rect) => rect.label === 'api')!
    expect((web.w * web.h) / (api.w * api.h)).toBeCloseTo(5, 1)
    const express = layout.pkgRects.find((rect) => rect.label.includes('express'))!
    expect(express.symlinked).toBe(true)
  })

  it('single self-contained file: tooltips present, no external sources, sizes humanized', () => {
    const html = renderTreemapHtml(dataOf())
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).not.toContain('src=')
    expect(html).not.toContain('href=')
    expect(html).toContain('data-tip="')
    expect(html).toContain('./web/node_modules/lodash@4.17.21 — 300')
    expect(html).toContain('(symlink)')
  })
})

describe('treemap e2e (nmh treemap)', () => {
  async function fixture(label: string): Promise<string> {
    const root = await tmpRoot(label)
    const web = path.join(root, 'web')
    const pkgDir = path.join(web, 'node_modules', 'lodash')
    await fs.mkdir(pkgDir, { recursive: true })
    await fs.writeFile(path.join(pkgDir, 'blob.bin'), Buffer.alloc(2048))
    await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'lodash', version: '4.17.21' }))
    await fs.writeFile(path.join(web, 'package.json'), JSON.stringify({ name: 'web', version: '1.0.0', dependencies: { lodash: '^4' } }))
    return root
  }

  it('writes the default single-file HTML and exit codes stay honest', async () => {
    const root = await fixture('tree-default')
    try {
      const run = await runCli(['treemap', '.'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('treemap')
      const file = path.join(root, 'nmh-treemap.html')
      const html = await fs.readFile(file, 'utf8')
      expect(html).toContain('lodash@4.17.21')
      expect(html).toContain('data-tip=')
      expect(html).not.toContain('src=')
      // deterministic layout across runs (only the generated timestamp differs)
      const again = await runCli(['treemap', '.'], { cwd: root, home: root })
      const html2 = await fs.readFile(file, 'utf8')
      const strip = (text: string): string => text.replace(/generated [^<]*/g, '')
      expect(strip(html)).toBe(strip(html2))
      expect(again.code).toBe(0)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('--out writes where asked; --json prints the raw data instead', async () => {
    const root = await fixture('tree-out')
    try {
      const run = await runCli(['treemap', '.', '--out', 'viz.html'], { cwd: root, home: root })
      expect(run.code).toBe(0)
      await expect(fs.access(path.join(root, 'viz.html'))).resolves.toBeUndefined()

      const jsonRun = await runCli(['treemap', '.', '--json'], { cwd: root, home: root })
      expect(jsonRun.code).toBe(0)
      const payload = JSON.parse(jsonRun.stdout) as { entries: Array<{ label: string; size: number; packages: Array<{ name: string; symlinked: boolean }> }> }
      expect(payload.entries).toHaveLength(1)
      expect(payload.entries[0].packages.map((pkg) => pkg.name)).toEqual(['lodash'])
      // file must NOT be written in json mode
      await expect(fs.access(path.join(root, 'nmh-treemap.html'))).rejects.toThrow()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('empty target exits 2 without writing a file', async () => {
    const root = await tmpRoot('tree-empty')
    try {
      const run = await runCli(['treemap', '.'], { cwd: root, home: root })
      expect(run.code).toBe(2)
      expect(run.stderr).toContain('no node_modules')
      await expect(fs.access(path.join(root, 'nmh-treemap.html'))).rejects.toThrow()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('guards: combine with delete/clean → exit 1; --out outside treemap → exit 1', async () => {
    const root = await fixture('tree-guard')
    try {
      const withDelete = await runCli(['treemap', '.', '--delete'], { cwd: root, home: root })
      expect(withDelete.code).toBe(1)
      expect(withDelete.stderr).toContain('--treemap')
      const strayOut = await runCli(['stats', '.', '--out', 'x.html'], { cwd: root, home: root })
      expect(strayOut.code).toBe(1)
      expect(strayOut.stderr).toContain('--out')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
