import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createCheckRun } from '../src/lib/checks.mjs'

const event = { apiUrl: 'https://api.github.com', repository: 'acme/shop' }

function fakeFetch(routes) {
  const calls = []
  const fetchFn = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers })
    const handler = routes.find(route => route.method === method && route.url.test(url))
    if (!handler) throw new Error(`unexpected ${method} ${url}`)
    const { status = 200, json = {} } = handler
    return { ok: status >= 200 && status < 300, status, json: async () => json }
  }
  return { fetchFn, calls }
}

const finding = n => ({ level: 'warning', path: `src/${n}.ts`, line: n, title: 'evlog map: context', message: 'no log.set()' })
const run = { event, token: 't', name: 'evlog map', headSha: 'head', conclusion: 'failure', title: '56 · needs work', summary: '### Observability score · 56' }

describe('createCheckRun', () => {
  it('creates one completed run on the head commit with the findings as annotations', async () => {
    const { fetchFn, calls } = fakeFetch([{ method: 'POST', url: /check-runs$/, status: 201, json: { id: 5, html_url: 'https://github.com/acme/shop/runs/5' } }])
    const outcome = await createCheckRun({ ...run, annotations: [finding(1)], fetchFn })
    assert.deepEqual(outcome, { outcome: 'created', id: 5, url: 'https://github.com/acme/shop/runs/5', annotations: 1 })
    assert.equal(calls[0].headers.authorization, 'Bearer t')
    assert.deepEqual(calls[0].body, {
      name: 'evlog map', head_sha: 'head', status: 'completed', conclusion: 'failure',
      output: { title: '56 · needs work', summary: '### Observability score · 56', annotations: [
        { path: 'src/1.ts', start_line: 1, end_line: 1, annotation_level: 'warning', title: 'evlog map: context', message: 'no log.set()' },
      ] },
    })
  })

  it('sends annotations past fifty in updates to the same run', async () => {
    const { fetchFn, calls } = fakeFetch([
      { method: 'POST', url: /check-runs$/, status: 201, json: { id: 5, html_url: 'u' } },
      { method: 'PATCH', url: /check-runs\/5$/, json: {} },
    ])
    const annotations = Array.from({ length: 120 }, (_, i) => finding(i + 1))
    const outcome = await createCheckRun({ ...run, annotations, fetchFn })
    assert.equal(outcome.annotations, 120)
    assert.deepEqual(calls.map(call => [call.method, call.body.output.annotations.length]), [['POST', 50], ['PATCH', 50], ['PATCH', 20]])
  })

  it('skips, without throwing, when the token cannot write checks', async () => {
    const { fetchFn } = fakeFetch([{ method: 'POST', url: /check-runs$/, status: 403, json: { message: 'Resource not accessible by integration' } }])
    const outcome = await createCheckRun({ ...run, annotations: [], fetchFn })
    assert.equal(outcome.outcome, 'skipped')
    assert.match(outcome.reason, /checks: write/)
  })

  it('reports a request that never got an answer, so the findings can fall back', async () => {
    const down = async () => { throw new TypeError('fetch failed') }
    assert.deepEqual(await createCheckRun({ ...run, annotations: [], fetchFn: down }), { outcome: 'failed', reason: 'creating check run: fetch failed' })
    let calls = 0
    const flaky = async (url, init) => {
      calls += 1
      if (calls === 1) return { ok: true, status: 201, json: async () => ({ id: 5, html_url: 'u' }) }
      throw new TypeError('fetch failed')
    }
    assert.deepEqual(await createCheckRun({ ...run, annotations: Array.from({ length: 60 }, (_, i) => finding(i + 1)), fetchFn: flaky }), { outcome: 'failed', reason: 'adding annotations to check run: fetch failed' })
  })

  it('reports any other API failure, and skips without a token', async () => {
    const { fetchFn } = fakeFetch([{ method: 'POST', url: /check-runs$/, status: 422, json: {} }])
    assert.deepEqual(await createCheckRun({ ...run, annotations: [], fetchFn }), { outcome: 'failed', reason: 'creating check run: 422' })
    assert.deepEqual(await createCheckRun({ ...run, token: '', annotations: [] }), { outcome: 'skipped', reason: 'no token' })
  })
})
