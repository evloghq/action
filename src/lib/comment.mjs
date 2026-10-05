import { request } from './github.mjs'

/**
 * One comment per pull request, edited in place on every run.
 *
 * The marker is how the comment is found again; the key lets two workflows
 * (or two matrix legs) keep separate comments.
 */
export function marker(key) {
  return `<!-- evlog-action:${key} -->`
}

/**
 * Create or update the comment. Returns what happened so the caller can say
 * so; a token that cannot write (a fork, read-only workflow permissions) is
 * reported, not thrown: the annotations and the summary still stand.
 *
 * `create: false` only edits a comment that is already there, which is how a
 * gate that failed on the last run and passes now gets its comment updated
 * without a passing run ever starting one.
 */
export async function upsertComment({ event, token, key, body, create = true, fetchFn = fetch }) {
  const { apiUrl, repository, pullRequest } = event
  if (!pullRequest) return { outcome: 'skipped', reason: 'not a pull request' }
  if (!token) return { outcome: 'skipped', reason: 'no token' }
  const tag = marker(key)
  const content = `${tag}\n${body}`
  const base = `${apiUrl}/repos/${repository}/issues/${pullRequest.number}/comments`

  const list = await request(fetchFn, `${base}?per_page=100`, token)
  if (list.status === 401 || list.status === 403) return { outcome: 'skipped', reason: `token cannot read comments (${list.status})` }
  if (!list.ok) return { outcome: 'failed', reason: `listing comments: ${list.status}` }
  const existing = (await list.json()).find(comment => typeof comment.body === 'string' && comment.body.startsWith(tag))
  if (!existing && !create) return { outcome: 'skipped', reason: 'gate passed and no comment to update' }

  const response = existing
    ? await request(fetchFn, `${apiUrl}/repos/${repository}/issues/comments/${existing.id}`, token, { method: 'PATCH', body: JSON.stringify({ body: content }) })
    : await request(fetchFn, base, token, { method: 'POST', body: JSON.stringify({ body: content }) })
  if (response.status === 401 || response.status === 403) {
    return { outcome: 'skipped', reason: 'token cannot write pull request comments; grant `pull-requests: write` or set `comment: false`' }
  }
  if (!response.ok) return { outcome: 'failed', reason: `${existing ? 'updating' : 'creating'} comment: ${response.status}` }
  return { outcome: existing ? 'updated' : 'created', id: (await response.json()).id }
}
