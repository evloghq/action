import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findings, workflowCommand } from '../src/lib/findings.mjs'

const route = (path, { score = 100, checks = {}, sensitivity = 'none', file = 'src/x.ts', line = 1, id = path } = {}) => ({
  id, method: 'GET', path, file, handler: { line }, score, sensitivity: { level: sensitivity, reasons: [] }, checks,
})
const fail = (message, evidence) => ({ status: 'fail', message, evidence })

const result = (overrides = {}) => ({ name: '.', path: '.', routes: [], baseline: undefined, ...overrides })

describe('findings', () => {
  it('is the fix-first list as warnings without a baseline, at the evidence line', () => {
    const r = result({ routes: [
      route('/ok'),
      route('/a', { score: 40, checks: { 'wide-event': fail('no wide event', { file: 'src/a.ts', line: 4 }) } }),
      route('/pay', { score: 70, sensitivity: 'high', checks: { audit: fail('sensitive route without log.audit()') } }),
    ] })
    assert.deepEqual(findings(r), [
      { level: 'warning', path: 'src/x.ts', line: 1, check: 'audit', message: 'sensitive route without log.audit()', title: 'evlog map: audit' },
      { level: 'warning', path: 'src/a.ts', line: 4, check: 'wide-event', message: 'no wide event', title: 'evlog map: wide-event' },
    ])
  })

  it('is the regressions as failures with a baseline, nothing else', () => {
    const r = result({
      path: 'apps/web',
      routes: [
        route('/old', { checks: { 'wide-event': fail('pre-existing') } }),
        route('/checkout', { id: 'c', file: 'server/api/checkout.post.ts', checks: { audit: fail('sensitive route without log.audit()', { file: 'server/api/checkout.post.ts', line: 1 }) } }),
        route('/users', { id: 'u', checks: { context: { status: 'n/a', suppressed: true } } }),
      ],
      baseline: { regressions: [
        { routeId: 'c', check: 'audit', to: 'fail' },
        { routeId: 'u', check: 'context', to: 'suppressed' },
        { routeId: 'gone', check: 'audit', to: 'fail' },
      ] },
    })
    assert.deepEqual(findings(r, { baselineRef: 'main' }), [
      { level: 'failure', path: 'apps/web/server/api/checkout.post.ts', line: 1, check: 'audit', message: 'sensitive route without log.audit()', title: 'evlog map: audit' },
      { level: 'failure', path: 'apps/web/src/x.ts', line: 1, check: 'context', message: 'context passed on main and is now silenced', title: 'evlog map: context' },
    ])
  })
})

describe('workflowCommand', () => {
  it('writes the finding as GitHub reads it, escaped', () => {
    assert.equal(
      workflowCommand({ level: 'failure', path: 'src/a.ts', line: 4, title: 'evlog map: audit', message: 'no log.audit()\n50% done' }),
      '::error file=src/a.ts,line=4,title=evlog map%3A audit::no log.audit()%0A50%25 done',
    )
    assert.match(workflowCommand({ level: 'warning', path: 'a', line: 1, title: 't', message: 'm' }), /^::warning /)
  })
})
