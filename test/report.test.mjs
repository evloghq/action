import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { grade, headline, packageLine, plain, prioritize, renderReport, renderSummary, verdict } from '../src/lib/report.mjs'

const route = (path, { score = 100, checks = {}, sensitivity = 'none', file = 'src/x.ts', line = 1, id = path, method = 'GET' } = {}) => ({
  id, method, path, file, handler: { line }, score, sensitivity: { level: sensitivity, reasons: [] },
  checks: Object.fromEntries(Object.entries(checks).map(([check, status]) => [check, typeof status === 'string' ? { status } : status])),
})

const result = (overrides = {}) => ({
  name: '.', path: '.', framework: 'nuxt', projectName: 'shop', score: 82, status: 'passed', reasons: [],
  summary: { instrumented: 3, partial: 1, dark: 1, exempt: 0 }, routes: [], baseline: undefined, ...overrides,
})

const context = { serverUrl: 'https://github.com', repository: 'acme/shop', sha: 'abc123', cliVersion: '0.8.0', minScore: 70 }

const regressed = () => result({
  score: 56, status: 'failed', reasons: ['regressed'],
  routes: [route('/checkout', { id: 'r1', method: 'POST', score: 75, checks: { audit: 'fail' }, sensitivity: 'high', file: 'server/api/checkout.post.ts', line: 3 })],
  baseline: {
    delta: -12,
    regressions: [{ routeId: 'r1', path: '/checkout', method: 'POST', file: 'server/api/checkout.post.ts', check: 'audit', to: 'fail' }],
    fixed: [{ path: '/users', method: 'GET', check: 'wide-event' }],
  },
  baselineRoutes: { r1: 100 },
})

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

describe('headline and verdict', () => {
  it('puts the lowest score in the title', () => {
    assert.equal(headline([result(), result({ name: 'apps/api', score: 61 })]), '### Observability score · 61')
  })

  it('is the grade alone without a baseline', () => {
    assert.equal(verdict([result()]), 'good')
  })

  it('names the movement, the ref and the regressions with a baseline', () => {
    const r = result({ score: 56, baseline: { delta: -8, regressions: [{}], fixed: [] } })
    assert.equal(verdict([r], { baselineRef: 'main' }), 'needs work · -8 against `main` · 1 regression')
    const ok = result({ baseline: { delta: 0, regressions: [], fixed: [] } })
    assert.equal(verdict([ok], { baselineRef: 'main' }), 'good · unchanged against `main` · no regression')
  })

  it('counts the packages and says when the threshold was missed', () => {
    assert.equal(verdict([result(), result({ name: 'apps/api', score: 61 })]), 'needs work across 2 packages')
    assert.equal(verdict([result({ score: 70, reasons: ['below --min-score 80'] })]), 'needs work · below min-score 80')
  })

  it('strips Markdown for a check run title', () => {
    assert.equal(plain('**56** · -8 against `main`'), '56 · -8 against main')
  })
})

describe('packageLine', () => {
  it('reads like the CLI closing line, with the ref in place of the file', () => {
    assert.equal(packageLine(result({ score: 56, reasons: ['below --min-score 80', 'regressed'] }), { baselineRef: 'main' }), 'score 56/100 (needs work): 3 instrumented, 1 partial, 1 dark; below --min-score 80; regressed against main')
    assert.equal(packageLine(result()), 'score 82/100 (good): 3 instrumented, 1 partial, 1 dark')
  })
})

