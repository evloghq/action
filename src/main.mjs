import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { baselineFor, checkoutBase, relabelBaseline } from './lib/baseline.mjs'
import { gateArgs, packageSpec, runMap } from './lib/cli.mjs'
import { upsertComment } from './lib/comment.mjs'
import { readEvent } from './lib/event.mjs'
import { InputError, readInputs, resolveBaseline } from './lib/inputs.mjs'
import { expandPackages, isPackage, toPosix } from './lib/packages.mjs'
import { aggregate, writeOutputs } from './lib/outputs.mjs'
import { renderReport } from './lib/report.mjs'

const log = message => process.stderr.write(`${message}\n`)
const notice = message => process.stdout.write(`::notice title=evlog::${message}\n`)
const fail = message => process.stdout.write(`::error title=evlog::${message}\n`)

/** Why a package failed its gate, read off the JSON the CLI printed. */
function reasons(json, minScore) {
  const out = []
  if (minScore !== undefined && json.map.score < minScore) out.push(`below --min-score ${minScore}`)
  if (json.baseline && (json.baseline.regressions.length > 0 || json.baseline.delta < 0)) out.push('regressed')
  return out
}

async function main() {
  const inputs = readInputs()
  const event = readEvent()
  const spec = packageSpec(inputs.version)
  const root = resolve(event.workspace, inputs.workingDirectory)

  const packages = inputs.packages.length > 0 ? expandPackages(inputs.packages, root) : [{ dir: root, name: '.' }]
  if (packages.length === 0) throw new InputError(`\`packages\` matched nothing under ${inputs.workingDirectory}`)
  for (const pkg of packages) {
    if (!isPackage(pkg.dir)) throw new InputError(`${pkg.name} has no package.json`)
  }
  log(`evlog: ${packages.length} package${packages.length === 1 ? '' : 's'} · ${spec}`)

  const baseline = resolveBaseline(inputs.baseline, event)
  const base = baseline.mode === 'base' ? checkoutBase({ workspace: root, ref: baseline.ref, log }) : undefined

  const results = []
  let cliVersion
  try {
    for (const pkg of packages) {
      const baselineArg = baseline.mode === 'spec'
        ? baseline.spec
        : base
          ? baselineFor({ base, packageDir: pkg.dir, version: inputs.version })
          : undefined
      const args = gateArgs({ minScore: inputs.minScore, baseline: baselineArg })

      const scan = runMap({ spec, cwd: pkg.dir, args: ['--json', ...args] })
      let json
      try {
        json = JSON.parse(scan.stdout)
      } catch {
        throw new Error(`${pkg.name}: the CLI printed no JSON (exit ${scan.status})`)
      }
      if (json.error) throw new Error(`${pkg.name}: ${json.error.message}${json.error.fix ? ` — ${json.error.fix}` : ''}`)

      if (inputs.annotations) {
        const annotated = runMap({ spec, cwd: pkg.dir, args: ['--format', 'github', '--limit', String(inputs.limit), ...args] })
        const text = base ? relabelBaseline(annotated.stdout, baselineArg, baseline.ref) : annotated.stdout
        process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
      }

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
        status: scan.status === 0 ? 'passed' : 'failed',
        reasons: failed,
      })
    }
  } finally {
    base?.cleanup()
  }

  const outputs = aggregate(results)
  const baselineRef = baseline.mode === 'base' ? baseline.ref : baseline.mode === 'spec' ? baseline.spec : undefined
  const report = renderReport(results, { ...event, cliVersion, baselineRef })
  if (inputs.summary && event.summaryFile) appendFileSync(event.summaryFile, `${report}\n`)

  if (inputs.comment !== 'never' && event.pullRequest) {
    const create = inputs.comment === 'always' || !outputs.passed
    const outcome = await upsertComment({ event, token: inputs.token, key: inputs.commentKey, body: report, create })
    if (outcome.outcome === 'skipped') notice(`pull request comment skipped: ${outcome.reason}`)
    else if (outcome.outcome === 'failed') fail(`pull request comment ${outcome.reason}`)
    else log(`evlog: comment ${outcome.outcome}`)
  }

  writeOutputs(outputs, event.outputFile)

  if (!outputs.passed && inputs.gate) process.exitCode = 1
}

main().catch((error) => {
  fail(error instanceof InputError ? error.message : `${error.message}`)
  process.exitCode = error instanceof InputError ? 2 : 1
})
