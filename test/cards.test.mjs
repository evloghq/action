import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { picture, publishCards, runPayload } from '../src/lib/cards.mjs'
import { renderReport } from '../src/lib/report.mjs'

const result = {
  name: '.', path: '.', framework: 'nuxt', projectName: 'shop', score: 56, status: 'failed', reasons: ['regressed'],
  summary: { instrumented: 1, partial: 0, dark: 1, exempt: 0 },
  routes: [{
    id: 'r1', method: 'POST', path: '/checkout', file: 'server/api/checkout.post.ts', handler: { line: 3 }, score: 75,
    sensitivity: { level: 'high', reasons: ['money: path says "checkout"', 'money: calls stripe'] },
    checks: { 'wide-event': { status: 'pass' }, 'audit': { status: 'fail', message: 'sensitive route without log.audit()' }, 'context': { status: 'fail', suppressed: true } },
    event: { fields: ['cart.items'], audit: [] },
  }],
  baseline: { baselineScore: 68, delta: -12, regressions: [{ routeId: 'r1', path: '/checkout', method: 'POST', file: 'server/api/checkout.post.ts', check: 'audit', to: 'fail' }], fixed: [] },
  baselineRoutes: { r1: 100 },
  baselineEvents: { r1: { fields: ['user.id', 'cart.items'], audit: ['checkout.completed'] } },
}
const pullRequest = { number: 7, base: 'main', baseSha: 'b1', headSha: 'h1' }
const context = { repository: 'acme/shop', serverUrl: 'https://github.com', sha: 'm1', refName: '7/merge', pullRequest, cliVersion: '0.11.2', minScore: 60 }

const cards = {
  outcome: 'created',
  url: 'https://evlog.cloud/r/run1',
  cards: ['report', 'matrix'].map(name => ({ name, alt: `${name} card`, url: `https://evlog.cloud/r/run1/${name}.svg` })),
}

describe('runPayload', () => {
  it('is the pull request against its base branch, with each entry point as the cards draw it', () => {
    const payload = runPayload([result], context)
    assert.equal(payload.branch, 'main')
    assert.equal(payload.sha, 'h1')
    assert.deepEqual(payload.pullRequest, { number: 7, baseSha: 'b1', headSha: 'h1' })
    assert.equal(payload.packages[0].name, 'shop')
    assert.equal(payload.packages[0].baseScore, 68)
    assert.deepEqual(payload.packages[0].routes[0], {
      id: 'r1', method: 'POST', path: '/checkout', file: 'server/api/checkout.post.ts', line: 3, score: 75, baseScore: 100,
      sensitivity: ['money'],
      checks: { 'wide-event': 'pass', 'audit': 'fail', 'context': 'silenced' },
      messages: { audit: 'sensitive route without log.audit()' },
      event: { fields: ['cart.items'], audit: [] },
      baseEvent: { fields: ['user.id', 'cart.items'], audit: ['checkout.completed'] },
    })
  })

  it('is the pushed branch on a push', () => {
    const payload = runPayload([{ ...result, baseline: undefined, baselineRoutes: undefined }], { ...context, pullRequest: undefined, refName: 'main' })
    assert.equal(payload.branch, 'main')
    assert.equal(payload.sha, 'm1')
    assert.equal(payload.pullRequest, undefined)
    assert.equal(payload.packages[0].baseScore, undefined)
    assert.deepEqual(payload.packages[0].regressions, [])
  })
})

