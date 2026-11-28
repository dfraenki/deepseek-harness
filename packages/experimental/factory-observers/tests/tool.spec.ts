import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as observers from '../src/index.ts'
import { saveProposal } from '../src/channel.ts'

interface SetupResult {
  section: ReturnType<typeof vi.fn>
  getSectionOrder: ReturnType<typeof vi.fn>
  register: ReturnType<typeof vi.fn>
}

function setup(config: observers.Config = {}): SetupResult {
  const section = vi.fn()
  const getSectionOrder = vi.fn((key: string) => (key === 'TOOL_FACTORY_OBSERVERS' ? 2670 : 0))
  const register = vi.fn()
  const ctx = {
    systemPrompt: { section, getSectionOrder },
    tools: { register },
  } as unknown as Context
  observers.apply(ctx, config)
  return { section, getSectionOrder, register }
}

type ToolName = 'coach_propose' | 'coach_observe' | 'coach_pause' | 'coach_resume'

function tool(name: ToolName, config: observers.Config = {}) {
  const { register } = setup(config)
  const found = register.mock.calls
    .map(call => call[0] as { name: string })
    .find(registered => registered.name === name)
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

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-observers-tool-'))
})

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('resolveConfig', () => {
  it('defaults to the process working directory and the default budget', () => {
    expect(observers.resolveConfig({})).toEqual({
      repositoryPath: process.cwd(),
      maxSectionChars: 2048,
    })
  })

  it('trims the repository path and accepts a custom budget', () => {
    expect(observers.resolveConfig({ repositoryPath: `  ${workspace}  `, maxSectionChars: 512 }))
      .toEqual({ repositoryPath: workspace, maxSectionChars: 512 })
  })

  it('refuses an empty repository path and a non-positive budget', () => {
    expect(() => observers.resolveConfig({ repositoryPath: '   ' })).toThrow('must not be empty')
    expect(() => observers.resolveConfig({ maxSectionChars: 0 })).toThrow('positive safe integer')
    expect(() => observers.resolveConfig({ maxSectionChars: 1.5 })).toThrow('positive safe integer')
  })
})

describe('apply', () => {
  it('registers the policy section, the governed directive section, and the four tools', () => {
    const { section, getSectionOrder, register } = setup({ repositoryPath: workspace })
    expect(getSectionOrder).toHaveBeenCalledWith('TOOL_FACTORY_OBSERVERS')
    expect(section).toHaveBeenCalledWith(expect.objectContaining({
      name: 'observers:policy',
      order: 2670,
      text: expect.stringContaining('the only observer allowed to pause the loop'),
    }))
    expect(section).toHaveBeenCalledWith(expect.objectContaining({
      name: 'observers:directives',
      order: 2671,
      interpolate: false,
    }))
    const directivesSection = section.mock.calls
      .map(call => call[0] as { name: string; text: () => string })
      .find(registered => registered.name === 'observers:directives')
    expect(directivesSection?.text()).toBe('')
    expect(section).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenCalledTimes(4)
    expect(tool('coach_propose').description).toContain('supersedes')
    expect(tool('coach_observe').description).toContain('pause state')
    expect(tool('coach_pause').description).toContain('Skill master only')
    expect(tool('coach_resume').description).toContain('Skill master only')
  })

  it('composes the directive section from the channel, empty when nothing is governed', async () => {
    const clone = join(workspace, 'directive-clone')
    const empty = observers.directiveSectionText(observers.resolveConfig({ repositoryPath: clone }))
    expect(empty).toBe('')
    await saveProposal(clone, {
      coach: 'skills',
      topic: 'gate-focus',
      evidence: 'repeated red gates',
      directive: 'Focus only on the failing gate.',
    })
    await saveProposal(clone, {
      coach: 'skills',
      topic: 'plugin-recipes',
      evidence: 'two rounds spent rediscovering the defineTool DSL',
      directive: 'Read the plugin-recipes skill before writing the next plugin.',
    })
    const populated = observers.directiveSectionText(observers.resolveConfig({ repositoryPath: clone, maxSectionChars: 200 }))
    expect(populated).toContain('Coach directives for the next round')
    expect(populated).toContain('dropped by the section budget')
    const unbounded = observers.directiveSectionText(observers.resolveConfig({ repositoryPath: clone }))
    expect(unbounded).toContain('[skills/gate-focus]')
    expect(unbounded).toContain('[skills/plugin-recipes]')
    expect(unbounded).not.toContain('dropped by the section budget')
  })

  it('validates propose arguments directly for non-tool callers', () => {
    expect(() => observers.parseProposeArgs(null)).toThrow('must be an object')
    expect(() => observers.parseProposeArgs('nope')).toThrow('must be an object')
    expect(() => observers.parseProposeArgs([])).toThrow('must be an object')
    expect(() => observers.parseProposeArgs({ coach: 'intent' })).toThrow('non-empty topic')
    expect(() => observers.parseProposeArgs({ coach: 'intent', topic: 't', evidence: 'e', directive: 42 }))
      .toThrow('non-empty directive')
    expect(() => observers.requireSkillMaster({ coach: 'skills', reason: 42 })).toThrow('must be a string')
    expect(() => observers.requireSkillMaster(null)).toThrow('must be an object')
    expect(() => observers.requireSkillMaster({ coach: 42 })).toThrow('non-empty coach string')
  })
})

