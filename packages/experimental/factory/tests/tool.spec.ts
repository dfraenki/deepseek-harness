import { execFile } from 'node:child_process'
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
  const getSectionOrder = vi.fn((key: string) => (key === 'TOOL_MUTATION_CHECKPOINT' ? 2660 : key === 'TOOL_MUTATION_RUN' ? 2665 : 2650))
  const register = vi.fn()
  const ctx = {
    systemPrompt: { section, getSectionOrder },
    tools: { register },
  } as unknown as Context
  factory.apply(ctx, config)
  return { ctx, section, getSectionOrder, register }
}

function tool(name: 'spawn_and_mutate' | 'mutation_checkpoint' | 'mutation_run' = 'spawn_and_mutate', config: factory.Config = {}) {
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
})

describe('apply', () => {
  it('registers the explicit-ask policy sections and the three tools', () => {
    const { section, getSectionOrder, register } = setup({ repositoryPath: mother })
    expect(getSectionOrder).toHaveBeenCalledWith('TOOL_SPAWN')
    expect(section).toHaveBeenCalledWith(expect.objectContaining({
      name: 'tool:spawn',
      order: 2650,
      text: expect.stringContaining('ONLY when the human explicitly asks'),
    }))
    expect(section).toHaveBeenCalledTimes(3)
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
    expect(register).toHaveBeenCalledTimes(3)
    expect(tool('spawn_and_mutate').name).toBe('spawn_and_mutate')
    expect(tool('spawn_and_mutate').description).toContain('mutation goal')
    expect(tool('mutation_checkpoint').description).toContain('roll back on the third consecutive failure')
    expect(tool('mutation_run').description).toContain('until the goal reports complete')
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
    const { register } = setup({ repositoryPath: mother })
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
    })
    await expect(readFile(join(target, GOAL_FILE_NAME), 'utf8')).resolves.toContain('synth plugin suite')
    const stored = JSON.parse(await readFile(join(target, SPAWN_RECORD_NAME), 'utf8') as string)
    expect(stored.sourceCommit).toBe(head)
  })

  it('forwards reference paths to the clone', async () => {
    const reference = join(workspace, 'sketch.png')
    await writeFile(reference, 'png bytes')
    const { register } = setup({ repositoryPath: mother })
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
    }) as Array<{ type: string; text: string }>
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('text')
    expect(blocks[0].text).toContain('Clone spawned at /tmp/clone')
    expect(blocks[0].text).toContain('MUTATION_GOAL.md')
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
    await git(clone, ['init'])
    await git(clone, ['config', 'user.name', 'Fixture'])
    await git(clone, ['config', 'user.email', 'fixture@example.test'])
    await writeFile(join(clone, 'README.md'), 'clone\n')
    await git(clone, ['add', '-A'])
    await git(clone, ['commit', '-m', 'spawn baseline'])
    await writeFile(join(clone, 'MUTATION_GOAL.md'), '## Milestones\n\n- M1: Engine\n\n- M2: Interface\n\n## Acceptance criteria\n\n- M1: `echo core > core.ts` builds\n\n- M2: `echo ui > ui.ts` builds\n')
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
    await git(clone, ['init'])
    await git(clone, ['config', 'user.name', 'Fixture'])
    await git(clone, ['config', 'user.email', 'fixture@example.test'])
    await writeFile(join(clone, 'README.md'), 'clone\n')
    await git(clone, ['add', '-A'])
    await git(clone, ['commit', '-m', 'spawn baseline'])
    await writeFile(
      join(clone, 'MUTATION_GOAL.md'),
      '## Milestones\n\n- M1: Engine\n\n- M2: Interface\n\n## Acceptance criteria\n\n- M1: `echo core > core.ts` builds\n\n- M2: `echo ui > ui.ts` builds\n',
    )
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
    await writeFile(join(clone, '.coaches', 'PAUSE'), 'paused\n')
    const run = tool('mutation_run', { repositoryPath: clone })
    const report = await run.execute({}, exec()) as Record<string, unknown>
    expect(report.stoppedBecause).toBe('paused')
    expect(report.rounds).toBe(0)
  })

  it('renders a rounds run that paused before the first checkpoint', () => {
    const run = tool('mutation_run')
    const blocks = run.output.render({}, { rounds: 0, stoppedBecause: 'paused' }) as Array<{ type: string; text: string }>
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toContain('no checkpoint ran')
  })

  it('rejects malformed mutation_run arguments', async () => {
    const run = tool('mutation_run')
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
