/**
 * The report as Markdown, for the job summary and the pull request comment.
 *
 * One table across packages, then what to fix first and, with a baseline,
 * what moved. The numbers come straight from the CLI's JSON; the only
 * judgment made here is which three entry points to list.
 */

const DOCS = 'https://evlog.dev'
const ACTION = 'https://github.com/evloghq/action'

export function grade(score) {
  if (score >= 90) return 'excellent'
  if (score >= 75) return 'good'
  if (score >= 50) return 'needs work'
  return 'poor'
}

const signed = n => (n > 0 ? `+${n}` : String(n))
const code = text => `\`${text}\``

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

function routeLabel(route) {
  return `${route.method ?? 'ALL'} ${route.path}`
}

function fileLink(result, route, { serverUrl, repository, sha }, line = route.handler?.line) {
  const path = result.path === '.' ? route.file : `${result.path}/${route.file}`
  const text = line ? `${path}:${line}` : path
  if (!serverUrl || !repository || !sha) return code(text)
  return `[${code(text)}](${serverUrl}/${repository}/blob/${sha}/${path}${line ? `#L${line}` : ''})`
}

function statusCell(result) {
  if (result.status === 'passed') return 'passed'
  if (result.reasons.length === 0) return 'failed'
  return `failed (${result.reasons.join(', ')})`
}

/**
 * The one line to read: lowest score, how it moved, what failed.
 *
 * `baselineRef` names what the delta is against (`main`); without it the
 * movement is left out rather than attributed to nothing.
 */
export function verdict(results, { baselineRef } = {}) {
  const score = Math.min(...results.map(result => result.score))
  const parts = [`**${score}** ${grade(score)}`]
  if (results.length > 1) parts[0] += ` across ${results.length} packages`
  const withBaseline = results.filter(result => result.baseline)
  if (withBaseline.length > 0) {
    const delta = Math.min(...withBaseline.map(result => result.baseline.delta))
    const against = baselineRef ? ` against ${code(baselineRef)}` : ''
    parts.push(delta === 0 ? `unchanged${against}` : `${signed(delta)}${against}`)
    const regressions = withBaseline.reduce((sum, result) => sum + result.baseline.regressions.length, 0)
    parts.push(regressions === 0 ? 'no regression' : `${regressions} regression${regressions === 1 ? '' : 's'}`)
  }
  const below = results.filter(result => result.reasons.some(reason => reason.startsWith('below')))
  if (below.length > 0) parts.push(below[0].reasons.find(reason => reason.startsWith('below')).replace('--min-score', 'min-score'))
  return parts.join(' · ')
}

/**
 * @param results one entry per package, from `main.mjs`; `name` is how the
 * package is shown, `path` where it sits in the repository, for links
 * @param context repository, sha and server for links; cliVersion for the
 * footer; baselineRef for the verdict
 */
export function renderReport(results, context) {
  const lines = [
    '### Observability score',
    '',
    verdict(results, context),
    '',
  ]
  const hasBaseline = results.some(result => result.baseline)

  lines.push(`| Package | Score | ${hasBaseline ? 'Δ | ' : ''}Instrumented | Partial | Dark | Gate |`)
  lines.push(`| --- | ---: | ${hasBaseline ? '---: | ' : ''}---: | ---: | ---: | --- |`)
  for (const result of results) {
    const { summary } = result
    const delta = result.baseline ? signed(result.baseline.delta) : '–'
    const name = result.name === '.' ? result.projectName : result.name
    lines.push(`| ${code(name)} (${result.framework}) | **${result.score}** ${grade(result.score)} | ${hasBaseline ? `${delta} | ` : ''}${summary.instrumented} | ${summary.partial} | ${summary.dark} | ${statusCell(result)} |`)
  }

  const regressions = results.flatMap(result => (result.baseline?.regressions ?? []).map(regression => ({ result, regression })))
  if (regressions.length > 0) {
    lines.push('', `### Regressions (${regressions.length})`, '')
    lines.push('Checks that passed on the base and no longer do.', '')
    for (const { result, regression } of regressions) {
      const route = result.routes.find(route => route.id === regression.routeId)
      const where = route ? fileLink(result, route, context) : code(regression.file)
      lines.push(`- ${code(`${regression.method ?? 'ALL'} ${regression.path}`)} ${where}: ${code(regression.check)} ${regression.to === 'suppressed' ? 'silenced' : 'failing'}`)
    }
  }

  const priorities = results.flatMap(result => prioritize(result.routes).slice(0, 3).map(route => ({ result, route })))
    .sort((a, b) => a.route.score - b.route.score)
    .slice(0, 5)
  if (priorities.length > 0) {
    lines.push('', '### Fix first', '')
    for (const { result, route } of priorities) {
      lines.push(`- ${code(routeLabel(route))} ${fileLink(result, route, context)}: ${failedChecks(route).map(code).join(', ')}`)
    }
  }

  const fixed = results.flatMap(result => result.baseline?.fixed ?? [])
  if (fixed.length > 0) {
    lines.push('', `<details><summary>Fixed since the base (${fixed.length})</summary>`, '')
    for (const fix of fixed) lines.push(`- ${code(`${fix.method ?? 'ALL'} ${fix.path}`)}: ${code(fix.check)}`)
    lines.push('', '</details>')
  }

  lines.push('', `<sub>Scored by [evlog map](${DOCS}/cli/map)${context.cliVersion ? ` v${context.cliVersion}` : ''} through [evloghq/action](${ACTION}): a static read of each entry point for the wide event, context and audit trail it should emit. [How the score works](${DOCS}/cli/scoring) · [what each check expects](${DOCS}/cli/rules)</sub>`)
  return lines.join('\n')
}
