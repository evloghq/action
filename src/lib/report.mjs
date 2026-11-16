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
import { picture } from './cards.mjs'

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
 * `baselineRoutes` maps entry point ids to their score at the base,
 * `baselineEvents` to their wide event there
 * @param context repository, sha, pull request and server for links;
 * cliVersion for the footer; baselineRef for the verdict; minScore and gate
 * for what the gate did
 */
export function renderReport(results, context) {
  if (context.cards) return renderCardReport(results, context)
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

  const priorities = fixFirst(results)
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

/** Up to five entry points to fix, three per package at most, lowest score first. */
function fixFirst(results) {
  return results.flatMap(result => prioritize(result.routes).slice(0, 3).map(route => ({ result, route })))
    .sort((a, b) => a.route.score - b.route.score)
    .slice(0, 5)
}

/** Why the gate failed, in one line: the checks lost, the score under `min-score`. */
function gateLine(results, { gate = true, baselineRef }) {
  const regressions = results.reduce((sum, result) => sum + (result.baseline?.regressions.length ?? 0), 0)
  const parts = []
  if (regressions > 0) parts.push(`${plural(regressions, 'check')} lost against ${code(baselineRef ?? 'the base')}`)
  const below = results.flatMap(result => result.reasons).find(reason => reason.startsWith('below'))
  if (below) parts.push(below.replace('below --min-score', 'below `min-score`'))
  if (parts.length === 0) parts.push(`score dropped against ${code(baselineRef ?? 'the base')}`)
  return `${gate ? 'Gate failed' : 'Gate would fail'}: ${parts.join(', ')}${gate ? '' : ' (`gate: false`, the step stays green)'}`
}

const EMPTY_EVENT = { fields: [], audit: [] }
const MAX_KEPT = 3

/** An event's lines as the diff prints them: field paths, then audit actions. */
function eventLines(event = EMPTY_EVENT) {
  return [...event.fields, ...event.audit.map(action => `audit "${action}"`)]
}

/**
 * Entry points whose wide event this pull request changes, from the `event`
 * key `evlog map` writes on the base and on the head. An entry point that is
 * new in the pull request has nothing to compare against and is left out.
 */
export function eventChanges(results) {
  const changes = results.flatMap(result => result.routes.flatMap((route) => {
    if (!result.baselineEvents || !(route.id in result.baselineEvents)) return []
    const base = result.baselineEvents[route.id]
    const before = eventLines(base)
    const after = eventLines(route.event)
    const gone = before.filter(line => !after.includes(line))
    const added = after.filter(line => !before.includes(line))
    if (gone.length === 0 && added.length === 0) return []
    return [{ result, route, before, after, gone, added, dark: !route.event && Boolean(base) }]
  }))
  const sensitive = change => (change.route.sensitivity.level === 'none' ? 1 : 0)
  return changes.sort((a, b) => (b.gone.length > 0) - (a.gone.length > 0) || sensitive(a) - sensitive(b) || b.gone.length - a.gone.length)
}

/**
 * The changes as a `diff` block GitHub highlights: one hunk per entry point,
 * its score movement in the hunk header, dropped lines in red, new ones in
 * green, and a few unchanged lines for context.
 */
export function eventDiff(changes, { multi = false } = {}) {
  const hunks = changes.map(({ result, route, before, after, added, dark }) => {
    const name = multi && result.path !== '.' ? `${result.path} ` : ''
    const base = result.baselineRoutes?.[route.id]
    const score = base === undefined || base === route.score ? `${route.score}` : `${base} → ${route.score}`
    const lines = [`@@ ${name}${routeLabel(route)} · ${score}${dark ? ' · no wide event after merge' : ''} @@`]
    let kept = 0
    for (const line of before) {
      if (!after.includes(line)) lines.push(`- ${line}`)
      else if (kept++ < MAX_KEPT) lines.push(`  ${line}`)
    }
    if (kept > MAX_KEPT) lines.push(`  … ${kept - MAX_KEPT} more unchanged`)
    for (const line of added) lines.push(`+ ${line}`)
    return lines.join('\n')
  })
  return ['```diff', hunks.join('\n\n'), '```'].join('\n')
}

/** What merging does to production logs, in one sentence, or nothing when it drops nothing. */
function mergeLine(changes) {
  const gone = changes.flatMap(change => change.gone)
  const audits = gone.filter(line => line.startsWith('audit ')).length
  const lost = [gone.length > audits ? plural(gone.length - audits, 'field') : '', audits > 0 ? plural(audits, 'audit action') : ''].filter(Boolean)
  const dark = changes.filter(change => change.dark).map(change => code(routeLabel(change.route)))
  const parts = []
  if (lost.length > 0) parts.push(`drops ${lost.join(' and ')} from production logs`)
  if (dark.length > 0) parts.push(`takes ${dark.join(', ')} dark`)
  return parts.length > 0 ? `Merging this ${parts.join(' and ')}.` : undefined
}

/**
 * The comment when the evlog cloud app drew the report card. The card opens
 * the comment with the score, its trend and the entry points that changed.
 * The Markdown keeps what an image cannot do: the gate as an alert with links
 * into the diff, the wide event diff as text, and the full grid folded away.
 */
function renderCardReport(results, context) {
  const { minScore, cards } = context
  const card = name => cards.cards.find(item => item.name === name)
  const changes = eventChanges(results)
  const merge = mergeLine(changes)
  const lines = []
  if (card('report')) lines.push(picture(card('report'), cards.url), '')

  const seen = new Set()
  const links = results.flatMap(result => (result.baseline?.regressions ?? []).map((regression) => {
    const route = result.routes.find(item => item.id === regression.routeId)
    const key = `${result.path}:${regression.routeId}`
    if (!route || seen.has(key)) return undefined
    seen.add(key)
    return fileLink(result, route, context, { diff: true })
  })).filter(Boolean)
  if (results.some(result => result.status === 'failed')) {
    lines.push(...quote(['[!CAUTION]', ...(merge ? [`**${merge}**`, gateLine(results, context)] : [`**${gateLine(results, context)}**`]), ...(links.length > 0 ? [links.join(' · ')] : [])]), '')
  } else if (merge) {
    lines.push(...quote(['[!WARNING]', `**${merge}**`]), '')
  }

  if (changes.length > 0) {
    lines.push(`<details><summary>Wide event diff, ${plural(changes.length, 'entry point')}</summary>`, '', eventDiff(changes, { multi: results.length > 1 }), '', '</details>')
  }
  const total = results.reduce((sum, result) => sum + result.routes.length, 0)
  const priorities = fixFirst(results)
  lines.push(`<details><summary>All ${plural(total, 'entry point')}${priorities.length > 0 ? ', fix first' : ''}</summary>`, '')
  if (card('matrix')) lines.push(picture(card('matrix'), cards.url), '')
  for (const { result, route } of priorities) {
    lines.push(`- ${code(routeLabel(route))} ${fileLink(result, route, context)}: ${failedChecks(route).map(code).join(', ')}`)
  }
  lines.push('', '</details>', '')

  if (minScore === undefined) {
    lines.push(...quote(['[!NOTE]', `No ${code('min-score')} set. Add ${code(`min-score: ${lowest(results)}`)} to keep today's score from dropping.`]), '')
  }
  lines.push(footer(context))
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
