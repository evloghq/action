# evlog action

GitHub Action for `evlog map`. Composite action, plain Node, no build step. The telemetry SDK is installed separately on the runner.

```bash
npm test          # unit tests, node:test
npm run check     # syntax check every module
```

## Layout

```
action.yml            inputs, outputs, the one composite step
src/main.mjs          the run: inputs → packages → baseline → scan → report → comment → outputs → gate
src/lib/              one module per concern (inputs, event, packages, cli, baseline, findings, report, checks, comment, github, outputs)
test/*.test.mjs       unit tests, one file per module
test/fixtures/        small apps the workflow scans: nuxt-app, express-app, hono-app, and a non-package
.github/workflows/    test.yml runs the action against the fixtures on every push and PR; release.yml moves the major tag
```

## Rules

- **The CLI decides, the action delivers.** No rule, threshold, or scoring lives here. If a verdict is wrong, fix `@evlog/cli` in `evloghq/evlog`. The two exceptions mirror the CLI for display and are kept identical to it: `prioritize` in `report.mjs` (the FIX FIRST order) and `findings` in `findings.mjs` (what `--format github` would point at, built from the JSON so one list can feed the Checks API and the workflow-command fallback).
- **No bundled dependencies.** Node 20 provides the action runtime. The exception is the pinned `@evlog/telemetry` SDK, installed in an isolated runner directory with package scripts disabled. Keep its pin under Renovate and never install it into the scanned workspace.
- **Telemetry opt-outs apply to both layers.** `telemetry: false` sets `EVLOG_TELEMETRY=0` before CLI subprocesses run. Otherwise preserve CLI telemetry and honour `DO_NOT_TRACK=1` and `EVLOG_TELEMETRY=0`. Keep action fields in sync with the dashboard ingest allowlist in `evloghq/evlog`.
- **Every input is validated in `inputs.mjs`** and nowhere else. A bad input exits 2 before any scan.
- **Degrade, don't throw, on permissions.** A token that cannot comment is a notice, not a failure; annotations and the summary still stand.
- **Every behaviour has a job in `test.yml`.** A new input or output gets a job that exercises it against a fixture and asserts on `steps.map.outputs`. Unit tests cover the modules; the workflow is the proof the composite step works.
- Code style follows `evloghq/evlog`'s AGENTS.md: no defensive code the surrounding file does not have, no silent fallbacks, comments only for constraints the code cannot express, plain factual prose everywhere.

## Dependencies

Renovate keeps two things current: the SHA-pinned actions in the workflows, and the `@evlog/cli` release pinned as the `version` default in `action.yml` (the `# renovate:` marker above it is what Renovate reads). A CLI bump PR is reviewed like any change, merged, and released with a tag, because it changes what every user's gate sees.

## Releasing

Tag `vX.Y.Z` on `main`. `release.yml` moves `vX` to it and creates the GitHub Release, which is what the Marketplace listing follows. Users ride `@v1`. The `version` default in `action.yml` is the `@evlog/cli` release the action was tested with: bumping it is a change to this repository, released with a tag, never implied by a CLI release.

## Git

Local work is always fine. Pushing, opening pull requests, tagging, and anything on GitHub happens on an explicit instruction only. Never push to `main` directly once it is protected.
