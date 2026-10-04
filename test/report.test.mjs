import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { grade, prioritize, renderReport, verdict } from '../src/lib/report.mjs'

const route = (path, { score = 100, checks = {}, sensitivity = 'none', file = 'src/x.ts', line = 1, id = path } = {}) => ({
  id, method: 'GET', path, file, handler: { line }, score, sensitivity: { level: sensitivity, reasons: [] },
  checks: Object.fromEntries(Object.entries(checks).map(([check, status]) => [check, { status }])),
})

const result = (overrides = {}) => ({
  name: '.', path: '.', framework: 'nuxt', projectName: 'shop', score: 82, status: 'passed', reasons: [],
  summary: { instrumented: 3, partial: 1, dark: 1, exempt: 0 }, routes: [], baseline: undefined, ...overrides,
})

const context = { serverUrl: 'https://github.com', repository: 'acme/shop', sha: 'abc123', cliVersion: '0.8.0' }

describe('grade', () => {
  it('matches the CLI thresholds', () => {
    assert.equal(grade(95), 'excellent')
    assert.equal(grade(75), 'good')
    assert.equal(grade(50), 'needs work')
    assert.equal(grade(49), 'poor')
  })
})

describe('prioritize', () => {
  it('lists gaps only, sensitive first, then lowest score', () => {
    const routes = [
      route('/ok'),
      route('/a', { score: 40, checks: { 'wide-event': 'fail' } }),
      route('/pay', { score: 70, checks: { audit: 'fail' }, sensitivity: 'high' }),
      route('/b', { score: 20, checks: { 'wide-event': 'fail' } }),
    ]
    assert.deepEqual(prioritize(routes).map(r => r.path), ['/pay', '/b', '/a'])
  })
})

describe('verdict', () => {
  it('is the score alone without a baseline', () => {
    assert.equal(verdict([result()]), '**82** good')
  })

  it('names the movement, the ref and the regressions with a baseline', () => {
    const r = result({ score: 56, baseline: { delta: -8, regressions: [{}], fixed: [] } })
    assert.equal(verdict([r], { baselineRef: 'main' }), '**56** needs work · -8 against `main` · 1 regression')
    const ok = result({ baseline: { delta: 0, regressions: [], fixed: [] } })
    assert.equal(verdict([ok], { baselineRef: 'main' }), '**82** good · unchanged against `main` · no regression')
  })

  it('takes the lowest package and counts them', () => {
    assert.equal(verdict([result(), result({ name: 'apps/api', score: 61 })]), '**61** needs work across 2 packages')
  })

  it('says when the threshold was missed', () => {
    assert.equal(verdict([result({ score: 70, reasons: ['below --min-score 80'] })]), '**70** needs work · below min-score 80')
  })
})

describe('renderReport', () => {
  it('writes one row per package and no delta column without a baseline', () => {
    const md = renderReport([result(), result({ name: 'apps/api', framework: 'hono', score: 61 })], context)
    assert.match(md, /^### Observability score\n\n\*\*61\*\* needs work across 2 packages\n/)
    assert.doesNotMatch(md, /<img/)
    assert.match(md, /<sub>Scored by \[evlog map\]\(https:\/\/evlog\.dev\/cli\/map\) v0\.8\.0 through \[evloghq\/action\]/)
    assert.match(md, /\| Package \| Score \| Instrumented \| Partial \| Dark \| Gate \|/)
    assert.match(md, /\| `shop` \(nuxt\) \| \*\*82\*\* good \| 3 \| 1 \| 1 \| passed \|/)
    assert.match(md, /\| `apps\/api` \(hono\) \| \*\*61\*\* needs work /)
    assert.doesNotMatch(md, /Δ/)
    assert.doesNotMatch(md, /### Regressions/)
  })

  it('adds the delta column, the regressions and the fixes with a baseline', () => {
    const md = renderReport([result({
      status: 'failed', reasons: ['regressed'],
      routes: [route('/checkout', { id: 'r1', score: 60, checks: { audit: 'fail' }, sensitivity: 'high', file: 'server/api/checkout.post.ts', line: 3 })],
      baseline: {
        delta: -12,
        regressions: [{ routeId: 'r1', path: '/checkout', method: 'POST', file: 'server/api/checkout.post.ts', check: 'audit', to: 'fail' }],
        fixed: [{ path: '/users', method: 'GET', check: 'wide-event' }],
      },
    })], context)
    assert.match(md, /\| Package \| Score \| Δ \|/)
    assert.match(md, /\| -12 \| 3 \| 1 \| 1 \| failed \(regressed\) \|/)
    assert.match(md, /### Regressions \(1\)/)
    assert.match(md, /`POST \/checkout` \[`server\/api\/checkout\.post\.ts:3`\]\(https:\/\/github\.com\/acme\/shop\/blob\/abc123\/server\/api\/checkout\.post\.ts#L3\): `audit` failing/)
    assert.match(md, /Fixed since the base \(1\)/)
    assert.match(md, /`GET \/users`: `wide-event`/)
  })

  it('prefixes paths with the package directory in a monorepo', () => {
    const md = renderReport([result({ name: 'apps/web', path: 'apps/web', routes: [route('/health', { score: 0, checks: { 'wide-event': 'fail' }, file: 'server/api/health.get.ts' })] })], context)
    assert.match(md, /### Fix first/)
    assert.match(md, /\[`apps\/web\/server\/api\/health\.get\.ts:1`\]\(https:\/\/github\.com\/acme\/shop\/blob\/abc123\/apps\/web\/server\/api\/health\.get\.ts#L1\)/)
  })

  it('links from the repository root when the package sits under working-directory', () => {
    const md = renderReport([result({ name: '.', path: 'services/shop', routes: [route('/health', { score: 0, checks: { 'wide-event': 'fail' }, file: 'src/health.ts' })] })], context)
    assert.match(md, /\[`services\/shop\/src\/health\.ts:1`\]\(https:\/\/github\.com\/acme\/shop\/blob\/abc123\/services\/shop\/src\/health\.ts#L1\)/)
  })

  it('caps fix first at five across packages, worst first', () => {
    const routes = Array.from({ length: 6 }, (_, i) => route(`/r${i}`, { score: i * 10, checks: { 'wide-event': 'fail' } }))
    const md = renderReport([result({ routes: routes.slice(0, 3) }), result({ name: 'apps/api', routes: routes.slice(3) })], context)
    const items = md.split('### Fix first')[1].split('<sub>')[0].trim().split('\n')
    assert.equal(items.length, 5)
    assert.match(items[0], /`GET \/r0`/)
  })

  it('falls back to plain paths without repository context', () => {
    const md = renderReport([result({ routes: [route('/health', { score: 0, checks: { 'wide-event': 'fail' } })] })], { cliVersion: undefined })
    assert.match(md, /`src\/x\.ts:1`: `wide-event`/)
    assert.doesNotMatch(md, /github\.com\/acme/)
    assert.match(md, /Scored by \[evlog map\]\(https:\/\/evlog\.dev\/cli\/map\) through/)
  })
})
