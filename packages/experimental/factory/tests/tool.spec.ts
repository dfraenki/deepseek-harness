import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as factory from '../src/index.ts'
import { GOAL_FILE_NAME, SPAWN_RECORD_NAME } from '../src/spawn.ts'

const run = promisify(execFile)

const GOAL = '# Mutation goal\n\nBecome a synth plugin suite.\n'

async function git(cwd: string, args: string[]): Promise<string> {
  return run('git', args, { cwd }).then(({ stdout }) => stdout.trim())
}

interface SetupResult {
  ctx: Context
  section: ReturnType<typeof vi.fn>
  getSectionOrder: ReturnType<typeof vi.fn>
  register: ReturnType<typeof vi.fn>
}

function setup(config: factory.Config = {}): SetupResult {
  const section = vi.fn()
  const getSectionOrder = vi.fn((key: string) => (key === 'TOOL_MUTATION_CHECKPOINT' ? 2660 : key === 'TOOL_MUTATION_RUN' ? 2665 : key === 'TOOL_FACTORY_REHEARSAL' ? 2655 : 2650))
  const register = vi.fn()
  const ctx = {
    systemPrompt: { section, getSectionOrder },
    tools: { register },
  } as unknown as Context
  factory.apply(ctx, config)
  return { ctx, section, getSectionOrder, register }
}

function tool(
  name: 'spawn_and_mutate' | 'mutation_checkpoint' | 'mutation_run' | 'rehearsal_attempt' | 'rehearsal_distill' | 'rehearsal_report' = 'spawn_and_mutate',
  config: factory.Config = {},
) {
  const { register } = setup(config)
  const registered = register.mock.calls.map(call => call[0] as { name: string })
  const found = registered.find(tool => tool.name === name)
  if (found === undefined) throw new Error(`tool ${name} was not registered`)
  return found as {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: { schema: unknown; render: (args: unknown, value: unknown) => unknown }
    execute: (args: unknown, exec: { signal: AbortSignal }) => Promise<Record<string, unknown>>
  }
}

function exec(): { signal: AbortSignal } {
  return { signal: new AbortController().signal } as never
}

async function writeSpawnRecordForGoal(clone: string, goal: string): Promise<void> {
  await writeFile(join(clone, SPAWN_RECORD_NAME), `${JSON.stringify({ version: 1, goalSha256: createHash('sha256').update(goal).digest('hex') })}\n`)
}

let workspace: string
let mother: string

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-factory-tool-'))
  mother = join(workspace, 'mother')
  await mkdir(mother, { recursive: true })
  await git(mother, ['init'])
  await git(mother, ['config', 'user.name', 'Fixture'])
  await git(mother, ['config', 'user.email', 'fixture@example.test'])
  await writeFile(join(mother, 'README.md'), 'mother\n')
  await git(mother, ['add', '-A'])
  await git(mother, ['commit', '-m', 'fixture root'])
})

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('resolveConfig', () => {
  it('defaults to the process working directory', () => {
    expect(factory.resolveConfig({})).toEqual({ repositoryPath: process.cwd() })
  })

  it('trims a configured repository path', () => {
    expect(factory.resolveConfig({ repositoryPath: `  ${mother}  ` })).toEqual({ repositoryPath: mother })
  })

  it('refuses an empty repository path', () => {
    expect(() => factory.resolveConfig({ repositoryPath: '   ' })).toThrow('must not be empty')
  })
})