describe('renderReport', () => {
  it('opens on the number and a plain verdict when nothing failed', () => {
    const md = renderReport([result()], context)
    assert.match(md, /^### Observability score · 82\n\ngood\n\n3 instrumented · 1 partial · 1 dark\n/)
    assert.doesNotMatch(md, /\[!CAUTION\]|\[!TIP\]|\[!NOTE\]/)
    assert.doesNotMatch(md, /\| Package \|/)
    assert.match(md, /<sub>\[evlog map\]\(https:\/\/evlog\.dev\/cli\/map\) v0\.8\.0 · \[how the score works\]/)
  })

  it('puts the failure in a caution block with the regression, its movement and a diff link', () => {
    const md = renderReport([regressed()], { ...context, baselineRef: 'main', pullRequest: { number: 7 } })
    assert.match(md, /^### Observability score · 56\n\n> \[!CAUTION\]\n> \*\*needs work · -12 against `main` · 1 regression\*\*\n> - `POST \/checkout` lost `audit` \(100 → 75\) · \[`server\/api\/checkout\.post\.ts:3`\]\(https:\/\/github\.com\/acme\/shop\/pull\/7\/files#diff-[0-9a-f]{64}R3\)\n/)
    assert.match(md, /<details><summary>Fix first \(1\)<\/summary>/)
    assert.match(md, /<details><summary>Fixed since main \(1\)<\/summary>\n\n- `GET \/users`: `wide-event` back/)
  })

  it('says the step stays green when the gate is off', () => {
    const md = renderReport([regressed(), result({ name: 'apps/api' })], { ...context, baselineRef: 'main', gate: false })
    assert.match(md, /\*\* · `gate: false`, the step stays green\n/)
    assert.match(md, /\| would fail \(regressed\) \|/)
  })

  it('celebrates fixes in a tip block when nothing failed', () => {
    const md = renderReport([result({ baseline: { delta: 4, regressions: [], fixed: [{ path: '/users', method: 'GET', check: 'wide-event' }] } })], { ...context, baselineRef: 'main' })
    assert.match(md, /> \[!TIP\]\n> \*\*good · \+4 against `main` · no regression\*\*\n> - `GET \/users`: `wide-event` back\n/)
    assert.doesNotMatch(md, /Fixed since/)
  })

  it('writes the table only for more than one package, with the delta column on a baseline', () => {
    const md = renderReport([result(), result({ name: 'apps/api', framework: 'hono', score: 61, baseline: { delta: -3, regressions: [], fixed: [] } })], context)
    assert.match(md, /\| Package \| Score \| Δ \| Instrumented \| Partial \| Dark \| Gate \|/)
    assert.match(md, /\| `shop` \(nuxt\) \| \*\*82\*\* good \| – \| 3 \| 1 \| 1 \| passed \|/)
    assert.match(md, /\| `apps\/api` \(hono\) \| \*\*61\*\* needs work \| -3 \|/)
    assert.doesNotMatch(md, /3 instrumented · 1 partial/)
  })

  it('suggests a min-score when none is set', () => {
    const md = renderReport([result({ score: 64 })], { ...context, minScore: undefined })
    assert.match(md, /> \[!NOTE\]\n> No `min-score` set\. Add `min-score: 64` to keep today's score from dropping\./)
  })

  it('keeps fix first open without a regression, links from the repository root, and caps at five', () => {
    const routes = Array.from({ length: 6 }, (_, i) => route(`/r${i}`, { score: i * 10, checks: { 'wide-event': 'fail' }, file: 'server/api/health.get.ts' }))
    const md = renderReport([result({ name: 'apps/web', path: 'apps/web', routes: routes.slice(0, 3) }), result({ name: 'apps/api', path: 'apps/api', routes: routes.slice(3) })], context)
    assert.match(md, /<details open><summary>Fix first \(5\)<\/summary>/)
    assert.match(md, /- `GET \/r0` \[`apps\/web\/server\/api\/health\.get\.ts:1`\]\(https:\/\/github\.com\/acme\/shop\/blob\/abc123\/apps\/web\/server\/api\/health\.get\.ts#L1\): `wide-event`/)
    const items = md.split('Fix first (5)</summary>')[1].split('</details>')[0].trim().split('\n')
    assert.equal(items.length, 5)
  })

  it('falls back to plain paths without repository context', () => {
    const md = renderReport([result({ routes: [route('/health', { score: 0, checks: { 'wide-event': 'fail' } })] })], { cliVersion: undefined, minScore: 1 })
    assert.match(md, /`src\/x\.ts:1`: `wide-event`/)
    assert.doesNotMatch(md, /github\.com\/acme/)
    assert.match(md, /<sub>\[evlog map\]\(https:\/\/evlog\.dev\/cli\/map\) · /)
  })
})

describe('renderSummary', () => {
  it('adds one table per package with a cell per check, worst entry point first', () => {
    const r = result({
      routes: [
        route('/users', { id: 'u', checks: { 'wide-event': 'pass', 'context': 'pass', 'audit': 'n/a' } }),
        route('/pay', { id: 'p', method: 'POST', score: 40, sensitivity: 'high', checks: { 'wide-event': 'pass', 'context': 'fail', 'audit': { status: 'n/a', suppressed: true } } }),
      ],
      baselineRoutes: { u: 100, p: 60 },
    })
    const md = renderSummary([r], context)
    assert.match(md, /<details open><summary>`shop` · 2 entry points<\/summary>\n\n\| Entry point \| Score \| Δ \| wide-event \| context \| audit \|\n/)
    const rows = md.split('| --- |')[1].split('\n').filter(line => line.startsWith('| `'))
    assert.match(rows[0], /^\| `POST \/pay` \[`src\/x\.ts:1`\]\([^)]+\) \| 40 \| -20 \| ✓ \| ✗ \| silenced \|$/)
    assert.match(rows[1], /^\| `GET \/users` .* \| 100 \| 0 \| ✓ \| ✓ \| – \|$/)
  })
})
