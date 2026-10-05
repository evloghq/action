import { filePath, prioritize } from './report.mjs'

/**
 * What to point at on the diff, read off the CLI's JSON.
 *
 * The selection is the CLI's `--format github` one and is kept identical to
 * `formats.ts` in evloghq/evlog: with a baseline, the regressions, as failures,
 * since the pull request caused them; without one, the FIX FIRST list, as
 * warnings. It is built here from the JSON rather than parsed off the CLI's
 * workflow commands so one list can feed the Checks API, which has no
 * per-level cap, and the workflow-command fallback alike.
 */
export function findings(result, { baselineRef } = {}) {
  if (!result.baseline) {
    return prioritize(result.routes).flatMap(route => failures(result, route).map(finding => ({ level: 'warning', ...finding })))
  }
  const routes = new Map(result.routes.map(route => [route.id, route]))
  return result.baseline.regressions.flatMap((regression) => {
    const route = routes.get(regression.routeId)
    if (!route) return []
    const failed = failures(result, route).find(finding => finding.check === regression.check)
    const finding = failed ?? {
      path: filePath(result, route.file),
      line: route.handler?.line ?? 1,
      check: regression.check,
      message: `${regression.check} passed on ${baselineRef ?? 'the base'} and is now silenced`,
    }
    return [{ level: 'failure', ...finding }]
  }).map(finding => ({ ...finding, title: `evlog map: ${finding.check}` }))
}

/** The failing requirements of one entry point, at the evidence line when the check has one. */
function failures(result, route) {
  return Object.entries(route.checks)
    .filter(([, check]) => check.status === 'fail')
    .map(([check, { evidence, message }]) => ({
      path: filePath(result, evidence?.file ?? route.file),
      line: evidence?.line ?? route.handler?.line ?? 1,
      check,
      message: message ?? check,
      title: `evlog map: ${check}`,
    }))
}

/* GitHub reads workflow commands off stdout and unescapes these three in the
   message and these five in the properties; anything else passes through. */
const escapeMessage = text => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const escapeProperty = text => escapeMessage(text).replace(/:/g, '%3A').replace(/,/g, '%2C')

/** The same finding as a workflow command, for a token that cannot write check runs. */
export function workflowCommand({ level, path, line, title, message }) {
  const command = level === 'failure' ? 'error' : level
  const props = Object.entries({ file: path, line: String(line), title }).map(([key, value]) => `${key}=${escapeProperty(value)}`).join(',')
  return `::${command} ${props}::${escapeMessage(message)}`
}