describe('parseArgs', () => {
  it('passes through valid arguments', () => {
    expect(factory.parseArgs({ goalMarkdown: GOAL, targetPath: '/tmp/clone' })).toEqual({
      goalMarkdown: GOAL,
      targetPath: '/tmp/clone',
      referencePaths: undefined,
    })
    expect(factory.parseArgs({ goalMarkdown: GOAL, targetPath: '/tmp/clone', referencePaths: ['a'] })).toEqual({
      goalMarkdown: GOAL,
      targetPath: '/tmp/clone',
      referencePaths: ['a'],
    })
  })

  it('rejects non-object arguments', () => {
    expect(() => factory.parseArgs(null)).toThrow('must be an object')
    expect(() => factory.parseArgs('nope')).toThrow('must be an object')
    expect(() => factory.parseArgs([])).toThrow('must be an object')
  })

  it('rejects an empty goal and an empty target path', () => {
    expect(() => factory.parseArgs({ goalMarkdown: '   ', targetPath: '/tmp/clone' })).toThrow('non-empty goalMarkdown')
    expect(() => factory.parseArgs({ goalMarkdown: GOAL, targetPath: '  ' })).toThrow('non-empty targetPath')
  })

  it('rejects non-string reference entries', () => {
    expect(() => factory.parseArgs({ goalMarkdown: GOAL, targetPath: '/tmp/clone', referencePaths: [42] }))
      .toThrow('array of strings')
  })

  it('passes through the rehearsal coverage gate flag and rejects non-boolean values', () => {
    expect(factory.parseArgs({ goalMarkdown: GOAL, targetPath: '/tmp/clone', requireRehearsalCoverage: true }))
      .toEqual({ goalMarkdown: GOAL, targetPath: '/tmp/clone', requireRehearsalCoverage: true })
    expect(factory.parseArgs({ goalMarkdown: GOAL, targetPath: '/tmp/clone', referencePaths: ['a'], requireRehearsalCoverage: false }))
      .toEqual({ goalMarkdown: GOAL, targetPath: '/tmp/clone', referencePaths: ['a'], requireRehearsalCoverage: false })
    expect(() => factory.parseArgs({ goalMarkdown: GOAL, targetPath: '/tmp/clone', requireRehearsalCoverage: 'yes' }))
      .toThrow('must be a boolean')
  })
})

async function cloneFixture(name: string): Promise<string> {
  const clone = join(workspace, name)
  await mkdir(clone, { recursive: true })
  await writeFile(join(clone, SPAWN_RECORD_NAME), '{}\n')
  return clone
}

describe('apply', () => {
  it('registers the spawn and rehearsal surface in a mother checkout', () => {
    const { section, getSectionOrder, register } = setup({ repositoryPath: mother })
    expect(getSectionOrder).toHaveBeenCalledWith('TOOL_SPAWN')
    expect(getSectionOrder).toHaveBeenCalledWith('TOOL_FACTORY_REHEARSAL')
    expect(section).toHaveBeenCalledWith(expect.objectContaining({
      name: 'tool:spawn',
      order: 2650,
      text: expect.stringContaining('ONLY when the human explicitly asks'),
    }))
    expect(section).toHaveBeenCalledTimes(2)
    expect(section).toHaveBeenCalledWith(expect.objectContaining({
      name: 'rehearsal:policy',
      order: 2655,
      text: expect.stringContaining('Rehearse before you spawn'),
    }))
    expect(register).toHaveBeenCalledTimes(4)
    expect(tool('spawn_and_mutate').name).toBe('spawn_and_mutate')
    expect(tool('spawn_and_mutate').description).toContain('mutation goal')
    expect(tool('rehearsal_attempt').description).toContain('per-topic budget and strike rule')
    expect(tool('rehearsal_distill').description).toContain('ships into every spawned clone')
    expect(tool('rehearsal_report').description).toContain('stuck topics')
  })

  it('registers the loop tools and skips the spawn surface in a clone', async () => {
    const clone = await cloneFixture('apply-clone')
    const { section, register } = setup({ repositoryPath: clone })
    expect(section).toHaveBeenCalledWith(expect.objectContaining({
      name: 'tool:mutation-checkpoint',
      order: 2660,
      text: expect.stringContaining('Never claim a milestone is green without a checkpoint report'),
    }))
    expect(section).toHaveBeenCalledWith(expect.objectContaining({
      name: 'tool:mutation-run',
      order: 2665,
      text: expect.stringContaining('Never use it outside a spawned clone'),
    }))
    expect(section).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenCalledTimes(2)
    expect(tool('mutation_checkpoint', { repositoryPath: clone }).description).toContain('roll back on the third consecutive failure')
    expect(tool('mutation_run', { repositoryPath: clone }).description).toContain('until the goal reports complete')
    const names = register.mock.calls.map(call => (call[0] as { name: string }).name)
    expect(names).not.toContain('spawn_and_mutate')
    expect(names).not.toContain('rehearsal_attempt')
  })
})

