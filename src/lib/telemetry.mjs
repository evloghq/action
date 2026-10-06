import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

// renovate: datasource=npm depName=@evlog/telemetry
const TELEMETRY_VERSION = '0.3.1'
const ENDPOINT = 'https://telemetry.evlog.cloud/api/telemetry/ingest'
const exec = promisify(execFile)

export const COLLECT_FIELDS = {
  baselineMode: ['none', 'base', 'spec'],
  checkOutcome: ['disabled', 'created', 'skipped', 'failed'],
  commentOutcome: ['disabled', 'created', 'updated', 'skipped', 'failed'],
  errorStage: ['inputs', 'baseline', 'cli', 'check', 'comment', 'unknown'],
}

/** The runner leaves GITHUB_ACTION_REF empty for composite actions; the action itself is checked out at the pinned ref. */
export function resolveVersion(env) {
  if (env.GITHUB_ACTION_REF) return env.GITHUB_ACTION_REF
  try {
    const { version } = JSON.parse(readFileSync(join(env.GITHUB_ACTION_PATH ?? '', 'package.json')))
    if (version) return version
  } catch {}
  return 'local'
}

/** Install the pinned SDK outside the workspace, without package scripts. */
export async function loadTelemetry(env = process.env) {
  const directory = await mkdtemp(join(env.RUNNER_TEMP || tmpdir(), 'evlog-telemetry-'))
  try {
    await exec('npm', [
      'install', '--prefix', directory, '--no-save', '--package-lock=false',
      '--ignore-scripts', '--no-audit', '--no-fund', `@evlog/telemetry@${TELEMETRY_VERSION}`,
    ], { timeout: 15_000, env })
    const sdk = await import(pathToFileURL(join(directory, 'node_modules/@evlog/telemetry/dist/index.mjs')).href)
    return { sdk, cleanup: () => rm(directory, { recursive: true, force: true }) }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

/** Numeric scan totals only; package names, routes and findings stay local. */
export function scanFields(outputs) {
  return {
    packages: outputs.results.length,
    entryPoints: outputs.instrumented + outputs.partial + outputs.dark,
    score: outputs.score,
    instrumented: outputs.instrumented,
    partial: outputs.partial,
    dark: outputs.dark,
    regressions: outputs.regressions,
    fixed: outputs.results.reduce((sum, result) => sum + result.fixed.length, 0),
    gatePassed: outputs.passed,
    ...(outputs.delta === '' ? {} : { baselineDelta: outputs.delta }),
  }
}

/** Record one action run without letting telemetry change its result or run it twice. */
export async function runWithTelemetry(inputs, work, {
  env = process.env,
  load = loadTelemetry,
  notice,
} = {}) {
  if (!inputs.telemetry || env.DO_NOT_TRACK === '1' || env.EVLOG_TELEMETRY === '0') return work()

  let loaded
  let handle
  try {
    loaded = await load(env)
    handle = loaded.sdk.createGitHubActionsTelemetry({
      name: 'evlog-action',
      version: resolveVersion(env),
      environment: 'production',
      actionName: 'evloghq/action',
      endpoint: ENDPOINT,
      collect: { fields: COLLECT_FIELDS },
    })
  } catch {
    notice('telemetry unavailable; continuing without it')
    if (loaded) await cleanup(loaded, notice)
    return work()
  }

  let started = false
  let value
  let workError
  try {
    await handle.run('map', async () => {
      started = true
      const telemetry = loaded.sdk.telemetry
      try {
        value = await work(telemetry)
      } catch (error) {
        workError = error
        telemetry?.set?.({ errorStage: workError?.stage ?? 'unknown' })
        throw Object.assign(new Error('Action execution failed'), { code: 'ACTION_EXECUTION_FAILED' })
      }
    }, {
      flags: {
        gate: inputs.gate,
        annotations: inputs.annotations,
        summary: inputs.summary,
        minScore: inputs.minScore,
      },
    })
  } catch {
    if (!workError) notice('telemetry recording failed; the action result is unchanged')
    if (!started) value = await work()
  } finally {
    await cleanup(loaded, notice)
  }
  if (workError) throw workError
  return value
}


async function cleanup(loaded, notice) {
  try {
    await loaded.cleanup()
  } catch {
    notice('telemetry temporary files could not be removed; the action result is unchanged')
  }
}
