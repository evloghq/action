# evlog action

GitHub Action for `evlog map`. Composite action, plain Node, no dependencies, no build step.

```bash
npm test          # unit tests, node:test
npm run check     # syntax check every module
```

## Layout

```
action.yml            inputs, outputs, the one composite step
src/main.mjs          the run: inputs → packages → baseline → scan → report → comment → outputs → gate
src/lib/              one module per concern (inputs, event, packages, cli, baseline, report, comment, outputs)
test/*.test.mjs       unit tests, one file per module
test/fixtures/        small apps the workflow scans: nuxt-app, express-app, hono-app, and a non-package
.github/workflows/    test.yml runs the action against the fixtures on every push and PR; release.yml moves the major tag
```

## Rules

- **The CLI decides, the action delivers.** No rule, threshold, or scoring lives here. If a verdict is wrong, fix `@evlog/cli` in `evloghq/evlog`. The one exception is `prioritize` in `report.mjs`, which mirrors the CLI's FIX FIRST order for display; keep it identical.
- **No dependencies.** Node 20 is what the runner has; `fetch`, `node:test`, `spawnSync` cover everything. A dependency would need a bundle and a `dist/` commit, which is the maintenance this design avoids.
- **Every input is validated in `inputs.mjs`** and nowhere else. A bad input exits 2 before any scan.
- **Degrade, don't throw, on permissions.** A token that cannot comment is a notice, not a failure; annotations and the summary still stand.
- **Every behaviour has a job in `test.yml`.** A new input or output gets a job that exercises it against a fixture and asserts on `steps.map.outputs`. Unit tests cover the modules; the workflow is the proof the composite step works.
- Code style follows `evloghq/evlog`'s AGENTS.md: no defensive code the surrounding file does not have, no silent fallbacks, comments only for constraints the code cannot express, plain factual prose everywhere.

## Dependencies

Renovate keeps two things current: the SHA-pinned actions in the workflows, and the `@evlog/cli` release pinned as the `version` default in `action.yml` (the `# renovate:` marker above it is what Renovate reads). A CLI bump PR is reviewed like any change, merged, and released with a tag, because it changes what every user's gate sees.

## Releasing

Tag `vX.Y.Z` on `main`. `release.yml` moves `vX` to it. Users ride `@v1`. The `version` default in `action.yml` is the `@evlog/cli` release the action was tested with: bumping it is a change to this repository, released with a tag, never implied by a CLI release.

## Git

Local work is always fine. Pushing, opening pull requests, tagging, and anything on GitHub happens on an explicit instruction only. Never push to `main` directly once it is protected.
