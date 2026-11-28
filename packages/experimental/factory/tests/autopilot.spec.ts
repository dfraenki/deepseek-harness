import { execFile } from 'node:child_process'
import { access, constants, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GOAL_FILE_NAME, SPAWN_RECORD_NAME, commitAll, sha256File } from '../src/spawn.ts'
import {
  LOOP_STATE_NAME,
  MAX_ATTEMPTS,
  MUTATION_LOG_NAME,
  loadLoopState,
  runCheckpoint,
  runGateCommand,
  saveLoopState,
} from '../src/autopilot.ts'

const run = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  return run('git', args, { cwd }).then(({ stdout }) => stdout.trim())
}

function goalFor(criteria: string[]): string {
  return [
    '# Mutation goal',
    '',
    '## Milestones',
    '',
    '- M1: Core engine plugin',
    '- M2: Sequencer surface',
    '',
    '## Acceptance criteria',
    '',
    ...criteria,
    '',
  ].join('\n')
}

let workspace: string

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-factory-loop-'))
})

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

async function makeClone(name: string, goal: string): Promise<string> {
  const clone = join(workspace, name)
  await mkdir(clone, { recursive: true })
  await git(clone, ['init'])
  await git(clone, ['config', 'user.name', 'Fixture'])
  await git(clone, ['config', 'user.email', 'fixture@example.test'])
  await writeFile(join(clone, 'README.md'), 'clone\n')
  await git(clone, ['add', '-A'])
  await git(clone, ['commit', '-m', 'spawn baseline'])
  await writeFile(join(clone, GOAL_FILE_NAME), goal)
  await commitAll(clone, 'write goal')
  return clone
}

