import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { baselineFor, checkoutBase } from './lib/baseline.mjs'
import { createCheckRun } from './lib/checks.mjs'
import { gateArgs, packageSpec, runMap } from './lib/cli.mjs'
import { upsertComment } from './lib/comment.mjs'
import { readEvent } from './lib/event.mjs'
import { findings, workflowCommand } from './lib/findings.mjs'
import { InputError, readInputs, resolveBaseline } from './lib/inputs.mjs'
import { expandPackages, isPackage, toPosix } from './lib/packages.mjs'
import { aggregate, writeOutputs } from './lib/outputs.mjs'
import { runWithTelemetry, scanFields } from './lib/telemetry.mjs'
import { packageLine, plain, renderReport, renderSummary, verdict } from './lib/report.mjs'

const CHECK_NAME = 'evlog map'

const log = message => process.stderr.write(`${message}\n`)
const notice = message => process.stdout.write(`::notice title=evlog::${message}\n`)
const fail = message => process.stdout.write(`::error title=evlog::${message}\n`)

/** Stamp the stage an error came from, for telemetry's errorStage field. */
const tag = (stage, error) => Object.assign(error, { stage })

/** Why a package failed its gate, read off the JSON the CLI printed. */
function reasons(json, minScore) {
  const out = []
  if (minScore !== undefined && json.map.score < minScore) out.push(`below --min-score ${minScore}`)
  if (json.baseline && (json.baseline.regressions.length > 0 || json.baseline.delta < 0)) out.push('regressed')
  return out
}

/**
 * Findings as workflow commands, when no check run could be created. GitHub
 * keeps ten per level per step, so each package stops at `limit` and the
 * closing line says how many it left out.
 */
function printWorkflowCommands(results, inputs, baselineRef) {
  for (const result of results) {
    const list = findings(result, { baselineRef })
    const shown = list.slice(0, inputs.limit)
    for (const finding of shown) process.stdout.write(`${workflowCommand(finding)}\n`)
    const hidden = list.length - shown.length
    const line = `${packageLine(result, { baselineRef })}${hidden > 0 ? `; ${hidden} more finding${hidden === 1 ? '' : 's'} not shown` : ''}`
    process.stdout.write(`::${result.status === 'failed' ? 'error' : 'notice'} title=evlog map::${line}\n`)
  }
}

