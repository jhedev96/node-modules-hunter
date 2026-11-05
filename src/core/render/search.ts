import { colors } from '../../utils/logger.ts'
import { t } from '../../i18n/index.ts'
import { formatBytes } from '../../utils/format.ts'
import { pmLabel, shortenPath } from './shared.ts'
import { toolVersion } from '../../utils/version.ts'
import type { PMInfo, SearchOutcome } from '../result.ts'

export interface RenderSearchOptions {
  cwd: string
  expand?: boolean
}

export function renderSearchResults(outcome: SearchOutcome, options: RenderSearchOptions): string {
  const totalMatches = outcome.results.reduce((sum, result) => sum + result.matches.length, 0)
  const lines = [
    colors.cyan(
      t('render.search.header', { pattern: outcome.pattern, count: totalMatches, dirs: outcome.results.length }),
    ),
  ]

  for (const result of outcome.results) {
    const display = options.expand === true ? result.entry.path : result.entry.displayPath
    const badge = result.entry.nested ? colors.dim(' [nested]') : ''
    lines.push('')
    lines.push(
      `${colors.bold(display)}${badge} ${colors.dim(`· ${pmLabel(result.entry.pm)} · ${formatBytes(result.entry.size)}`)}`,
    )
    if (result.matches.length === 0) {
      lines.push(t('render.search.pathMatch'))
      continue
    }
    for (const pkg of result.matches) {
      const version = pkg.version ? colors.dim(`@${pkg.version}`) : ''
      const link = pkg.symlinked ? colors.dim(' (link)') : ''
      lines.push(`   ${colors.cyan('•')} ${pkg.name}${version}${link} ${colors.dim(formatBytes(pkg.size))}`)
    }
  }

  if (outcome.permissionIssues.length > 0) {
    lines.push(
      colors.yellow(
        `⚠ ${outcome.permissionIssues.length} directory(ies) unreadable (permission denied) — exit code 4`,
      ),
    )
  }
  return lines.join('\n')
}

export function renderSearchJson(outcome: SearchOutcome, options: RenderSearchOptions): string {
  const payload = {
    nmh: toolVersion(),
    command: 'search',
    pattern: outcome.pattern,
    totals: {
      matchedEntries: outcome.results.length,
      matches: outcome.results.reduce((sum, result) => sum + result.matches.length, 0),
      matchedSize: outcome.results.reduce(
        (sum, result) => sum + result.matches.reduce((inner, pkg) => inner + pkg.size, 0),
        0,
      ),
    },
    permissionIssues: outcome.permissionIssues,
    results: outcome.results.map((result) => ({
      path: result.entry.path,
      displayPath: options.expand === true ? result.entry.path : result.entry.displayPath,
      pm: result.entry.pm.family,
      pmVp: result.entry.pm.vp,
      nested: result.entry.nested === true,
      ownerPath: result.entry.ownerPath ?? result.entry.path,
      entrySize: result.entry.size,
      pathMatch: result.pathMatch,
      matches: result.matches.map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        size: pkg.size,
        sizeFormatted: formatBytes(pkg.size),
        path: pkg.path,
        symlinked: pkg.symlinked,
      })),
    })),
  }
  return JSON.stringify(payload, null, 2)
}
