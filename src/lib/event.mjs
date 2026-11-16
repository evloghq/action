import { readFileSync } from 'node:fs'

/**
 * The parts of the workflow run the action needs: the repository, the pull
 * request when there is one, and where the runner wants outputs written.
 */
export function readEvent(env = process.env) {
  const payload = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {}
  const pr = payload.pull_request
  return {
    name: env.GITHUB_EVENT_NAME ?? '',
    repository: env.GITHUB_REPOSITORY ?? '',
    apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
    serverUrl: env.GITHUB_SERVER_URL ?? 'https://github.com',
    workspace: env.GITHUB_WORKSPACE ?? process.cwd(),
    sha: env.GITHUB_SHA ?? '',
    refName: env.GITHUB_REF_NAME ?? '',
    runId: env.GITHUB_RUN_ID ?? '',
    outputFile: env.GITHUB_OUTPUT,
    summaryFile: env.GITHUB_STEP_SUMMARY,
    pullRequest: pr
      ? { number: pr.number, base: pr.base.ref, baseSha: pr.base.sha, headSha: pr.head.sha }
      : undefined,
  }
}