describe('parseRunArgs', () => {
  it('defaults to the driver round budget', () => {
    expect(factory.parseRunArgs({})).toEqual({})
    expect(factory.parseRunArgs({ maxRounds: 5 })).toEqual({ maxRounds: 5 })
  })

  it('rejects non-object arguments and invalid budgets', () => {
    expect(() => factory.parseRunArgs(null)).toThrow('must be an object')
    expect(() => factory.parseRunArgs('nope')).toThrow('must be an object')
    expect(() => factory.parseRunArgs([])).toThrow('must be an object')
    expect(() => factory.parseRunArgs({ maxRounds: 0 })).toThrow('positive integer')
    expect(() => factory.parseRunArgs({ maxRounds: 1.5 })).toThrow('positive integer')
    expect(() => factory.parseRunArgs({ maxRounds: 'lots' })).toThrow('positive integer')
  })
})

describe('spawn_and_mutate execute', () => {
  it('spawns a clone from the configured mother and reports the record', async () => {
    setup({ repositoryPath: mother })
    const spawn = tool('spawn_and_mutate', { repositoryPath: mother })
    const target = join(workspace, 'tool-clone')
    const result = await spawn.execute({ goalMarkdown: GOAL, targetPath: target }, exec())
    const head = await git(mother, ['rev-parse', 'HEAD'])
    expect(result).toEqual({
      clonePath: target,
      sourceCommit: head,
      port: expect.any(Number),
      homePath: '.mutation-home',
      goalSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      rehearsedSkills: [],
    })
    await expect(readFile(join(target, GOAL_FILE_NAME), 'utf8')).resolves.toContain('synth plugin suite')
    const stored = JSON.parse(await readFile(join(target, SPAWN_RECORD_NAME), 'utf8') as string)
    expect(stored.sourceCommit).toBe(head)
  })

  it('forwards reference paths to the clone', async () => {
    const reference = join(workspace, 'sketch.png')
    await writeFile(reference, 'png bytes')
    setup({ repositoryPath: mother })
    const spawn = tool('spawn_and_mutate', { repositoryPath: mother })
    const target = join(workspace, 'tool-clone-refs')
    await spawn.execute({ goalMarkdown: GOAL, targetPath: target, referencePaths: [reference] }, exec())
    await expect(readFile(join(target, 'references', 'sketch.png'), 'utf8')).resolves.toBe('png bytes')
  })

  it('renders the result as a single text block', () => {
    const spawn = tool()
    const blocks = spawn.output.render({}, {
      clonePath: '/tmp/clone',
      sourceCommit: 'a'.repeat(40),
      port: 4123,
      homePath: '.mutation-home',
      goalSha256: 'b'.repeat(64),
      rehearsedSkills: [],
    }) as Array<{ type: string; text: string }>
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('text')
    expect(blocks[0].text).toContain('Clone spawned at /tmp/clone')
    expect(blocks[0].text).toContain('MUTATION_GOAL.md')
    const withSkills = spawn.output.render({}, {
      clonePath: '/tmp/clone',
      sourceCommit: 'a'.repeat(40),
      port: 4123,
      homePath: '.mutation-home',
      goalSha256: 'b'.repeat(64),
      rehearsedSkills: ['dsh-rehearsed-synth'],
    }) as Array<{ type: string; text: string }>
    expect(withSkills[0].text).toContain('dsh-rehearsed-synth')
  })

  it('rejects non-object arguments', async () => {
    const spawn = tool()
    await expect(spawn.execute(null, exec())).rejects.toThrow('must be an object')
    await expect(spawn.execute('nope', exec())).rejects.toThrow('must be an object')
    await expect(spawn.execute([], exec())).rejects.toThrow('must be an object')
  })

  it('rejects an empty goal and an empty target path', async () => {
    const spawn = tool()
    await expect(spawn.execute({ goalMarkdown: '   ', targetPath: join(workspace, 'c1') }, exec()))
      .rejects.toThrow('non-empty goalMarkdown')
    await expect(spawn.execute({ goalMarkdown: GOAL, targetPath: '  ' }, exec()))
      .rejects.toThrow('non-empty targetPath')
  })

  it('checkpoints a green milestone inside the clone', async () => {
    const clone = join(workspace, 'tool-loop-clone')
    await mkdir(clone, { recursive: true })
    await writeFile(join(clone, SPAWN_RECORD_NAME), '{}\n')
    await git(clone, ['init'])
    await git(clone, ['config', 'user.name', 'Fixture'])
    await git(clone, ['config', 'user.email', 'fixture@example.test'])
    await writeFile(join(clone, 'README.md'), 'clone\n')
    await git(clone, ['add', '-A'])
    await git(clone, ['commit', '-m', 'spawn baseline'])
    const goal = '## Milestones\n\n- M1: Engine\n\n- M2: Interface\n\n## Acceptance criteria\n\n- M1: `echo core > core.ts` builds\n\n- M2: `echo ui > ui.ts` builds\n'
    await writeSpawnRecordForGoal(clone, goal)
    await writeFile(join(clone, 'MUTATION_GOAL.md'), goal)
    const checkpoint = tool('mutation_checkpoint', { repositoryPath: clone })
    const report = await checkpoint.execute({}, exec()) as Record<string, unknown>
    expect(report.outcome).toBe('committed')
    expect(report.milestone).toBe(1)
    expect(await git(clone, ['log', '-1', '--format=%s'])).toBe('Mutation: M1 Engine')
    const rendered = checkpoint.output.render({}, report) as Array<{ type: string; text: string }>
    expect(rendered[0].text).toContain('committed')
  })

  it('drives rounds to completion inside the clone', async () => {
    const clone = join(workspace, 'tool-run-clone')
    await mkdir(clone, { recursive: true })
    await writeFile(join(clone, SPAWN_RECORD_NAME), '{}\n')
    await git(clone, ['init'])
    await git(clone, ['config', 'user.name', 'Fixture'])
    await git(clone, ['config', 'user.email', 'fixture@example.test'])
    await writeFile(join(clone, 'README.md'), 'clone\n')
    await git(clone, ['add', '-A'])
    await git(clone, ['commit', '-m', 'spawn baseline'])
    const goal = '## Milestones\n\n- M1: Engine\n\n- M2: Interface\n\n## Acceptance criteria\n\n- M1: `echo core > core.ts` builds\n\n- M2: `echo ui > ui.ts` builds\n'
    await writeSpawnRecordForGoal(clone, goal)
    await writeFile(join(clone, 'MUTATION_GOAL.md'), goal)
    const run = tool('mutation_run', { repositoryPath: clone })
    const report = await run.execute({ maxRounds: 8 }, exec()) as Record<string, unknown>
    expect(report.stoppedBecause).toBe('complete')
    expect(report.rounds).toBe(2)
    const rendered = run.output.render({}, report) as Array<{ type: string; text: string }>
    expect(rendered[0].text).toContain('stopped because complete')
    expect(rendered[0].text).toContain('M2')
  })

  it('pauses before the first round when the clone carries a coach pause flag', async () => {
    const clone = join(workspace, 'tool-run-paused')
    await mkdir(join(clone, '.coaches'), { recursive: true })
    await writeFile(join(clone, SPAWN_RECORD_NAME), '{}\n')
    await writeFile(join(clone, '.coaches', 'PAUSE'), 'paused\n')
    const run = tool('mutation_run', { repositoryPath: clone })
    const report = await run.execute({}, exec()) as Record<string, unknown>
    expect(report.stoppedBecause).toBe('paused')
    expect(report.rounds).toBe(0)
  })

  it('renders a rounds run that paused before the first checkpoint', async () => {
    const clone = await cloneFixture('tool-render-clone')
    const run = tool('mutation_run', { repositoryPath: clone })
    const blocks = run.output.render({}, { rounds: 0, stoppedBecause: 'paused' }) as Array<{ type: string; text: string }>
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toContain('no checkpoint ran')
  })

  it('rejects malformed mutation_run arguments', async () => {
    const clone = await cloneFixture('tool-parse-clone')
    const run = tool('mutation_run', { repositoryPath: clone })
    await expect(run.execute(null, exec())).rejects.toThrow('must be an object')
    await expect(run.execute({ maxRounds: 0 }, exec())).rejects.toThrow('positive integer')
  })

  it('rejects malformed reference paths', async () => {
    const spawn = tool()
    await expect(spawn.execute({ goalMarkdown: GOAL, targetPath: join(workspace, 'c2'), referencePaths: 'x' }, exec()))
      .rejects.toThrow('must be an array')
    await expect(spawn.execute({ goalMarkdown: GOAL, targetPath: join(workspace, 'c2'), referencePaths: [42] }, exec()))
      .rejects.toThrow('array of strings')
  })
})