describe('coach_propose', () => {
  it('saves a directive and renders the acceptance', async () => {
    const clone = join(workspace, 'propose')
    const propose = tool('coach_propose', { repositoryPath: clone })
    const result = await propose.execute({
      coach: 'intent',
      topic: 'scope-drift',
      evidence: 'the last three rounds edited files unrelated to M2',
      directive: 'Return to the M2 milestone before touching anything else.',
    }, exec())
    expect(result).toMatchObject({ coach: 'intent', topic: 'scope-drift', seq: 1, accepted: true })
    const rendered = propose.output.render({}, result) as Array<{ type: string; text: string }>
    expect(rendered[0].text).toContain('[intent/scope-drift]')
    expect(rendered[0].text).toContain('seq 1')
  })

  it('rejects malformed arguments and invalid proposals', async () => {
    const propose = tool('coach_propose', { repositoryPath: join(workspace, 'propose-guard') })
    await expect(propose.execute(null, exec())).rejects.toThrow('must be an object')
    await expect(propose.execute({
      coach: 'boss', topic: 't', evidence: 'e', directive: 'd',
    }, exec())).rejects.toThrow('coach must be one of')
    await expect(propose.execute({
      coach: 'intent', topic: 't', evidence: '  ', directive: 'd',
    }, exec())).rejects.toThrow('non-empty observable evidence')
  })
})

describe('coach_observe', () => {
  it('reports an empty channel that is not paused', async () => {
    const observe = tool('coach_observe', { repositoryPath: join(workspace, 'observe-empty') })
    const result = await observe.execute({}, exec())
    expect(result).toEqual({ paused: false, included: 0, dropped: 0, directives: [] })
    const rendered = observe.output.render({}, result) as Array<{ type: string; text: string }>
    expect(rendered[0].text).toContain('not paused')
    const pausedWithoutReason = observe.output.render({}, {
      paused: true,
      included: 1,
      dropped: 0,
      directives: [],
    }) as Array<{ type: string; text: string }>
    expect(pausedWithoutReason[0].text).toContain('paused: ;')
  })

  it('reports governed directives and the pause reason', async () => {
    const clone = join(workspace, 'observe-full')
    const propose = tool('coach_propose', { repositoryPath: clone })
    await propose.execute({
      coach: 'process', topic: 'gate-hygiene', evidence: 'gate exited 7', directive: 'Split the gate.',
    }, exec())
    const pause = tool('coach_pause', { repositoryPath: clone })
    await pause.execute({ coach: 'skills', reason: 'three rollbacks on M2' }, exec())
    const observe = tool('coach_observe', { repositoryPath: clone })
    const result = await observe.execute({}, exec())
    expect(result.paused).toBe(true)
    expect(result.pauseReason).toBe('three rollbacks on M2')
    expect(result.included).toBe(1)
    expect(result.directives).toEqual(['- [process/gate-hygiene] Split the gate. (evidence: gate exited 7)'])
    const rendered = observe.output.render({}, result) as Array<{ type: string; text: string }>
    expect(rendered[0].text).toContain('paused: three rollbacks on M2')
  })
})

describe('coach_pause and coach_resume', () => {
  it('pauses and resumes with the skill master identity', async () => {
    const clone = join(workspace, 'pause-resume')
    const pause = tool('coach_pause', { repositoryPath: clone })
    const result = await pause.execute({ coach: 'skills', reason: 'goal drift detected' }, exec())
    expect(result).toEqual({ paused: true, reason: 'goal drift detected' })
    const rendered = pause.output.render({}, result) as Array<{ type: string; text: string }>
    expect(rendered[0].text).toContain('paused at the next round boundary')
    const resume = tool('coach_resume', { repositoryPath: clone })
    const resumed = await resume.execute({ coach: 'skills' }, exec())
    expect(resumed).toEqual({ paused: false })
    const resumedRender = resume.output.render({}, resumed) as Array<{ type: string; text: string }>
    expect(resumedRender[0].text).toContain('Pause cleared')
  })

  it('refuses the boundary powers to the other coaches and empty reasons', async () => {
    const pause = tool('coach_pause', { repositoryPath: join(workspace, 'pause-guard') })
    await expect(pause.execute({ coach: 'process', reason: 'why not' }, exec()))
      .rejects.toThrow('only the skill master may pause or resume')
    await expect(pause.execute(null, exec())).rejects.toThrow('must be an object')
    expect(() => observers.parsePauseArgs({ coach: 'skills' })).toThrow('must be a string')
    const resume = tool('coach_resume', { repositoryPath: join(workspace, 'pause-guard') })
    await expect(resume.execute({ coach: 'intent' }, exec())).rejects.toThrow('only the skill master')
  })
})
