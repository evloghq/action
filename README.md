# evlog action

Scores the observability of your entry points with [`evlog map`](https://evlog.dev/cli/map) and puts the findings where the review happens: on the pull request diff, in the job summary, and in one comment that stays up to date.

```yaml
name: observability
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  map:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: evloghq/action@v1
        with:
          min-score: 80
```

That is the whole setup. On a pull request the action scans the base branch too, so a check that used to pass and no longer does fails the job and is drawn on the line that broke it. Nothing has to be committed, no token has to be created: the comment uses the workflow's own token.

## What it does

1. Runs `evlog map` on each package with the pinned `@evlog/cli`.
2. On a pull request, checks the base out next to the workspace, scans it, and compares. Regressions become `::error` annotations on the diff; without a base, the report's FIX FIRST list becomes `::warning` annotations, capped at `limit`.
3. Writes the report to the job summary: one table across packages, regressions, what to fix first, what got fixed.
4. Posts that report as a pull request comment and edits it on every run.
5. Sets outputs (`score`, `delta`, `regressions`, `passed`, `results`) for whatever comes next.
6. Fails the step when a package regressed or scored under `min-score`, unless `gate: false`.

The judgment is the CLI's. The action adds no rule of its own, so `npx evlog map` on your machine and the action on your pull request agree.

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `version` | `0.8.0` | `@evlog/cli` version to run, or a full spec. Defaults to the release this action was tested with; `latest` follows npm. |
| `working-directory` | `.` | Project to scan, relative to the workspace. |
| `packages` | | One directory or glob per line (`apps/*`), each scanned as its own package. |
| `baseline` | `auto` | `auto` scans the pull request base and compares against it. A path or `git:<ref>` is passed to the CLI. `none` disables the comparison. |
| `min-score` | | Fail when a package scores below this number. |
| `limit` | `10` | Most annotations per package; GitHub keeps ten per level per step. |
| `gate` | `true` | `false` reports and sets outputs without failing the step. |
| `annotations` | `true` | Draw findings on the diff. |
| `summary` | `true` | Write the report to the job summary. |
| `comment` | `true` | `true` posts one comment and keeps it updated; `on-failure` only posts when the gate failed, and updates an existing comment either way; `false` posts nothing. Needs `pull-requests: write`; skipped with a notice when the token cannot write (forks). |
| `comment-key` | `default` | Keeps separate comments when the action runs more than once on a pull request. |
| `token` | `${{ github.token }}` | Token for the comment. |

## Outputs

| Output | What it is |
| --- | --- |
| `score` | Lowest package score, 0 to 100. |
| `delta` | Lowest score movement against the baseline; empty without one. |
| `regressions` | Checks that passed on the base and no longer do, every package together. |
| `instrumented`, `partial`, `dark` | Entry point counts, every package together. |
| `passed` | `true` when every package met the gate, whatever `gate` is set to. |
| `results` | JSON, one entry per package: `name`, `framework`, `score`, `status`, `reasons`, `summary`, `delta`, `regressions`, `fixed`. |

## Recipes

### A monorepo

```yaml
      - uses: evloghq/action@v1
        with:
          packages: |
            apps/*
            packages/api
          min-score: 70
```

Each package gets its own row in the report and its own annotations, with paths that resolve from the repository root. A package that does not exist on the base branch is new and has nothing to regress from.

### Report, do not gate yet

```yaml
      - uses: evloghq/action@v1
        with:
          gate: false
```

The step stays green; `passed` and `results` say what a gate would have done. Set `min-score` to today's score once the team has seen a few reports, then raise it as things get fixed.

### Which CLI runs

Each action release pins the `@evlog/cli` it was tested with, so `@v1` is deterministic: a CLI release on npm never moves a verdict under your gate. Upgrading the action upgrades the CLI, in a pull request where a moved score is the point. To run ahead of that:

```yaml
      - uses: evloghq/action@v1
        with:
          version: latest
```

### Run on pushes too

On a push there is no base to compare against, so `baseline: auto` turns the comparison off and the run reports. Pass `baseline: git:origin/main` to compare against a committed `evlog.map.json` instead.

### Comment only when something is wrong

```yaml
      - uses: evloghq/action@v1
        with:
          comment: on-failure
```

A clean pull request gets annotations and a job summary, nothing in the conversation. The comment appears when a check regressed or the score missed `min-score`, and it is updated to the passing state once that is fixed rather than left behind.

### Post as your own bot

The comment is posted with the workflow's token, so it shows as `github-actions`. To post as an app of your own (an "evlog" bot with its avatar), mint a token in the workflow and pass it in:

```yaml
      - uses: actions/create-github-app-token@v2
        id: app
        with:
          app-id: ${{ vars.EVLOG_APP_ID }}
          private-key: ${{ secrets.EVLOG_APP_KEY }}
      - uses: evloghq/action@v1
        with:
          token: ${{ steps.app.outputs.token }}
```

## Frameworks

Everything `evlog map` scans: Nuxt, Nitro, Next.js App Router, TanStack Start, Hono, Express, and Fastify. Detection reads `package.json`; nothing is installed.

## Permissions

`contents: read` to check out. `pull-requests: write` only for the comment; without it the action says so in a notice and everything else still works. Pull requests from forks get a read-only token, so they get annotations and a summary but no comment.
