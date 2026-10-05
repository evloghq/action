/** One `fetch` against the GitHub REST API, with the headers every call needs. */
export function request(fetchFn, url, token, init = {}) {
  return fetchFn(url, {
    ...init,
    headers: {
      'accept': 'application/vnd.github+json',
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      ...init.headers,
    },
  })
}
