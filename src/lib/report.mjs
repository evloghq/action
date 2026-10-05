/**
 * The report as Markdown: the pull request comment, and with per-entry-point
 * tables the job summary.
 *
 * The comment opens on the one number, then says what moved in a GitHub
 * alert block when something did, so the colour comes from GitHub and not
 * from an emoji. The numbers come straight from the CLI's JSON; the only
 * judgment made here is which entry points to list first.
 */
import { createHash } from 'node:crypto'

const DOCS = 'https://evlog.dev'

/* Column order of the per-entry-point table, the CLI's. */
const CHECKS = ['wide-event', 'context', 'audit', 'structured-errors', 'error-handling', 'page-error-handling', 'error-catalog', 'audit-coverage', 'ai-logging', 'auth-identity']

export function grade(score) {
  if (score >= 90) return 'excellent'
  if (score >= 75) return 'good'
  if (score >= 50) return 'needs work'
  return 'poor'
}

const signed = n => (n > 0 ? `+${n}` : String(n))
const code = text => `\`${text}\``
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Markdown bold and code stripped, for a check run title. */
export const plain = text => text.replace(/\*\*|`/g, '')

function failedChecks(route) {
  return Object.entries(route.checks).filter(([, check]) => check.status === 'fail').map(([id]) => id)
}

/** Worst first, sensitive entry points ahead of the rest: the report's FIX FIRST order. */
export function prioritize(routes) {
  return routes
    .filter(route => failedChecks(route).length > 0)
    .sort((a, b) => {
      const sensitiveA = a.sensitivity.level !== 'none' ? 1 : 0
      const sensitiveB = b.sensitivity.level !== 'none' ? 1 : 0
      if (sensitiveA !== sensitiveB) return sensitiveB - sensitiveA
      return a.score - b.score
    })
}

const routeLabel = route => `${route.method ?? 'ALL'} ${route.path}`

/** A scan path from the repository root: the package directory first, when there is one. */
export function filePath(result, file) {
  return result.path === '.' ? file : `${result.path}/${file}`
}

/**
 * A link to the line. On a pull request a regression links into the diff,
 * where the author already is; everything else links to the file at the
 * scanned commit.
 */
function fileLink(result, route, context, { diff = false } = {}) {
  const path = filePath(result, route.file)
  const line = route.handler?.line
  const text = line ? `${path}:${line}` : path
  const { serverUrl, repository, sha, pullRequest } = context
  if (!serverUrl || !repository) return code(text)
  if (diff && pullRequest) {
    const anchor = `diff-${createHash('sha256').update(path).digest('hex')}${line ? `R${line}` : ''}`
    return `[${code(text)}](${serverUrl}/${repository}/pull/${pullRequest.number}/files#${anchor})`
  }
  if (!sha) return code(text)
  return `[${code(text)}](${serverUrl}/${repository}/blob/${sha}/${path}${line ? `#L${line}` : ''})`
}

function gateCell(result, gate) {
  if (result.status === 'passed') return 'passed'
  const verb = gate ? 'failed' : 'would fail'
  return result.reasons.length === 0 ? verb : `${verb} (${result.reasons.join(', ')})`
}

export const lowest = results => Math.min(...results.map(result => result.score))

/** The title: what is measured, and the number. */
export function headline(results) {
  return `### Observability score · ${lowest(results)}`
}

/**
 * The one line to read after the number: how it grades, how it moved, what
 * failed. `baselineRef` names what the delta is against (`main`); without it
 * the movement is left out rather than attributed to nothing.
 */
export function verdict(results, { baselineRef } = {}) {
  const parts = [grade(lowest(results))]
  if (results.length > 1) parts[0] += ` across ${results.length} packages`
  const withBaseline = results.filter(result => result.baseline)
  if (withBaseline.length > 0) {
    const delta = Math.min(...withBaseline.map(result => result.baseline.delta))
    const against = baselineRef ? ` against ${code(baselineRef)}` : ''
    parts.push(delta === 0 ? `unchanged${against}` : `${signed(delta)}${against}`)
    const regressions = withBaseline.reduce((sum, result) => sum + result.baseline.regressions.length, 0)
    parts.push(regressions === 0 ? 'no regression' : plural(regressions, 'regression'))
  }
  const below = results.flatMap(result => result.reasons).find(reason => reason.startsWith('below'))
  if (below) parts.push(below.replace('--min-score', 'min-score'))
  return parts.join(' · ')
}

/** The per-package line of the job log and the fallback annotations. */
export function packageLine(result, { baselineRef } = {}) {
  const { summary } = result
  const reasons = result.reasons.map(reason => reason === 'regressed' ? `regressed against ${baselineRef ?? 'the baseline'}` : reason)
  return `score ${result.score}/100 (${grade(result.score)}): ${summary.instrumented} instrumented, ${summary.partial} partial, ${summary.dark} dark${reasons.length > 0 ? `; ${reasons.join('; ')}` : ''}`
}

function regressionLines(results, context) {
  return results.flatMap(result => (result.baseline?.regressions ?? []).map((regression) => {
    const route = result.routes.find(route => route.id === regression.routeId)
    const label = code(`${regression.method ?? 'ALL'} ${regression.path}`)
    const verb = regression.to === 'suppressed' ? 'silenced' : 'lost'
    const before = result.baselineRoutes?.[regression.routeId]
    const movement = route && before !== undefined && before !== route.score ? ` (${before} → ${route.score})` : ''
    const where = route ? fileLink(result, route, context, { diff: true }) : code(filePath(result, regression.file))
    return `- ${label} ${verb} ${code(regression.check)}${movement} · ${where}`
  }))
}

