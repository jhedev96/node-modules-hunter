import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { runCli, tmpRoot } from './helpers.ts'

describe('i18n e2e (v1.3.0) — --language flag, .nmhrc, NMH_LANG', () => {
  it('--language es localizes help', async () => {
    const run = await runCli(['--language', 'es', 'help'])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('Comandos')
    expect(run.stdout).toContain('Uso')
    expect(run.stdout).toContain('Ejemplos')
    expect(run.stdout).toContain('Códigos de salida')
    expect(run.stdout).not.toContain('Commands')
  })

  it('--language id localizes help', async () => {
    const run = await runCli(['--language', 'id', 'help'])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('Pemakaian')
    expect(run.stdout).toContain('Perintah')
    expect(run.stdout).toContain('Contoh')
  })

  it('--language zh localizes help (CJK, not English)', async () => {
    const run = await runCli(['--language', 'zh', 'help'])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('用法')
    expect(run.stdout).toContain('命令')
    expect(run.stdout).toContain('示例')
    expect(run.stdout).toContain('--language <lang>')
    expect(run.stdout).not.toContain('Commands')
  })

  it('--language ru localizes help (Cyrillic, not English)', async () => {
    const run = await runCli(['--language', 'ru', 'help'])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('Использование')
    expect(run.stdout).toContain('Команды')
    expect(run.stdout).toContain('Примеры')
    expect(run.stdout).toContain('--language <lang>')
    expect(run.stdout).not.toContain('Commands')
  })

  it('help documents the --language flag in every locale', async () => {
    for (const locale of ['en', 'id', 'zh', 'ru', 'es']) {
      const run = await runCli(['--language', locale, 'help'])
      expect(run.code, `locale ${locale}`).toBe(0)
      expect(run.stdout, `locale ${locale}`).toContain('--language <lang>')
    }
  })

  it('every locale renders `version` exit 0 without raw catalog keys leaking', async () => {
    for (const locale of ['en', 'id', 'zh', 'ru', 'es']) {
      const run = await runCli(['--language', locale, 'version'])
      expect(run.code, `locale ${locale}`).toBe(0)
      expect(run.stdout, `locale ${locale}`).not.toMatch(/\b(banner|render|help|cli|config)\.\w+/)
      expect(run.stdout, `locale ${locale}`).not.toContain('undefined')
    }
  })

  it('invalid --language is refused loudly (exit 1, localized error)', async () => {
    const run = await runCli(['--language', 'xx', 'help'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('invalid --language: xx')
  })

  it('NMH_LANG env localizes a real scan path (empty dir → exit 2)', async () => {
    const dir = await tmpRoot('i18n-env')
    const run = await runCli(['scan', '--size', 'total'], {
      cwd: dir,
      envExtra: { NMH_LANG: 'es', LANG: '', LC_ALL: '' },
    })
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('nada que cazar aquí')
  })

  it('NMH_LANG zh and ru localize the scan path too', async () => {
    for (const [locale, localized] of [['zh', '这里没有可猎的'], ['ru', 'не на что охотиться']] as const) {
      const dir = await tmpRoot(`i18n-env-${locale}`)
      const run = await runCli(['scan', '--size', 'total'], {
        cwd: dir,
        envExtra: { NMH_LANG: locale, LANG: '', LC_ALL: '' },
      })
      expect(run.code, `locale ${locale}`).toBe(2)
      expect(run.stderr, `locale ${locale}`).toContain(localized)
    }
  })

  it('.nmhrc `language` localizes — and sits above NMH_LANG', async () => {
    const dir = await tmpRoot('i18n-rc')
    await fs.writeFile(path.join(dir, '.nmhrc'), JSON.stringify({ language: 'id' }), 'utf8')
    const run = await runCli(['scan', '--size', 'total'], {
      cwd: dir,
      envExtra: { NMH_LANG: 'es', LANG: '', LC_ALL: '' },
    })
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('tidak ada yang bisa diburu')
  })

  it('--language beats both .nmhrc and NMH_LANG', async () => {
    const dir = await tmpRoot('i18n-flag')
    await fs.writeFile(path.join(dir, '.nmhrc'), JSON.stringify({ language: 'id' }), 'utf8')
    const run = await runCli(['--language', 'es', 'scan', '--size', 'total'], {
      cwd: dir,
      envExtra: { NMH_LANG: 'ru', LANG: '', LC_ALL: '' },
    })
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('nada que cazar aquí')
    expect(run.stderr).not.toContain('tidak ada yang bisa diburu')
  })

  it('unknown NMH_LANG falls back to en silently (never fatal)', async () => {
    const dir = await tmpRoot('i18n-fallback')
    const run = await runCli(['scan', '--size', 'total'], {
      cwd: dir,
      envExtra: { NMH_LANG: 'klingon', LANG: '', LC_ALL: '' },
    })
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('nothing to hunt here')
    expect(run.stderr).not.toContain('tidak ada')
  })
})
