import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PAUSE_FLAG_NAME, isPaused, runRounds } from '../src/driver.ts'
import { commitAll } from '../src/spawn.ts'

const run = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  return run('git', args, { cwd }).then(({ stdout }) => stdout.trim())
}

const GOAL = '## Milestones\n\n- M1: Core engine plugin\n\n- M2: Interface plugin\n\n## Acceptance criteria\n\n- M1: `echo engine > engine.ts` engine builds\n\n- M2: `echo sequencer > sequencer.ts` sequencer passes\n'

async function makeClone(name: string): Promise<string> {
  const clone = join(workspace, name)
  await mkdir(clone, { recursive: true })
  await git(clone, ['init'])
  await git(clone, ['config', 'user.name', 'Fixture'])
  await git(clone, ['config', 'user.email', 'fixture@example.test'])
  await writeFile(join(clone, 'README.md'), 'clone\n')
  await git(clone, ['add', '-A'])
  await git(clone, ['commit', '-m', 'spawn baseline'])
  await writeFile(join(clone, 'MUTATION_GOAL.md'), GOAL)
  await commitAll(clone, 'write goal')
  return clone
}

let workspace: string

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-factory-driver-'))
})

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('isPaused', () => {
  it('reports false without the flag and true with it', async () => {
    const clone = await makeClone('pause-probe')
    expect(await isPaused(clone)).toBe(false)
    await mkdir(join(clone, '.coaches'), { recursive: true })
    await writeFile(join(clone, PAUSE_FLAG_NAME), 'paused by the skill master\n')
    expect(await isPaused(clone)).toBe(true)
  })
})

describe('runRounds', () => {
  it('runs checkpoints back to back until the goal reports complete', async () => {
    const clone = await makeClone('rounds-complete')
    const report = await runRounds({ clonePath: clone })
    expect(report.stoppedBecause).toBe('complete')
    expect(report.rounds).toBe(2)
    expect(report.lastReport?.outcome).toBe('complete')
    expect(report.lastReport?.milestone).toBe(2)
  })

  it('pauses before the first round when a coach flag is already present', async () => {
    const clone = await makeClone('rounds-paused-early')
    await mkdir(join(clone, '.coaches'), { recursive: true })
    await writeFile(join(clone, PAUSE_FLAG_NAME), 'paused\n')
    const report = await runRounds({ clonePath: clone })
    expect(report.stoppedBecause).toBe('paused')
    expect(report.rounds).toBe(0)
    expect(report.lastReport).toBeUndefined()
  })

  it('pauses at the round boundary when a gate raises the flag', async () => {
    const clone = join(workspace, 'rounds-paused-mid')
    await mkdir(clone, { recursive: true })
    await git(clone, ['init'])
    await git(clone, ['config', 'user.name', 'Fixture'])
    await git(clone, ['config', 'user.email', 'fixture@example.test'])
    await writeFile(join(clone, 'README.md'), 'clone\n')
    await git(clone, ['add', '-A'])
    await git(clone, ['commit', '-m', 'spawn baseline'])
    await writeFile(
      join(clone, 'MUTATION_GOAL.md'),
      [
        '## Milestones',
        '',
        '- M1: Core engine plugin',
        '',
        '- M2: Interface plugin',
        '',
        '## Acceptance criteria',
        '',
        '- M1: `mkdir -p .coaches && touch .coaches/PAUSE && echo engine > engine.ts` engine builds',
        '',
        '- M2: `echo sequencer > sequencer.ts` sequencer passes',
        '',
      ].join('\n'),
    )
    await commitAll(clone, 'write goal')
    const report = await runRounds({ clonePath: clone })
    expect(report.stoppedBecause).toBe('paused')
    expect(report.rounds).toBe(1)
    expect(report.lastReport?.outcome).toBe('committed')
  })

  it('stops when the round budget runs out', async () => {
    const clone = await makeClone('rounds-budget')
    const report = await runRounds({ clonePath: clone, maxRounds: 1 })
    expect(report.stoppedBecause).toBe('max-rounds')
    expect(report.rounds).toBe(1)
    expect(report.lastReport?.outcome).toBe('committed')
  })

  it('stops before any round with a zero budget', async () => {
    const clone = await makeClone('rounds-zero')
    const report = await runRounds({ clonePath: clone, maxRounds: 0 })
    expect(report.stoppedBecause).toBe('max-rounds')
    expect(report.rounds).toBe(0)
    expect(report.lastReport).toBeUndefined()
  })
})
