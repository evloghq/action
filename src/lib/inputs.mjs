/**
 * Read the action's inputs off the environment the composite step sets.
 *
 * Every input is a string on the way in; this is the one place that turns
 * them into values the rest of the action can trust.
 */

const COMMANDS = ['map']
const BASELINE_OFF = ['none', 'false', 'off', '']
const COMMENT_MODES = { true: 'always', false: 'never', 'on-failure': 'on-failure' }

export class InputError extends Error {}

function bool(name, raw) {
  const value = raw.trim().toLowerCase()
  if (value === 'true') return true
  if (value === 'false') return false
  throw new InputError(`Input \`${name}\` must be true or false, got "${raw}"`)
}

function integer(name, raw, { min, max }) {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    throw new InputError(`Input \`${name}\` must be a whole number${max === undefined ? ` of ${min} or more` : ` between ${min} and ${max}`}, got "${raw}"`)
  }
  return value
}

function commentMode(raw) {
  const mode = COMMENT_MODES[raw.trim().toLowerCase() || 'true']
  if (!mode) throw new InputError(`Input \`comment\` must be true, false or on-failure, got "${raw}"`)
  return mode
}

/** Lines of `packages`, trimmed, comments and blanks dropped. */
export function parsePackages(raw) {
  return raw.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
}

/**
 * What `baseline` asks for.
 *
 * `auto` only means something on a pull request, where there is a base to
 * scan; on a push there is nothing to compare against and the run just reports.
 */
export function resolveBaseline(raw, event) {
  const value = raw.trim()
  if (BASELINE_OFF.includes(value.toLowerCase())) return { mode: 'none' }
  if (value === 'auto') {
    return event.pullRequest ? { mode: 'base', ref: event.pullRequest.base } : { mode: 'none' }
  }
  return { mode: 'spec', spec: value }
}

export function readInputs(env = process.env) {
  const get = name => env[`INPUT_${name}`] ?? ''
  const command = get('COMMAND').trim() || 'map'
  if (!COMMANDS.includes(command)) throw new InputError(`Input \`command\` must be one of ${COMMANDS.join(', ')}, got "${command}"`)
  const minScoreRaw = get('MIN_SCORE').trim()
  return {
    command,
    version: get('VERSION').trim() || 'latest',
    workingDirectory: get('WORKING_DIRECTORY').trim() || '.',
    packages: parsePackages(get('PACKAGES')),
    baseline: get('BASELINE').trim() || 'auto',
    minScore: minScoreRaw === '' ? undefined : integer('min-score', minScoreRaw, { min: 0, max: 100 }),
    limit: integer('limit', get('LIMIT').trim() || '10', { min: 1 }),
    telemetry: bool('telemetry', get('TELEMETRY') || 'true'),
    gate: bool('gate', get('GATE') || 'true'),
    annotations: bool('annotations', get('ANNOTATIONS') || 'true'),
    summary: bool('summary', get('SUMMARY') || 'true'),
    comment: commentMode(get('COMMENT')),
    commentKey: get('COMMENT_KEY').trim() || 'default',
    token: get('TOKEN'),
  }
}
