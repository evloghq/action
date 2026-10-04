import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { marker, upsertComment } from '../src/lib/comment.mjs'

const event = { apiUrl: 'https://api.github.com', repository: 'acme/shop', pullRequest: { number: 7 } }

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

describe('upsertComment', () => {
  it('creates the comment when none carries the marker', async () => {
    const { fetchFn, calls } = fakeFetch([
      { method: 'GET', url: /issues\/7\/comments/, json: [{ id: 1, body: 'unrelated' }] },
      { method: 'POST', url: /issues\/7\/comments$/, status: 201, json: { id: 42 } },
    ])
    const outcome = await upsertComment({ event, token: 't', key: 'default', body: '## evlog map', fetchFn })
    assert.deepEqual(outcome, { outcome: 'created', id: 42 })
    assert.equal(calls[1].body.body, `${marker('default')}\n## evlog map`)
    assert.equal(calls[1].headers.authorization, 'Bearer t')
  })

  it('edits the existing comment in place', async () => {
    const { fetchFn, calls } = fakeFetch([
      { method: 'GET', url: /issues\/7\/comments/, json: [{ id: 9, body: `${marker('default')}\nold` }, { id: 10, body: `${marker('other')}\nother` }] },
      { method: 'PATCH', url: /issues\/comments\/9$/, json: { id: 9 } },
    ])
    const outcome = await upsertComment({ event, token: 't', key: 'default', body: 'new', fetchFn })
    assert.deepEqual(outcome, { outcome: 'updated', id: 9 })
    assert.equal(calls[1].method, 'PATCH')
  })

  it('keeps comments with another key apart', async () => {
    const { fetchFn, calls } = fakeFetch([
      { method: 'GET', url: /comments/, json: [{ id: 10, body: `${marker('other')}\nother` }] },
      { method: 'POST', url: /comments$/, status: 201, json: { id: 11 } },
    ])
    await upsertComment({ event, token: 't', key: 'default', body: 'x', fetchFn })
    assert.equal(calls[1].method, 'POST')
  })

  it('skips, without throwing, when the token cannot write', async () => {
    const { fetchFn } = fakeFetch([
      { method: 'GET', url: /comments/, json: [] },
      { method: 'POST', url: /comments$/, status: 403, json: { message: 'Resource not accessible by integration' } },
    ])
    const outcome = await upsertComment({ event, token: 't', key: 'default', body: 'x', fetchFn })
    assert.equal(outcome.outcome, 'skipped')
    assert.match(outcome.reason, /pull-requests: write/)
  })

  it('skips when the token cannot even read', async () => {
    const { fetchFn } = fakeFetch([{ method: 'GET', url: /comments/, status: 403, json: {} }])
    const outcome = await upsertComment({ event, token: 't', key: 'default', body: 'x', fetchFn })
    assert.equal(outcome.outcome, 'skipped')
  })

  it('reports any other API failure', async () => {
    const { fetchFn } = fakeFetch([
      { method: 'GET', url: /comments/, json: [] },
      { method: 'POST', url: /comments$/, status: 500, json: {} },
    ])
    const outcome = await upsertComment({ event, token: 't', key: 'default', body: 'x', fetchFn })
    assert.deepEqual(outcome, { outcome: 'failed', reason: 'creating comment: 500' })
  })

  it('with create off, updates an existing comment but never starts one', async () => {
    const none = fakeFetch([{ method: 'GET', url: /comments/, json: [] }])
    assert.deepEqual(await upsertComment({ event, token: 't', key: 'default', body: 'x', create: false, fetchFn: none.fetchFn }), { outcome: 'skipped', reason: 'gate passed and no comment to update' })
    assert.equal(none.calls.length, 1)

    const some = fakeFetch([
      { method: 'GET', url: /comments/, json: [{ id: 3, body: `${marker('default')}\nold` }] },
      { method: 'PATCH', url: /issues\/comments\/3$/, json: { id: 3 } },
    ])
    assert.deepEqual(await upsertComment({ event, token: 't', key: 'default', body: 'x', create: false, fetchFn: some.fetchFn }), { outcome: 'updated', id: 3 })
  })

  it('skips outside a pull request and without a token', async () => {
    assert.deepEqual(await upsertComment({ event: { ...event, pullRequest: undefined }, token: 't', key: 'k', body: 'x' }), { outcome: 'skipped', reason: 'not a pull request' })
    assert.deepEqual(await upsertComment({ event, token: '', key: 'k', body: 'x' }), { outcome: 'skipped', reason: 'no token' })
  })
})
