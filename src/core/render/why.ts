import { colors } from '../../utils/logger.ts'
import { t } from '../../i18n/index.ts'
import { formatBytes } from '../../utils/format.ts'
import { toolVersion } from '../../utils/version.ts'
import { shortenPath } from './shared.ts'
import type { DepsAudit, WhyOutcome } from '../result.ts'

export function renderWhyReport(outcome: WhyOutcome, options: { cwd: string; expand?: boolean }): string {
  const lines: string[] = []
  lines.push(colors.cyan(t('render.why.title', { pkg: outcome.pkg, count: outcome.instances.length })))
  for (const instance of outcome.instances) {
    lines.push('')
    const version = instance.version !== null ? `@${instance.version}` : ''
    const linked = instance.symlinked
    const size = linked ? colors.dim(t('render.why.linked')) : formatBytes(instance.size ?? 0)
    lines.push(`${colors.bold(instance.displayPath)} · ${colors.bold(outcome.pkg + version)} · ${size}${instance.pm !== 'unknown' ? colors.dim(` · ${instance.pm}`) : ''}`)
    if (instance.declaredBy !== null) {
      lines.push(t('render.why.declares', { project: instance.declaredBy.projectName ?? t('render.why.noName'), range: colors.yellow(instance.declaredBy.range), field: instance.declaredBy.field }))
    } else {
      lines.push(colors.dim(t('render.why.transitive')))
    }
    if (instance.requiredBy.length > 0) {
      const gradeTag = instance.requiredByGrade === 'lockfile' ? colors.dim(` ${t('render.stats.lockfileGrade')}`) : ''
      lines.push(t('render.why.requiredBy', { count: instance.requiredBy.length }) + gradeTag)
      for (const req of instance.requiredBy.slice(0, 10)) {
        const reqVersion = req.version !== null ? `@${req.version}` : ''
        lines.push(`    · ${req.name}${reqVersion} → ${req.range} (${req.field})`)
      }
      if (instance.requiredBy.length > 10) {
        lines.push(colors.dim(t('render.why.moreRequirers', { n: instance.requiredBy.length - 10 })))
      }
    } else if (instance.requiredByGrade === 'lockfile') {
      lines.push(colors.dim(t('render.why.rootOnly')))
    } else {
      lines.push(colors.dim(t('render.why.orphan')))
    }
  }
  if (outcome.permissionIssues.length > 0) {
    lines.push(colors.yellow(t('render.warn.permission', { n: outcome.permissionIssues.length })))
  }
  return lines.join('\n')
}

export function renderWhyJson(outcome: WhyOutcome, _request: { cwd: string }): string {
  return JSON.stringify(
    {
      nmh: toolVersion(),
      command: 'why',
      pkg: outcome.pkg,
      found: outcome.instances.length,
      instances: outcome.instances,
      permissionIssues: outcome.permissionIssues,
    },
    null,
    2,
  )
}

export function renderDepsAudit(audit: DepsAudit, focus: 'phantom' | 'dead' | 'both'): string {
  const lines: string[] = []
  lines.push(`━━━ ${colors.bold(t('render.section.audit'))} ━━━`)
  lines.push(colors.dim(t('render.audit.disclaimer', { count: audit.scannedFiles })))
  const showPhantom = focus === 'phantom' || focus === 'both'
  const showDead = focus === 'dead' || focus === 'both'
  if (showPhantom && audit.phantom.length === 0 && showDead && audit.dead.length === 0) {
    lines.push(colors.green(t('render.audit.clean')))
  }
  if (showPhantom && audit.phantom.length > 0) {
    lines.push(t('render.audit.phantom', { count: audit.phantom.length }))
    for (const hit of audit.phantom) {
      const sites = hit.sites.length > 0 ? colors.dim(` — ${hit.sites.join(', ')}`) : ''
      lines.push(`  · ${colors.bold(hit.name)}${sites}`)
    }
  }
  if (showDead && audit.dead.length > 0) {
    lines.push(t('render.audit.dead', { count: audit.dead.length }))
    for (const hit of audit.dead) {
      lines.push(`  · ${colors.bold(hit.name)} — ${hit.declaringProjects.join(', ')}`)
    }
  }
  return lines.join('\n')
}