async function main(inputs, telemetry) {
  const event = readEvent()
  const spec = packageSpec(inputs.version)
  const root = resolve(event.workspace, inputs.workingDirectory)

  const packages = inputs.packages.length > 0 ? expandPackages(inputs.packages, root) : [{ dir: root, name: '.' }]
  if (packages.length === 0) throw tag('inputs', new InputError(`\`packages\` matched nothing under ${inputs.workingDirectory}`))
  for (const pkg of packages) {
    if (!isPackage(pkg.dir)) throw tag('inputs', new InputError(`${pkg.name} has no package.json`))
  }
  log(`evlog: ${packages.length} package${packages.length === 1 ? '' : 's'} · ${spec}`)

  let baseline
  try {
    baseline = resolveBaseline(inputs.baseline, event)
  } catch (error) {
    throw tag('inputs', error)
  }
  telemetry?.set({ packages: packages.length, baselineMode: baseline.mode })
  let base
  try {
    base = baseline.mode === 'base' ? checkoutBase({ workspace: root, ref: baseline.ref, log }) : undefined
  } catch (error) {
    throw tag('baseline', error)
  }
  const baselineRef = baseline.mode === 'base' ? baseline.ref : baseline.mode === 'spec' ? baseline.spec : undefined

  const results = []
  let cliVersion
  try {
    for (const pkg of packages) {
      const scanned = base ? baselineFor({ base, packageDir: pkg.dir, version: inputs.version }) : undefined
      const baselineArg = baseline.mode === 'spec' ? baseline.spec : scanned?.file
      const args = gateArgs({ minScore: inputs.minScore, baseline: baselineArg })

      const scan = runMap({ spec, cwd: pkg.dir, args: ['--json', ...args] })
      let json
      try {
        json = JSON.parse(scan.stdout)
      } catch {
        throw new Error(`${pkg.name}: the CLI printed no JSON (exit ${scan.status})`)
      }
      if (json.error) throw new Error(`${pkg.name}: ${json.error.message}${json.error.fix ? ` — ${json.error.fix}` : ''}`)

      cliVersion ??= json.map.cliVersion
      const failed = reasons(json, inputs.minScore)
      results.push({
        name: pkg.name,
        dir: pkg.dir,
        path: toPosix(relative(event.workspace, pkg.dir)) || '.',
        framework: json.map.framework,
        projectName: json.map.projectName,
        score: json.map.score,
        routes: json.map.routes,
        summary: json.summary,
        baseline: json.baseline,
        baselineRoutes: scanned ? Object.fromEntries(scanned.map.routes.map(route => [route.id, route.score])) : undefined,
        status: scan.status === 0 ? 'passed' : 'failed',
        reasons: failed,
      })
      log(`evlog: ${pkg.name === '.' ? json.map.projectName : pkg.name} · ${packageLine(results.at(-1), { baselineRef })}`)
    }
  } catch (error) {
    throw tag('cli', error)
  } finally {
    base?.cleanup()
  }

  const outputs = aggregate(results)
  telemetry?.set(scanFields(outputs))
  telemetry?.set({ checkOutcome: 'disabled', commentOutcome: 'disabled' })
  const context = { ...event, cliVersion, baselineRef, minScore: inputs.minScore, gate: inputs.gate }
  const report = renderReport(results, context)
  if (inputs.summary && event.summaryFile) appendFileSync(event.summaryFile, `${renderSummary(results, context)}\n`)

  if (inputs.annotations) {
    let outcome
    try {
      outcome = await createCheckRun({
        event,
        token: inputs.token,
        name: CHECK_NAME,
        headSha: event.pullRequest?.headSha ?? event.sha,
        conclusion: outputs.passed ? 'success' : inputs.gate ? 'failure' : 'neutral',
        title: plain(`${outputs.score} · ${verdict(results, context)}`),
        summary: report,
        annotations: results.flatMap(result => findings(result, { baselineRef })),
      })
    } catch (error) {
      throw tag('check', error)
    }
    telemetry?.set({ checkOutcome: outcome.outcome })
    if (outcome.outcome === 'created') log(`evlog: check run ${outcome.url} · ${outcome.annotations} annotation${outcome.annotations === 1 ? '' : 's'}`)
    else {
      if (outcome.outcome === 'failed') fail(`check run ${outcome.reason}`)
      else notice(`check run skipped: ${outcome.reason}`)
      printWorkflowCommands(results, inputs, baselineRef)
    }
  }

  if (inputs.comment !== 'never' && event.pullRequest) {
    const create = inputs.comment === 'always' || !outputs.passed
    let outcome
    try {
      outcome = await upsertComment({ event, token: inputs.token, key: inputs.commentKey, body: report, create })
    } catch (error) {
      throw tag('comment', error)
    }
    telemetry?.set({ commentOutcome: outcome.outcome })
    if (outcome.outcome === 'skipped') notice(`pull request comment skipped: ${outcome.reason}`)
    else if (outcome.outcome === 'failed') fail(`pull request comment ${outcome.reason}`)
    else log(`evlog: comment ${outcome.outcome}`)
  }

  writeOutputs(outputs, event.outputFile)

  if (!outputs.passed && inputs.gate) process.exitCode = 1
}

Promise.resolve().then(() => {
  const inputs = readInputs()
  if (!inputs.telemetry) process.env.EVLOG_TELEMETRY = '0'
  return runWithTelemetry(inputs, telemetry => main(inputs, telemetry), { notice })
}).catch((error) => {
  fail(error instanceof InputError ? error.message : `${error.message}`)
  process.exitCode = error instanceof InputError ? 2 : 1
})
