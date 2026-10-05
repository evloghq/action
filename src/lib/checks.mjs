import { request } from './github.mjs'

/* The Checks API takes at most this many annotations per request; the rest
   go in updates to the same run. */
const BATCH = 50

/**
 * One check run for the whole action run, on the commit the pull request
 * points at.
 *
 * Workflow commands keep ten annotations per level per step, show the job as
 * their author, and GitHub's current diff view folds them into a counter. A
 * check run has no cap, is listed on the pull request under its own name with
 * the report as its summary, and its annotations are what the diff view and
 * the Checks tab draw. The token needs `checks: write`; when it cannot write,
 * or the API cannot be reached, the caller prints workflow commands instead.
 */
export async function createCheckRun({ event, token, name, headSha, conclusion, title, summary, annotations, fetchFn = fetch }) {
  if (!token) return { outcome: 'skipped', reason: 'no token' }
  const url = `${event.apiUrl}/repos/${event.repository}/check-runs`
  const batches = []
  for (let i = 0; i < annotations.length; i += BATCH) batches.push(annotations.slice(i, i + BATCH).map(toApi))
  const [first = [], ...rest] = batches

  let created
  try {
    created = await request(fetchFn, url, token, {
      method: 'POST',
      body: JSON.stringify({ name, head_sha: headSha, status: 'completed', conclusion, output: { title, summary, annotations: first } }),
    })
  } catch (error) {
    return { outcome: 'failed', reason: `creating check run: ${error.message}` }
  }
  if (created.status === 401 || created.status === 403) {
    return { outcome: 'skipped', reason: 'token cannot write check runs; grant `checks: write` to draw findings on the diff' }
  }
  if (!created.ok) return { outcome: 'failed', reason: `creating check run: ${created.status}` }
  const { id, html_url: htmlUrl } = await created.json()

  for (const batch of rest) {
    let updated
    try {
      updated = await request(fetchFn, `${url}/${id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ output: { title, summary, annotations: batch } }),
      })
    } catch (error) {
      return { outcome: 'failed', reason: `adding annotations to check run: ${error.message}` }
    }
    if (!updated.ok) return { outcome: 'failed', reason: `adding annotations to check run: ${updated.status}` }
  }
  return { outcome: 'created', id, url: htmlUrl, annotations: annotations.length }
}

function toApi(finding) {
  return {
    path: finding.path,
    start_line: finding.line,
    end_line: finding.line,
    annotation_level: finding.level,
    title: finding.title,
    message: finding.message,
  }
}
