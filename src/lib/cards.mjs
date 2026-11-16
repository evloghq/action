/**
 * Report cards: the run goes to the evlog cloud app, which stores it and
 * renders it as images the comment embeds. The comment's Markdown stays the
 * source of truth; the cards draw the same numbers.
 */

const AUDIENCE = 'https://evlog.cloud'

function checkCell(check) {
  return check.suppressed ? 'silenced' : check.status
}

/** The sensitivity categories the CLI found, `money` out of `money: path says "checkout"`. */
function sensitivity(route) {
  if (route.sensitivity.level === 'none') return []
  return [...new Set(route.sensitivity.reasons.map(reason => reason.split(':')[0]))]
}

/** What the app stores for one run: the CLI's JSON per package, trimmed to what a card draws. */
export function runPayload(results, context) {
  const { repository, serverUrl, sha, refName, pullRequest, cliVersion, minScore, gate = true } = context
  return {
    repository,
    serverUrl,
    sha: pullRequest?.headSha ?? sha,
    branch: pullRequest?.base ?? refName,
    pullRequest: pullRequest && { number: pullRequest.number, baseSha: pullRequest.baseSha, headSha: pullRequest.headSha },
    cliVersion,
    minScore,
    gate,
    packages: results.map(result => ({
      name: result.name === '.' ? result.projectName : result.name,
      framework: result.framework,
      score: result.score,
      status: result.status,
      reasons: result.reasons,
      summary: result.summary,
      baseScore: result.baseline?.baselineScore,
      regressions: result.baseline?.regressions ?? [],
      fixed: result.baseline?.fixed ?? [],
      routes: result.routes.map(route => ({
        id: route.id,
        method: route.method,
        path: route.path,
        file: route.file,
        line: route.handler?.line,
        score: route.score,
        baseScore: result.baselineRoutes?.[route.id],
        sensitivity: sensitivity(route),
        checks: Object.fromEntries(Object.entries(route.checks).map(([id, check]) => [id, checkCell(check)])),
        messages: Object.fromEntries(Object.entries(route.checks).filter(([, check]) => check.status === 'fail' && check.message).map(([id, check]) => [id, check.message])),
        event: route.event,
        baseEvent: result.baselineEvents?.[route.id],
      })),
    })),
  }
}

/**
 * A GitHub Actions OIDC token for the app, which proves the repository the
 * run comes from. Only there with `id-token: write`.
 */
async function oidcToken(env, fetchFn) {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) return undefined
  const url = `${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(AUDIENCE)}`
  const response = await fetchFn(url, { headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } })
  if (!response.ok) return undefined
  return (await response.json()).value
}

/**
 * Post the run. Returns the run page and its cards, or why there are none:
 * the cards add to the comment, so an app that is down or refuses the run is
 * a notice and the comment goes out without them.
 */
export async function publishCards({ endpoint, payload, env = process.env, fetchFn = fetch }) {
  const token = await oidcToken(env, fetchFn)
  let response
  try {
    response = await fetchFn(`${endpoint.replace(/\/$/, '')}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    return { outcome: 'failed', reason: `${endpoint} unreachable: ${error.message}` }
  }
  if (response.status === 401 && !token) return { outcome: 'skipped', reason: 'the cards need `id-token: write` to prove the repository' }
  if (!response.ok) return { outcome: 'failed', reason: `${endpoint} answered ${response.status}` }
  return { outcome: 'created', ...(await response.json()) }
}

const attr = text => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;')

/** One card as GitHub Markdown: the image, linking to the run page. */
export function picture(card, url) {
  return `<a href="${attr(url)}"><img alt="${attr(card.alt)}" src="${attr(card.url)}" width="880"></a>`
}
