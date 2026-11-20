import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/* A pull request in a project that installs its own @evlog/cli: the base
   checkout has no node_modules, and must still be scanned with that CLI. */
const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'evlog-action-project-cli-'))
const PROJECT_CLI = '0.11.2'
const PINNED = '1.0.0-beta.2'

const git = (...args) => exec('git', ['-c', 'user.email=ci@evlog.dev', '-c', 'user.name=ci', ...args], { cwd: work })
const work = join(directory, 'work')

try {
  await exec('git', ['init', '-q', '--bare', join(directory, 'origin.git')])
  await cp(join(root, 'test/fixtures/hono-app'), work, { recursive: true })
  await git('init', '-q', '-b', 'main')
  await git('remote', 'add', 'origin', join(directory, 'origin.git'))
  await writeFile(join(work, '.gitignore'), 'node_modules\n')
  await exec('npm', ['install', '--no-audit', '--no-fund', `@evlog/cli@${PROJECT_CLI}`, 'evlog@2'], { cwd: work })
  await git('add', '-A')
  await git('commit', '-qm', 'base')
  await git('push', '-q', 'origin', 'main')
  await git('checkout', '-q', '-b', 'feature')
  await appendFile(join(work, 'src/index.ts'), '\n')
  await git('commit', '-qam', 'change')

  const event = join(directory, 'event.json')
  await writeFile(event, JSON.stringify({ pull_request: { number: 1, base: { ref: 'main', sha: 'base' }, head: { sha: 'head' } } }))
  const outputFile = join(directory, 'output')
  await writeFile(outputFile, '')
  const env = {
    ...process.env,
    npm_config_min_release_age: '0',
    INPUT_VERSION: PINNED,
    INPUT_BASELINE: 'auto',
    INPUT_ANNOTATIONS: 'false',
    INPUT_COMMENT: 'false',
    INPUT_SUMMARY: 'false',
    INPUT_TELEMETRY: 'false',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: event,
    GITHUB_WORKSPACE: work,
    GITHUB_OUTPUT: outputFile,
  }
  delete env.GITHUB_STEP_SUMMARY
  const { stdout, stderr } = await exec(process.execPath, [join(root, 'src/main.mjs')], { cwd: work, env, timeout: 120_000 })

  assert.match(stdout + stderr, new RegExp(`runs its own @evlog/cli ${PROJECT_CLI.replaceAll('.', '\\.')}, so the base is scanned with it too`))
  assert.match(await readFile(outputFile, 'utf8'), /^delta=0$/m)
  console.log(`pinned ${PINNED}, project ${PROJECT_CLI}: base and pull request scanned with ${PROJECT_CLI}, delta 0`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
