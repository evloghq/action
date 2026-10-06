import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { COLLECT_FIELDS, runWithTelemetry, scanFields } from '../src/lib/telemetry.mjs'

function setup({ runError, setupError, afterError, cleanupError } = {}) {
  const calls = { notices: [], cleaned: 0, loaded: 0, options: undefined, runs: [], sets: [] }
  const handle = {
    set(fields) { calls.sets.push(fields) },
    async run(command, work, options) {
      calls.runs.push({ command, options })
      if (runError) throw runError
      const result = await work()
      if (afterError) throw afterError
      return result
    },
  }
  const load = async () => {
    calls.loaded++
    return {
      sdk: {
        telemetry: handle,
        createGitHubActionsTelemetry(options) {
          calls.options = options
          if (setupError) throw setupError
          return handle
        },
      },
      async cleanup() { calls.cleaned++; if (cleanupError) throw cleanupError },
    }
  }
  return { calls, handle, options: { load, env: {}, notice: text => calls.notices.push(text) } }
}

const inputs = { telemetry: true, gate: true, annotations: true, summary: true, minScore: 80 }

describe('runWithTelemetry', () => {
  for (const [name, settings, env] of [
    ['action input', { telemetry: false }, {}],
    ['DO_NOT_TRACK', {}, { DO_NOT_TRACK: '1', EVLOG_TELEMETRY: '1' }],
    ['EVLOG_TELEMETRY', {}, { EVLOG_TELEMETRY: '0' }],
  ]) {
    it(`does not load the SDK when disabled by ${name}`, async () => {
      const { calls, options } = setup()
      let ran = 0
      const value = await runWithTelemetry({ ...inputs, ...settings }, async () => ++ran, { ...options, env })
      assert.equal(value, 1)
      assert.equal(ran, 1)
      assert.equal(calls.loaded, 0)
    })
  }

  it('records one run with fixed action identity and safe flags', async () => {
    const { calls, handle, options } = setup()
    const result = await runWithTelemetry({ ...inputs, token: 'secret', workingDirectory: '/private/path' }, async telemetry => {
      assert.equal(telemetry, handle)
      return 42
    }, { ...options, env: { GITHUB_ACTION_REF: 'v1' } })
    assert.equal(result, 42)
    assert.deepEqual(calls.runs, [{ command: 'map', options: { flags: { gate: true, annotations: true, summary: true, minScore: 80 } } }])
    assert.equal(calls.options.name, 'evlog-action')
    assert.equal(calls.options.version, 'v1')
    assert.equal(calls.options.actionName, 'evloghq/action')
    assert.deepEqual(calls.options.collect, { fields: COLLECT_FIELDS })
    assert.equal(calls.cleaned, 1)
    assert.deepEqual(calls.notices, [])
  })

  it('runs normally when the SDK cannot be downloaded', async () => {
    const { calls, options } = setup()
    let ran = 0
    await runWithTelemetry(inputs, async () => ran++, {
      ...options,
      load: async () => { throw new Error('download failed') },
    })
    assert.equal(ran, 1)
    assert.equal(calls.notices.length, 1)
  })

  it('cleans up and runs normally when SDK creation fails', async () => {
    const { calls, options } = setup({ setupError: new Error('SDK failed') })
    let ran = 0
    await runWithTelemetry(inputs, async () => ran++, options)
    assert.equal(ran, 1)
    assert.equal(calls.cleaned, 1)
    assert.equal(calls.notices.length, 1)
  })

  for (const [name, errors] of [
    ['before execution', { runError: new Error('outbox failed') }],
    ['after execution', { afterError: new Error('outbox failed') }],
  ]) {
    it(`does not lose or repeat the action when recording fails ${name}`, async () => {
      const { calls, options } = setup(errors)
      let ran = 0
      const value = await runWithTelemetry(inputs, async () => { ran++; return 42 }, options)
      assert.equal(value, 42)
      assert.equal(ran, 1)
      assert.equal(calls.cleaned, 1)
      assert.equal(calls.notices.length, 1)
    })
  }

  it('preserves a successful result when temporary file cleanup fails', async () => {
    const { calls, options } = setup({ cleanupError: new Error('permission denied') })
    assert.equal(await runWithTelemetry(inputs, async () => 42, options), 42)
    assert.equal(calls.notices.length, 1)
  })

  it('preserves the action error but reports only a fixed error code', async () => {
    const { calls, options } = setup()
    const error = new Error('/private/source.ts: token=secret')
    let captured
    const load = options.load
    options.load = async () => {
      const loaded = await load()
      const create = loaded.sdk.createGitHubActionsTelemetry
      loaded.sdk.createGitHubActionsTelemetry = config => {
        const handle = create(config)
        handle.run = async (_, work) => {
          try { await work() } catch (error) { captured = error; throw error }
        }
        return handle
      }
      return loaded
    }
    let ran = 0
    await assert.rejects(runWithTelemetry(inputs, async () => { ran++; throw error }, options), actual => actual === error)
    assert.equal(ran, 1)
    assert.equal(captured.code, 'ACTION_EXECUTION_FAILED')
    assert.equal(captured.message, 'Action execution failed')
    assert.equal(calls.cleaned, 1)
    assert.deepEqual(calls.notices, [])
  })

  it('reports the stage a work error came from', async () => {
    const { calls, options } = setup()
    const error = new Error('git checkout failed')
    error.stage = 'baseline'
    await assert.rejects(runWithTelemetry(inputs, async () => { throw error }, options), actual => actual === error)
    assert.deepEqual(calls.sets, [{ errorStage: 'baseline' }])
  })

  it('reports an unknown stage when the work error carries none', async () => {
    const { calls, options } = setup()
    const error = new Error('something broke')
    await assert.rejects(runWithTelemetry(inputs, async () => { throw error }, options), actual => actual === error)
    assert.deepEqual(calls.sets, [{ errorStage: 'unknown' }])
  })
})

describe('scanFields', () => {
  it('contains only aggregate numbers and booleans', () => {
    assert.deepEqual(scanFields({
      score: 70, delta: -5, regressions: 2, instrumented: 3, partial: 1, dark: 2, passed: false,
      results: [{ name: 'private-app', framework: 'nuxt', fixed: ['private/route'], regressions: ['private/other'] }],
    }), {
      packages: 1, entryPoints: 6, score: 70, baselineDelta: -5, regressions: 2,
      instrumented: 3, partial: 1, dark: 2, fixed: 1, gatePassed: false,
    })
  })

  it('omits the delta without a baseline', () => {
    const fields = scanFields({ score: 100, delta: '', regressions: 0, instrumented: 1, partial: 0, dark: 0, passed: true, results: [{ fixed: [] }] })
    assert.equal(Object.hasOwn(fields, 'baselineDelta'), false)
  })
})