describe('publishCards', () => {
  const oidcEnv = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions/req?x=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'req-token' }

  it('proves the repository with an OIDC token for the app audience', async () => {
    const calls = []
    const fetchFn = async (url, init = {}) => {
      calls.push({ url, init })
      if (new URL(url).host === 'token.actions') return { ok: true, status: 200, json: async () => ({ value: 'oidc-jwt' }) }
      return { ok: true, status: 200, json: async () => ({ id: 'run1', url: cards.url, cards: cards.cards }) }
    }
    const outcome = await publishCards({ endpoint: 'https://evlog.cloud/', payload: { repository: 'acme/shop' }, env: oidcEnv, fetchFn })
    assert.equal(calls[0].url, 'https://token.actions/req?x=1&audience=https%3A%2F%2Fevlog.cloud')
    assert.equal(calls[1].url, 'https://evlog.cloud/api/runs')
    assert.equal(calls[1].init.headers.authorization, 'Bearer oidc-jwt')
    assert.equal(outcome.outcome, 'created')
    assert.equal(outcome.cards.length, 2)
  })

  it('names the missing permission when the app refuses a run without a token', async () => {
    const fetchFn = async () => ({ ok: false, status: 401 })
    const outcome = await publishCards({ endpoint: 'https://evlog.cloud', payload: {}, env: {}, fetchFn })
    assert.deepEqual(outcome, { outcome: 'skipped', reason: 'the cards need `id-token: write` to prove the repository' })
  })

  it('reports an unreachable app instead of throwing', async () => {
    const fetchFn = async () => { throw new Error('ECONNREFUSED') }
    const outcome = await publishCards({ endpoint: 'https://evlog.cloud', payload: {}, env: {}, fetchFn })
    assert.equal(outcome.outcome, 'failed')
    assert.match(outcome.reason, /unreachable: ECONNREFUSED/)
  })
})

describe('the report with cards', () => {
  it('opens on the report card, then says what merging drops and why the gate failed, with the diff folded', () => {
    const md = renderReport([result], { ...context, baselineRef: 'main', cards })
    assert.match(md, /^<a href="https:\/\/evlog\.cloud\/r\/run1"><img alt="report card" src="https:\/\/evlog\.cloud\/r\/run1\/report\.svg" width="880"><\/a>\n\n> \[!CAUTION\]\n> \*\*Merging this drops 1 field and 1 audit action from production logs\.\*\*\n> Gate failed: 1 check lost against `main`\n> \[`server\/api\/checkout\.post\.ts:3`\]\(https:\/\/github\.com\/acme\/shop\/pull\/7\/files#diff-[0-9a-f]+R3\)\n\n<details><summary>Wide event diff, 1 entry point<\/summary>\n/)
    assert.ok(md.includes('```diff\n@@ POST /checkout · 100 → 75 @@\n- user.id\n  cart.items\n- audit "checkout.completed"\n```'))
    assert.match(md, /<details><summary>All 1 entry point, fix first<\/summary>\n\n<a [^\n]+matrix\.svg[^\n]+\n\n- `POST \/checkout`/)
    assert.doesNotMatch(md, /### Observability score|instrumented · /)
  })

  it('names an entry point that loses its wide event, and leaves out one that is new', () => {
    const routes = [{ ...result.routes[0], event: undefined }, { ...result.routes[0], id: 'r2', path: '/new' }]
    const md = renderReport([{ ...result, routes }], { ...context, baselineRef: 'main', cards })
    assert.match(md, /Merging this drops 2 fields and 1 audit action from production logs and takes `POST \/checkout` dark\./)
    assert.match(md, /@@ POST \/checkout · 100 → 75 · no wide event after merge @@/)
    assert.doesNotMatch(md, /@@ POST \/new/)
  })

  it('says the gate would fail when it is off, and draws no alert when it passed', () => {
    assert.match(renderReport([result], { ...context, gate: false, baselineRef: 'main', cards }), /> Gate would fail: 1 check lost against `main` \(`gate: false`, the step stays green\)\n/)
    assert.doesNotMatch(renderReport([{ ...result, status: 'passed', reasons: [] }], { ...context, cards }), /\[!CAUTION\]/)
  })

  it('is unchanged without cards', () => {
    const md = renderReport([result], { ...context, baselineRef: 'main' })
    assert.doesNotMatch(md, /<img/)
    assert.match(md, /^### Observability score · 56/)
    assert.match(md, /1 instrumented · 0 partial · 1 dark/)
  })

  it('escapes what goes into attributes', () => {
    assert.match(picture({ alt: 'a "b" & c', url: 'l' }, 'u'), /alt="a &quot;b&quot; &amp; c"/)
  })
})
