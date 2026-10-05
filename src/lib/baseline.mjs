import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { packageSpec, runMap } from './cli.mjs'
import { toPosix } from './packages.mjs'

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

/**
 * Check the pull request base out next to the workspace so it can be scanned.
 *
 * `--baseline git:<ref>` reads a committed `evlog.map.json`, which most
 * projects do not have. Scanning the base ourselves needs no file in the
 * repository: the comparison is between two scans of the same CLI, so the
 * rule set always matches.
 */
export function checkoutBase({ workspace, ref, log }) {
  const root = git(['rev-parse', '--show-toplevel'], workspace)
  const dir = mkdtempSync(join(tmpdir(), 'evlog-base-'))
  git(['fetch', '--depth=1', 'origin', ref], root)
  git(['worktree', 'add', '--detach', dir, 'FETCH_HEAD'], root)
  log(`baseline: scanning ${ref} (${git(['rev-parse', '--short', 'FETCH_HEAD'], root)})`)
  return { root, dir, cleanup: () => spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: root }) }
}

/**
 * Scan one package at the base and write its map to a file the CLI can take
 * as `--baseline`. A package that does not exist at the base is new and has
 * nothing to regress from.
 *
 * The map itself comes back too: the report needs the base's score per entry
 * point, which the CLI's comparison does not carry.
 */
export function baselineFor({ base, packageDir, version, env }) {
  const packageRel = toPosix(relative(base.root, packageDir))
  const baseDir = resolve(base.dir, packageRel)
  if (!existsSync(join(baseDir, 'package.json'))) return undefined
  const { stdout, status } = runMap({ spec: packageSpec(version), cwd: baseDir, args: ['--json'], env })
  if (status !== 0 && !stdout) return undefined
  const { map } = JSON.parse(stdout)
  const file = join(base.dir, `.evlog-baseline-${packageRel.replace(/[^\w.-]+/g, '_') || 'root'}.json`)
  writeFileSync(file, JSON.stringify(map))
  return { file, map }
}
