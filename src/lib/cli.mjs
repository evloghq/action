import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * How `npx` is told which CLI to run: a version goes on the package name, a
 * URL or a path is a spec of its own (a pkg.pr.new preview, for example).
 */
export function packageSpec(version) {
  return /^(https?:|file:|\.|\/)/.test(version) || version.includes('/') ? version : `@evlog/cli@${version}`
}

/**
 * The `@evlog/cli` the package installed, when `spec` hands off to it.
 *
 * The CLI's launcher runs the copy a project installed over the one `npx`
 * fetched, so the scan of the package can run another version than `spec`.
 * The base checkout has no `node_modules`, so its scan has to be pointed at
 * that same install to compare like with like.
 */
export function projectCli({ spec, cwd, env = process.env }) {
  let dir
  try {
    dir = dirname(dirname(createRequire(join(cwd, 'package.json')).resolve('@evlog/cli')))
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    return undefined
  }
  const { version, bin } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const runs = spawnSync('npx', ['--yes', '-p', spec, 'evlog', '--version'], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  if (runs.error) throw runs.error
  if (runs.status !== 0) throw new Error(`${spec} did not run in ${cwd} (exit ${runs.status})`)
  if (runs.stdout.trim() !== version) return undefined
  return { version, bin: join(dir, typeof bin === 'string' ? bin : bin.evlog) }
}

/**
 * Run one `evlog map` and hand back what it printed and how it exited.
 *
 * stdout is the machine contract (`--json` or workflow commands) and is
 * returned; stderr is the human report and is passed straight through so the
 * job log reads like a local run. `bin` runs an installed CLI instead of
 * fetching `spec`.
 */
export function runMap({ spec, bin, cwd, args, env = process.env }) {
  const argv = ['map', '--no-write', '--no-header', ...args]
  const result = spawnSync(bin ? process.execPath : 'npx', bin ? [bin, ...argv] : ['--yes', '-p', spec, 'evlog', ...argv], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw result.error
  return { stdout: result.stdout, status: result.status ?? 1 }
}

/** The arguments shared by the JSON and the annotation runs of one package. */
export function gateArgs({ minScore, baseline }) {
  const args = []
  if (minScore !== undefined) args.push('--min-score', String(minScore))
  if (baseline) args.push('--baseline', baseline)
  return args
}