function fixedLines(results) {
  return results.flatMap(result => (result.baseline?.fixed ?? []).map(fix => `- ${code(`${fix.method ?? 'ALL'} ${fix.path}`)}: ${code(fix.check)} back`))
}

const quote = lines => lines.map(line => `> ${line}`)

/**
 * @param results one entry per package, from `main.mjs`; `name` is how the
 * package is shown, `path` where it sits in the repository, for links;
 * `baselineRoutes` maps entry point ids to their score at the base
 * @param context repository, sha, pull request and server for links;
 * cliVersion for the footer; baselineRef for the verdict; minScore and gate
 * for what the gate did
 */
export function renderReport(results, context) {
  const { gate = true, minScore } = context
  const lines = [headline(results), '']
  const line = verdict(results, context)
  const failed = results.some(result => result.status === 'failed')
  const regressions = regressionLines(results, context)
  const fixed = fixedLines(results)

  if (failed) {
    lines.push(...quote(['[!CAUTION]', `**${line}**${gate ? '' : ' · `gate: false`, the step stays green'}`, ...regressions]))
  } else if (fixed.length > 0) {
    lines.push(...quote(['[!TIP]', `**${line}**`, ...fixed]))
  } else {
    lines.push(line)
  }

  if (results.length > 1) {
    const hasBaseline = results.some(result => result.baseline)
    lines.push('', `| Package | Score | ${hasBaseline ? 'Δ | ' : ''}Instrumented | Partial | Dark | Gate |`)
    lines.push(`| --- | ---: | ${hasBaseline ? '---: | ' : ''}---: | ---: | ---: | --- |`)
    for (const result of results) {
      const { summary } = result
      const delta = result.baseline ? signed(result.baseline.delta) : '–'
      const name = result.name === '.' ? result.projectName : result.name
      lines.push(`| ${code(name)} (${result.framework}) | **${result.score}** ${grade(result.score)} | ${hasBaseline ? `${delta} | ` : ''}${summary.instrumented} | ${summary.partial} | ${summary.dark} | ${gateCell(result, gate)} |`)
    }
  } else {
    const { summary } = results[0]
    lines.push('', `${summary.instrumented} instrumented · ${summary.partial} partial · ${summary.dark} dark`)
  }

  if (minScore === undefined) {
    lines.push('', ...quote(['[!NOTE]', `No ${code('min-score')} set. Add ${code(`min-score: ${lowest(results)}`)} to keep today's score from dropping.`]))
  }

  const priorities = results.flatMap(result => prioritize(result.routes).slice(0, 3).map(route => ({ result, route })))
    .sort((a, b) => a.route.score - b.route.score)
    .slice(0, 5)
  if (priorities.length > 0) {
    lines.push('', `<details${regressions.length > 0 ? '' : ' open'}><summary>Fix first (${priorities.length})</summary>`, '')
    for (const { result, route } of priorities) {
      lines.push(`- ${code(routeLabel(route))} ${fileLink(result, route, context)}: ${failedChecks(route).map(code).join(', ')}`)
    }
    lines.push('', '</details>')
  }

  if (fixed.length > 0 && failed) {
    lines.push('', `<details><summary>Fixed since ${context.baselineRef ?? 'the base'} (${fixed.length})</summary>`, '', ...fixed, '', '</details>')
  }

  lines.push('', footer(context))
  return lines.join('\n')
}

function footer(context) {
  const version = context.cliVersion ? ` v${context.cliVersion}` : ''
  return `<sub>[evlog map](${DOCS}/cli/map)${version} · [how the score works](${DOCS}/cli/scoring) · [what each check expects](${DOCS}/cli/rules)</sub>`
}

const CELL = { 'pass': '✓', 'fail': '✗', 'n/a': '–' }

/**
 * The job summary: the report, then every entry point of every package with
 * the result of each check. The comment is where the verdict is read; this is
 * where the detail is.
 */
export function renderSummary(results, context) {
  const lines = [renderReport(results, context)]
  for (const result of results) {
    const checks = CHECKS.filter(check => result.routes.some(route => route.checks[check] && (route.checks[check].status !== 'n/a' || route.checks[check].suppressed)))
    const name = result.name === '.' ? result.projectName : result.name
    const hasBaseline = Boolean(result.baselineRoutes)
    lines.push('', `<details open><summary>${code(name)} · ${plural(result.routes.length, 'entry point')}</summary>`, '')
    lines.push(`| Entry point | Score | ${hasBaseline ? 'Δ | ' : ''}${checks.join(' | ')} |`)
    lines.push(`| --- | ---: | ${hasBaseline ? '---: | ' : ''}${checks.map(() => ':---:').join(' | ')} |`)
    for (const route of [...result.routes].sort((a, b) => a.score - b.score)) {
      const before = result.baselineRoutes?.[route.id]
      const delta = before === undefined ? '–' : signed(route.score - before)
      const cells = checks.map(check => {
        const outcome = route.checks[check]
        if (!outcome) return '–'
        return outcome.suppressed ? 'silenced' : CELL[outcome.status]
      })
      lines.push(`| ${code(routeLabel(route))} ${fileLink(result, route, context)} | ${route.score} | ${hasBaseline ? `${delta} | ` : ''}${cells.join(' | ')} |`)
    }
    lines.push('', '</details>')
  }
  return lines.join('\n')
}