describe('rehearsal tools', () => {
  it('parses attempt and distill arguments', () => {
    expect(factory.parseAttemptArgs({ topic: 'synth', approach: 'a', hypothesis: 'h', gates: ['true'], milestone: 2 }))
      .toEqual({ topic: 'synth', approach: 'a', hypothesis: 'h', milestone: 2, gates: ['true'] })
    expect(factory.parseAttemptArgs({ topic: 'synth', approach: 'a', hypothesis: 'h', gates: ['true'] }))
      .toEqual({ topic: 'synth', approach: 'a', hypothesis: 'h', gates: ['true'] })
    expect(() => factory.parseAttemptArgs(null)).toThrow('must be an object')
    expect(() => factory.parseAttemptArgs('nope')).toThrow('must be an object')
    expect(() => factory.parseAttemptArgs({ topic: 1, approach: 'a', hypothesis: 'h', gates: [] })).toThrow('requires a topic string')
    expect(() => factory.parseAttemptArgs({ topic: 'synth', approach: 1, hypothesis: 'h', gates: [] })).toThrow('requires an approach string')
    expect(() => factory.parseAttemptArgs({ topic: 'synth', approach: 'a', hypothesis: 1, gates: [] })).toThrow('requires a hypothesis string')
    expect(() => factory.parseAttemptArgs({ topic: 'synth', approach: 'a', hypothesis: 'h', milestone: 0, gates: [] })).toThrow('positive safe integer')
    expect(() => factory.parseAttemptArgs({ topic: 'synth', approach: 'a', hypothesis: 'h', gates: 'x' })).toThrow('array of command strings')
    expect(() => factory.parseAttemptArgs({ topic: 'synth', approach: 'a', hypothesis: 'h', gates: [42] })).toThrow('array of command strings')

    expect(factory.parseDistillArgs({ topic: 'synth', name: 'dsh-synth', description: 'd', body: 'b' }))
      .toEqual({ topic: 'synth', name: 'dsh-synth', description: 'd', body: 'b' })
    expect(() => factory.parseDistillArgs(null)).toThrow('must be an object')
    expect(() => factory.parseDistillArgs({ topic: 1, name: 'n', description: 'd', body: 'b' })).toThrow('requires a topic string')
    expect(() => factory.parseDistillArgs({ topic: 'synth', name: 1, description: 'd', body: 'b' })).toThrow('requires a name string')
    expect(() => factory.parseDistillArgs({ topic: 'synth', name: 'n', description: 1, body: 'b' })).toThrow('requires a description string')
    expect(() => factory.parseDistillArgs({ topic: 'synth', name: 'n', description: 'd', body: 1 })).toThrow('requires a body string')
  })

  it('records a green attempt with evidence and distills it into a carried skill', async () => {
    const attempt = tool('rehearsal_attempt', { repositoryPath: mother })
    const green = await attempt.execute(
      { topic: 'engine', approach: 'dsp graph', hypothesis: 'a graph node per voice', gates: ['true'], milestone: 1 },
      exec(),
    ) as Record<string, unknown>
    expect(green).toMatchObject({ topic: 'engine', seq: 1, verdict: 'green', stuck: false, attemptsUsed: 1, maxAttempts: 6 })
    expect((attempt.output.render({}, green) as Array<{ text: string }>)[0].text).toContain('attempt 1 of 6')
    expect((attempt.output.render({}, { ...green, stuck: true }) as Array<{ text: string }>)[0].text).toContain('topic is STUCK')

    const report = await tool('rehearsal_report', { repositoryPath: mother }).execute({}, exec()) as { topics: unknown[]; skills: string[] }
    expect(report.topics).toHaveLength(1)
    expect(report.skills).toEqual([])

    const distill = tool('rehearsal_distill', { repositoryPath: mother })
    const distilled = await distill.execute(
      { topic: 'engine', name: 'dsh-rehearsed-engine', description: 'How to build the engine', body: '# Engine\n' },
      exec(),
    ) as Record<string, unknown>
    expect(distilled).toMatchObject({ topic: 'engine', attemptSeq: 1, superseded: false })
    expect((distill.output.render({}, distilled) as Array<{ text: string }>)[0].text).toContain('dsh-rehearsed-engine')
    await expect(readFile(join(mother, '.rehearsal-home', 'skills', 'engine.md'), 'utf8')).resolves.toContain('name: dsh-rehearsed-engine')

    const superseded = await distill.execute(
      { topic: 'engine', name: 'dsh-rehearsed-engine', description: 'Better', body: '# Engine v2\n' },
      exec(),
    ) as Record<string, unknown>
    expect(superseded.superseded).toBe(true)
    expect((distill.output.render({}, superseded) as Array<{ text: string }>)[0].text)
      .toContain('replaced an earlier distilled skill')
  })

  it('refuses a red-only distill and reports coverage', async () => {
    const attempt = tool('rehearsal_attempt', { repositoryPath: mother })
    const red = await attempt.execute(
      { topic: 'sequencer', approach: 'flat loop', hypothesis: 'a flat loop is enough', gates: ['false'] },
      exec(),
    ) as Record<string, unknown>
    expect(red).toMatchObject({ verdict: 'red', stuck: false })
    expect((attempt.output.render({}, red) as Array<{ text: string }>)[0].text).toContain('exited 1')
    await expect(tool('rehearsal_distill', { repositoryPath: mother }).execute(
      { topic: 'sequencer', name: 'dsh-x', description: 'd', body: 'b' },
      exec(),
    )).rejects.toThrow('no green rehearsal attempt')

    const report = await tool('rehearsal_report', { repositoryPath: mother }).execute({}, exec()) as { skills: string[] }
    expect(report.skills).toContain('engine')

    const rendered = tool('rehearsal_report').output.render({}, {
      topics: [{ topic: 'engine', attempts: 2, green: 1, red: 1, stuck: true, distilled: true }],
      skills: ['engine'],
    }) as Array<{ text: string }>
    expect(rendered[0].text).toContain('engine: 2 attempt(s), 1 green, 1 red, STUCK, distilled')
    expect(rendered[0].text).toContain('Distilled skills: engine')
    const plain = tool('rehearsal_report').output.render({}, {
      topics: [{ topic: 'sequencer', attempts: 1, green: 0, red: 1, stuck: false, distilled: false }],
      skills: [],
    }) as Array<{ text: string }>
    expect(plain[0].text).toContain('sequencer: 1 attempt(s), 0 green, 1 red')
    expect(plain[0].text).not.toContain('Distilled skills:')
    const empty = tool('rehearsal_report').output.render({}, { topics: [], skills: [] }) as Array<{ text: string }>
    expect(empty[0].text).toBe('No rehearsal attempts recorded yet.')
  })

  it('enforces the topic budget and the stuck strike rule', async () => {
    const dir = join(workspace, 'rehearsal-budget')
    await mkdir(dir, { recursive: true })
    const attempt = tool('rehearsal_attempt', { repositoryPath: dir })
    for (let index = 0; index < 3; index++) {
      const report = await attempt.execute(
        { topic: 'mixer', approach: 'same way', hypothesis: 'h', gates: ['false'] },
        exec(),
      ) as Record<string, unknown>
      expect(report.stuck).toBe(index === 2)
    }
    await expect(attempt.execute({ topic: 'mixer', approach: 'same way', hypothesis: 'h', gates: ['true'] }, exec()))
      .rejects.toThrow('topic mixer is stuck')
    await expect(attempt.execute({ topic: 'mixer', approach: 'different way', hypothesis: 'h', gates: ['true'] }, exec()))
      .resolves.toMatchObject({ verdict: 'green', stuck: false })
    for (let index = 0; index < 2; index++) {
      await attempt.execute({ topic: 'mixer', approach: `way ${index}`, hypothesis: 'h', gates: ['true'] }, exec())
    }
    await expect(attempt.execute({ topic: 'mixer', approach: 'another way', hypothesis: 'h', gates: ['true'] }, exec()))
      .rejects.toThrow('budget for topic mixer is exhausted')
  })

  it('gates spawn on rehearsal coverage when required and carries distilled skills', async () => {
    const gatedGoal = '## Milestones\n\n- M1: Engine\n\n## Acceptance criteria\n\n- M1: `echo core > core.ts` builds\n'
    const fresh = join(workspace, 'unrehearsed')
    await mkdir(fresh, { recursive: true })
    const twoMilestones = '## Milestones\n\n- M1: Engine\n\n- M2: Interface\n\n## Acceptance criteria\n\n- M1: `echo a > a.ts` builds\n\n- M2: `echo b > b.ts` builds\n'
    await expect(tool('spawn_and_mutate', { repositoryPath: fresh }).execute(
      { goalMarkdown: twoMilestones, targetPath: join(fresh, 'clone'), requireRehearsalCoverage: true },
      exec(),
    )).rejects.toThrow('M1 (Engine), M2 (Interface) have no green rehearsal attempt')
    await expect(tool('spawn_and_mutate', { repositoryPath: fresh }).execute(
      { goalMarkdown: gatedGoal, targetPath: join(fresh, 'clone'), requireRehearsalCoverage: true },
      exec(),
    )).rejects.toThrow('rehearsal coverage is incomplete')
    const spawn = tool('spawn_and_mutate', { repositoryPath: mother })
    const target = join(workspace, 'gated-clone')
    const result = await spawn.execute({ goalMarkdown: gatedGoal, targetPath: target, requireRehearsalCoverage: true }, exec()) as Record<string, unknown>
    expect(result.rehearsedSkills).toEqual(['dsh-rehearsed-engine'])
    await expect(readFile(join(target, '.agents', 'skills', 'dsh-rehearsed-engine', 'SKILL.md'), 'utf8'))
      .resolves.toContain('# Engine v2')
  })
})
