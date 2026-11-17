import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { gateArgs, packageSpec, projectCli } from '../src/lib/cli.mjs'

describe('packageSpec', () => {
  it('puts a version on the package name', () => {
    assert.equal(packageSpec('latest'), '@evlog/cli@latest')
    assert.equal(packageSpec('0.8.0'), '@evlog/cli@0.8.0')
  })

  it('passes a URL or a path through as the spec', () => {
    assert.equal(packageSpec('https://pkg.pr.new/@evlog/cli@767'), 'https://pkg.pr.new/@evlog/cli@767')
    assert.equal(packageSpec('../cli'), '../cli')
    assert.equal(packageSpec('file:./cli.tgz'), 'file:./cli.tgz')
  })
})

describe('gateArgs', () => {
  it('is empty with no gate', () => {
    assert.deepEqual(gateArgs({}), [])
  })

  it('carries both gates', () => {
    assert.deepEqual(gateArgs({ minScore: 80, baseline: '/tmp/base.json' }), ['--min-score', '80', '--baseline', '/tmp/base.json'])
  })

  it('keeps a zero threshold', () => {
    assert.deepEqual(gateArgs({ minScore: 0 }), ['--min-score', '0'])
  })
})

describe('projectCli', () => {
  /* A package with `@evlog/cli` installed, and an `npx` that reports the version the spec runs there. */
  async function project({ installed, runs }) {
    const dir = await mkdtemp(join(tmpdir(), 'evlog-action-cli-'))
    await writeFile(join(dir, 'package.json'), '{"name":"app"}')
    if (installed) {
      const cli = join(dir, 'node_modules/@evlog/cli')
      await mkdir(join(cli, 'dist'), { recursive: true })
      await writeFile(join(cli, 'package.json'), JSON.stringify({ name: '@evlog/cli', version: installed, main: './dist/index.mjs', bin: { evlog: './bin/evlog.mjs' } }))
      await writeFile(join(cli, 'dist/index.mjs'), '')
    }
    await mkdir(join(dir, 'stub'))
    await writeFile(join(dir, 'stub/npx'), `#!/bin/sh\necho ${runs}\n`, { mode: 0o755 })
    return { dir, env: { ...process.env, PATH: `${join(dir, 'stub')}:${process.env.PATH}` } }
  }

  it('is the installed CLI when the spec hands off to it', async () => {
    const { dir, env } = await project({ installed: '0.11.2', runs: '0.11.2' })
    assert.deepEqual(projectCli({ spec: '@evlog/cli@1.0.0', cwd: dir, env }), { version: '0.11.2', bin: join(dir, 'node_modules/@evlog/cli/bin/evlog.mjs') })
    await rm(dir, { recursive: true, force: true })
  })

  it('is undefined when the spec runs itself, as a launcher without the hand-off does', async () => {
    const { dir, env } = await project({ installed: '0.11.2', runs: '0.6.3' })
    assert.equal(projectCli({ spec: '@evlog/cli@0.6.3', cwd: dir, env }), undefined)
    await rm(dir, { recursive: true, force: true })
  })

  it('is undefined when the package has no CLI installed', async () => {
    const { dir, env } = await project({ runs: '1.0.0' })
    assert.equal(projectCli({ spec: '@evlog/cli@1.0.0', cwd: dir, env }), undefined)
    await rm(dir, { recursive: true, force: true })
  })
})
