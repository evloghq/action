import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InputError, parsePackages, readInputs, resolveBaseline } from '../src/lib/inputs.mjs'

const env = (overrides = {}) => ({ INPUT_TOKEN: 't', ...overrides })

describe('readInputs', () => {
  it('fills every default when nothing is set', () => {
    const inputs = readInputs(env())
    assert.deepEqual(inputs, {
      command: 'map',
      version: 'latest',
      workingDirectory: '.',
      packages: [],
      baseline: 'auto',
      minScore: undefined,
      limit: 10,
      gate: true,
      annotations: true,
      summary: true,
      comment: 'always',
      commentKey: 'default',
      token: 't',
    })
  })

  it('reads the numbers as numbers', () => {
    const inputs = readInputs(env({ INPUT_MIN_SCORE: '80', INPUT_LIMIT: '3' }))
    assert.equal(inputs.minScore, 80)
    assert.equal(inputs.limit, 3)
  })

  for (const value of ['abc', '-1', '101', '80.5']) {
    it(`rejects min-score ${value}`, () => {
      assert.throws(() => readInputs(env({ INPUT_MIN_SCORE: value })), InputError)
    })
  }

  for (const value of ['0', 'ten', '2.5']) {
    it(`rejects limit ${value}`, () => {
      assert.throws(() => readInputs(env({ INPUT_LIMIT: value })), InputError)
    })
  }

  it('reads the comment modes', () => {
    assert.equal(readInputs(env({ INPUT_COMMENT: 'false' })).comment, 'never')
    assert.equal(readInputs(env({ INPUT_COMMENT: 'on-failure' })).comment, 'on-failure')
    assert.throws(() => readInputs(env({ INPUT_COMMENT: 'sometimes' })), /`comment` must be true, false or on-failure/)
  })

  it('rejects a boolean that is neither true nor false', () => {
    assert.throws(() => readInputs(env({ INPUT_GATE: 'yes' })), /`gate` must be true or false/)
  })

  it('rejects a command it does not know', () => {
    assert.throws(() => readInputs(env({ INPUT_COMMAND: 'doctor' })), /`command` must be one of map/)
  })
})

describe('parsePackages', () => {
  it('reads one pattern per line and drops blanks and comments', () => {
    assert.deepEqual(parsePackages('apps/*\n\n# services\n  packages/api  \n'), ['apps/*', 'packages/api'])
  })
})

describe('resolveBaseline', () => {
  const pr = { pullRequest: { number: 1, base: 'main' } }
  const push = { pullRequest: undefined }

  it('auto scans the base on a pull request', () => {
    assert.deepEqual(resolveBaseline('auto', pr), { mode: 'base', ref: 'main' })
  })

  it('auto does nothing on a push', () => {
    assert.deepEqual(resolveBaseline('auto', push), { mode: 'none' })
  })

  for (const value of ['none', 'false', 'off', '', 'None']) {
    it(`"${value}" disables the comparison`, () => {
      assert.deepEqual(resolveBaseline(value, pr), { mode: 'none' })
    })
  }

  it('anything else is handed to the CLI as written', () => {
    assert.deepEqual(resolveBaseline('git:origin/release', pr), { mode: 'spec', spec: 'git:origin/release' })
    assert.deepEqual(resolveBaseline('reports/evlog.map.json', push), { mode: 'spec', spec: 'reports/evlog.map.json' })
  })
})