describe('runGateCommand', () => {
  it('captures exit codes, duration, and trailing output', async () => {
    const result = await runGateCommand(workspace, 'echo fine; echo boom >&2; exit 3')
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(3)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.outputTail).toContain('boom')
    expect(result.outputTail).toContain('fine')
  })

  it('passes a zero-exit command', async () => {
    const result = await runGateCommand(workspace, 'true')
    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  it('reports a killed command as a red gate with exit code 1', async () => {
    const controller = new AbortController()
    const pending = runGateCommand(workspace, 'sleep 5', controller.signal)
    setTimeout(() => {
      controller.abort()
    }, 30)
    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
  }, 15000)
})

describe('loadLoopState and saveLoopState', () => {
  it('initializes from HEAD and the first milestone when no state exists', async () => {
    const clone = join(workspace, 'state-init')
    await mkdir(clone, { recursive: true })
    await git(clone, ['init'])
    await git(clone, ['config', 'user.name', 'Fixture'])
    await git(clone, ['config', 'user.email', 'fixture@example.test'])
    await writeFile(join(clone, 'README.md'), 'clone\n')
    await git(clone, ['add', '-A'])
    await git(clone, ['commit', '-m', 'spawn baseline'])
    const head = await git(clone, ['rev-parse', 'HEAD'])
    const state = await loadLoopState(clone, 1)
    expect(state).toEqual({ version: 1, currentMilestone: 1, attempts: 0, lastGreenCommit: head })
  })

  it('persists and reloads a saved state', async () => {
    const clone = join(workspace, 'state-roundtrip')
    await mkdir(clone, { recursive: true })
    await git(clone, ['init'])
    await git(clone, ['config', 'user.name', 'Fixture'])
    await git(clone, ['config', 'user.email', 'fixture@example.test'])
    await writeFile(join(clone, 'README.md'), 'clone\n')
    await git(clone, ['add', '-A'])
    await git(clone, ['commit', '-m', 'spawn baseline'])
    const head = await git(clone, ['rev-parse', 'HEAD'])
    await saveLoopState(clone, { version: 1, currentMilestone: 2, attempts: 1, lastGreenCommit: head })
    await expect(loadLoopState(clone, 1)).resolves.toEqual({
      version: 1,
      currentMilestone: 2,
      attempts: 1,
      lastGreenCommit: head,
    })
    await expect(readFile(join(clone, LOOP_STATE_NAME), 'utf8')).resolves.toContain('"version": 1')
  })
})

describe('runCheckpoint', () => {
  it('commits a green milestone, advances, and finishes complete on the last one', async () => {
    const clone = await makeClone('loop-green', goalFor([
      '- M1: `echo engine > engine.ts` engine builds',
      '- M2: `echo sequencer > sequencer.ts` sequencer passes',
    ]))
    const first = await runCheckpoint({ clonePath: clone })
    expect(first.outcome).toBe('committed')
    expect(first.milestone).toBe(1)
    expect(first.attempts).toBe(0)
    expect(first.detail).toContain('next round implements M2')
    expect(await git(clone, ['log', '-1', '--format=%s'])).toBe('Mutation: M1 Core engine plugin')
    expect(await git(clone, ['log', '-1', '--format=%an'])).toBe('Artifork Factory')
    const second = await runCheckpoint({ clonePath: clone })
    expect(second.outcome).toBe('complete')
    expect(second.detail).toContain('every milestone is green')
    await expect(git(clone, ['status', '--porcelain'])).resolves.toBe('')
  })

  it('ends the attempt at the first red gate and counts the strike', async () => {
    const clone = await makeClone('loop-red', goalFor([
      '- M1: `true` first gate',
      '- M1: `exit 7` second gate',
      '- M1: `true` never reached',
    ]))
    const report = await runCheckpoint({ clonePath: clone })
    expect(report.outcome).toBe('failed')
    expect(report.attempts).toBe(1)
    expect(report.gates).toHaveLength(2)
    expect(report.detail).toContain('exited 7')
    expect(report.detail).toContain('attempt 1 of 3')
    const head = await git(clone, ['rev-parse', 'HEAD'])
    expect(report.lastGreenCommit).toBe(head)
  })

  it('rolls back to the last green commit on the third strike and logs the failed approach', async () => {
    const clone = await makeClone('loop-rollback', goalFor(['- M1: `exit 9` broken approach']))
    const green = await git(clone, ['rev-parse', 'HEAD'])
    await saveLoopState(clone, { version: 1, currentMilestone: 1, attempts: MAX_ATTEMPTS - 1, lastGreenCommit: green })
    await writeFile(join(clone, 'broken-plugin.ts'), 'half-written\n')
    const report = await runCheckpoint({ clonePath: clone })
    expect(report.outcome).toBe('rolled-back')
    expect(report.attempts).toBe(0)
    expect(report.lastGreenCommit).toBe(green)
    expect(await git(clone, ['rev-parse', 'HEAD'])).toBe(green)
    const log = await readFile(join(clone, MUTATION_LOG_NAME), 'utf8')
    expect(log).toContain('M1 rolled back')
    expect(log).toContain('different approach')
    expect(log).toContain('exited 9')
    await expect(git(clone, ['status', '--porcelain'])).resolves.toBe('')
    await expect(access(join(clone, 'broken-plugin.ts'), constants.F_OK)).rejects.toThrow()
  })

  it('kills a gate that exceeds its time budget as red with exit code 124', async () => {
    const clone = join(workspace, 'loop-timeout')
    await mkdir(clone, { recursive: true })
    const report = await runGateCommand(clone, 'sleep 5', undefined, 50)
    expect(report.ok).toBe(false)
    expect(report.exitCode).toBe(124)
  })

  it('rejects a goal file that was mutated after spawn', async () => {
    const clone = await makeClone('loop-frozen-bad', goalFor(['- M1: `echo hi > hi.txt` writes']))
    await writeFile(join(clone, SPAWN_RECORD_NAME), `${JSON.stringify({ version: 1, goalSha256: '0'.repeat(64) }, null, 2)}\n`)
    await expect(runCheckpoint({ clonePath: clone })).rejects.toThrow('goal is frozen')
  })

  it('accepts a goal file whose hash still matches the spawn record', async () => {
    const clone = await makeClone('loop-frozen-ok', goalFor(['- M1: `echo hi > hi.txt` writes']))
    const record = { version: 1, goalSha256: await sha256File(join(clone, GOAL_FILE_NAME)) }
    await writeFile(join(clone, SPAWN_RECORD_NAME), `${JSON.stringify(record, null, 2)}\n`)
    const report = await runCheckpoint({ clonePath: clone })
    expect(report.outcome).toBe('committed')
  })

  it('counts a green-but-empty checkpoint as a failed attempt', async () => {
    const clone = await makeClone('loop-empty-green', goalFor(['- M1: `true` no-op gate']))
    const report = await runCheckpoint({ clonePath: clone })
    expect(report.outcome).toBe('failed')
    expect(report.attempts).toBe(1)
    expect(report.detail).toContain('no changes to commit')
  })

  it('rolls back when every strike was green-but-empty', async () => {
    const clone = await makeClone('loop-empty-rollback', goalFor(['- M1: `true` no-op gate']))
    const green = await git(clone, ['rev-parse', 'HEAD'])
    await saveLoopState(clone, { version: 1, currentMilestone: 1, attempts: MAX_ATTEMPTS - 1, lastGreenCommit: green })
    const report = await runCheckpoint({ clonePath: clone })
    expect(report.outcome).toBe('rolled-back')
    const log = await readFile(join(clone, MUTATION_LOG_NAME), 'utf8')
    expect(log).toContain('no work-tree changes')
  })

  it('requires the goal file', async () => {
    const clone = join(workspace, 'loop-nogoal')
    await mkdir(clone, { recursive: true })
    await expect(runCheckpoint({ clonePath: clone })).rejects.toThrow('goal file is missing')
  })

  it('refuses a milestone without executable criteria', async () => {
    const clone = await makeClone('loop-nocriteria', goalFor(['- M2: `true` only M2 gated']))
    await expect(runCheckpoint({ clonePath: clone })).rejects.toThrow('M1 has no executable acceptance criteria')
  })

  it('refuses a saved state pointing at an undefined milestone', async () => {
    const clone = await makeClone('loop-stale', goalFor(['- M1: `true` engine builds']))
    await saveLoopState(clone, { version: 1, currentMilestone: 99, attempts: 0, lastGreenCommit: 'x'.repeat(40) })
    await expect(runCheckpoint({ clonePath: clone })).rejects.toThrow('references milestone M99')
  })

  it('rethrows read errors on the goal file that are not missing-file errors', async () => {
    const clone = await makeClone('loop-eisdir-goal', goalFor(['- M1: `true` engine builds']))
    await rm(join(clone, GOAL_FILE_NAME))
    await mkdir(join(clone, GOAL_FILE_NAME))
    await expect(runCheckpoint({ clonePath: clone })).rejects.toThrow()
  })

  it('rethrows read errors on the spawn record that are not missing-file errors', async () => {
    const clone = await makeClone('loop-eisdir-record', goalFor(['- M1: `true` engine builds']))
    await mkdir(join(clone, SPAWN_RECORD_NAME), { recursive: true })
    await expect(runCheckpoint({ clonePath: clone })).rejects.toThrow()
  })

  it('rethrows read errors on the loop state that are not missing-file errors', async () => {
    const clone = await makeClone('loop-eisdir-state', goalFor(['- M1: `true` engine builds']))
    await mkdir(join(clone, LOOP_STATE_NAME), { recursive: true })
    await expect(runCheckpoint({ clonePath: clone })).rejects.toThrow()
  })
})
