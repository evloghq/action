import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'evlog-action-integration-'))
const batches = []
const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  batches.push(...JSON.parse(body).events)
  response.writeHead(204).end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${server.address().port}/ingest`

try {
  for (const [name, override, expectEvents] of [
    ['enabled', {}, true],
    ['input', { INPUT_TELEMETRY: 'false', EVLOG_TELEMETRY: '1' }, false],
    ['env', { EVLOG_TELEMETRY: '0' }, false],
    ['dnt', { DO_NOT_TRACK: '1', EVLOG_TELEMETRY: '1' }, false],
  ]) {
    batches.length = 0
    const env = {
      ...process.env,
      npm_config_min_release_age: '0',
      INPUT_VERSION: '0.8.0',
      INPUT_WORKING_DIRECTORY: 'test/fixtures/nuxt-app',
      INPUT_BASELINE: 'none',
      INPUT_ANNOTATIONS: 'false',
      INPUT_COMMENT: 'false',
      INPUT_SUMMARY: 'false',
      INPUT_GATE: 'false',
      INPUT_MIN_SCORE: '100',
      INPUT_TELEMETRY: 'true',
      GITHUB_WORKSPACE: root,
      GITHUB_ACTION: 'integration-test',
      GITHUB_ACTION_REF: 'test',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_ACTIONS: 'true',
      CI: 'true',
      XDG_CONFIG_HOME: join(directory, name),
      DO_NOT_TRACK: '0',
      EVLOG_TELEMETRY: '1',
      EVLOG_TELEMETRY_ENDPOINT: endpoint,
      ...override,
    }
    delete env.GITHUB_EVENT_PATH
    delete env.GITHUB_STEP_SUMMARY
    delete env.GITHUB_OUTPUT
    await exec(process.execPath, [join(root, 'src/main.mjs')], { cwd: root, env, timeout: 90_000 })
    if (expectEvents) {
      const action = batches.filter(event => event.tool.name === 'evlog-action')
      const cli = batches.filter(event => event.tool.name === 'evlog-cli')
      assert.equal(new Set(action.map(event => event.idempotencyKey)).size, 1)
      assert.ok(cli.length > 0, 'CLI scans must emit their own telemetry')
      assert.equal(action[0].outcome, 'success')
      assert.equal(action[0].custom.gatePassed, false)
      assert.equal(action[0].custom.packages, 1)
      assert.equal(action[0].custom.entryPoints, 4)
      assert.equal(action[0].custom.checkOutcome, 'disabled')
      assert.equal(action[0].custom.commentOutcome, 'disabled')
      console.log(`${name}: action + CLI events received; gatePassed=false; entryPoints=4`)
    } else {
      assert.equal(batches.length, 0, `${name} must disable both layers`)
      console.log(`${name}: no action or CLI events`)
    }
  }
} finally {
  await new Promise(resolve => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
