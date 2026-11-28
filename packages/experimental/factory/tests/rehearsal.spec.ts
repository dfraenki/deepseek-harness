import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseGoal } from '../src/goal.ts'
import {
  MAX_TOPIC_ATTEMPTS,
  STUCK_THRESHOLD,
  distillRehearsal,
  isValidSkillName,
  isValidTopic,
  readTopicAttempts,
  rehearsalCoverage,
  runRehearsalAttempt,
  uncoveredMilestones,
} from '../src/rehearsal.ts'

let workspace: string

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-rehearsal-'))
})

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('isValidTopic', () => {
  it('accepts kebab slugs up to 40 characters and rejects the rest', () => {
    expect(isValidTopic('audio-engine')).toBe(true)
    expect(isValidTopic('')).toBe(false)
    expect(isValidTopic('Audio Engine')).toBe(false)
    expect(isValidTopic('-leading')).toBe(false)
    expect(isValidTopic('trailing-')).toBe(false)
    expect(isValidTopic('a'.repeat(41))).toBe(false)
  })
})

describe('isValidSkillName', () => {
  it('accepts kebab slugs up to 60 characters and rejects the rest', () => {
    expect(isValidSkillName('dsh-rehearsed-engine')).toBe(true)
    expect(isValidSkillName('')).toBe(false)
    expect(isValidSkillName('With Spaces')).toBe(false)
    expect(isValidSkillName('a'.repeat(61))).toBe(false)
  })
})

describe('readTopicAttempts', () => {
  it('returns an empty list when the topic has no attempts and skips malformed files', async () => {
    const repo = join(workspace, 'read-attempts')
    await mkdir(join(repo, '.rehearsal-home', 'attempts', 'engine'), { recursive: true })
    expect(await readTopicAttempts(repo, 'engine')).toEqual([])
    expect(await readTopicAttempts(repo, 'missing')).toEqual([])
    await writeFile(join(repo, '.rehearsal-home', 'attempts', 'engine', '1.json'), 'not json')
    await writeFile(join(repo, '.rehearsal-home', 'attempts', 'engine', 'notes.txt'), 'ignored')
    expect(await readTopicAttempts(repo, 'engine')).toEqual([])
  })

  it('fails loud when the topic directory cannot be read', async () => {
    const repo = join(workspace, 'read-eacces')
    const topicDir = join(repo, '.rehearsal-home', 'attempts', 'engine')
    await mkdir(topicDir, { recursive: true })
    await chmod(topicDir, 0o000)
    try {
      await expect(readTopicAttempts(repo, 'engine')).rejects.toThrow()
    } finally {
      await chmod(topicDir, 0o755)
    }
  })
})

describe('runRehearsalAttempt', () => {
  it('validates the topic, approach, hypothesis, milestone, and gates', async () => {
    const repo = join(workspace, 'attempt-validate')
    await mkdir(repo, { recursive: true })
    const options = { repositoryPath: repo, topic: 'engine', approach: 'a', hypothesis: 'h', gates: ['true'] }
    await expect(runRehearsalAttempt({ ...options, topic: 'Bad Topic' })).rejects.toThrow('lowercase kebab slug')
    await expect(runRehearsalAttempt({ ...options, approach: '   ' })).rejects.toThrow('non-empty description')
    await expect(runRehearsalAttempt({ ...options, approach: 'a'.repeat(201) })).rejects.toThrow('non-empty description')
    await expect(runRehearsalAttempt({ ...options, hypothesis: '   ' })).rejects.toThrow('non-empty statement')
    await expect(runRehearsalAttempt({ ...options, gates: [] })).rejects.toThrow('at least one non-empty gate command')
    await expect(runRehearsalAttempt({ ...options, gates: ['  '] })).rejects.toThrow('at least one non-empty gate command')
    await expect(runRehearsalAttempt({ ...options, milestone: 0 })).rejects.toThrow('positive safe integer')
    await expect(runRehearsalAttempt({ ...options, milestone: 1.5 })).rejects.toThrow('positive safe integer')
  })

  it('stops the gates at the first red and records the evidence', async () => {
    const repo = join(workspace, 'attempt-red')
    await mkdir(repo, { recursive: true })
    const report = await runRehearsalAttempt({
      repositoryPath: repo,
      topic: 'engine',
      approach: 'dsp graph',
      hypothesis: 'h',
      gates: ['true', 'false', 'true'],
    })
    expect(report.verdict).toBe('red')
    expect(report.gates).toHaveLength(2)
    expect(report.gates[1]?.ok).toBe(false)
    expect(report.detail).toContain('exited 1')
    const attempts = await readTopicAttempts(repo, 'engine')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.hypothesis).toBe('h')
    expect(attempts[0]?.distilled).toBe(false)
  })

  it('records the milestone declaration on a green attempt', async () => {
    const repo = join(workspace, 'attempt-green')
    await mkdir(repo, { recursive: true })
    const report = await runRehearsalAttempt({
      repositoryPath: repo,
      topic: 'engine',
      approach: 'dsp graph',
      hypothesis: 'h',
      milestone: 2,
      gates: ['true'],
    })
    expect(report).toMatchObject({ verdict: 'green', stuck: false, attemptsUsed: 1, maxAttempts: MAX_TOPIC_ATTEMPTS })
    expect(report.detail).toContain('distill it with rehearsal_distill')
    const attempts = await readTopicAttempts(repo, 'engine')
    expect(attempts[0]?.milestone).toBe(2)
  })

  it('does not count a red attempt when a green one precedes it on the topic', async () => {
    const repo = join(workspace, 'attempt-streak-green')
    await mkdir(repo, { recursive: true })
    await runRehearsalAttempt({ repositoryPath: repo, topic: 'engine', approach: 'a', hypothesis: 'h', gates: ['true'] })
    const report = await runRehearsalAttempt({ repositoryPath: repo, topic: 'engine', approach: 'a', hypothesis: 'h', gates: ['false'] })
    expect(report.verdict).toBe('red')
    expect(report.stuck).toBe(false)
    expect(report.attemptsUsed).toBe(2)
  })

  it('does not count red attempts with different approaches toward the stuck threshold', async () => {
    const repo = join(workspace, 'attempt-streak-approaches')
    await mkdir(repo, { recursive: true })
    await runRehearsalAttempt({ repositoryPath: repo, topic: 'engine', approach: 'a', hypothesis: 'h', gates: ['false'] })
    await runRehearsalAttempt({ repositoryPath: repo, topic: 'engine', approach: 'b', hypothesis: 'h', gates: ['false'] })
    const report = await runRehearsalAttempt({ repositoryPath: repo, topic: 'engine', approach: 'b', hypothesis: 'h', gates: ['true'] })
    expect(report.verdict).toBe('green')
    expect(report.attemptsUsed).toBe(3)
  })
})

describe('distillRehearsal', () => {
  it('validates topic, name, description, and body', async () => {
    const repo = join(workspace, 'distill-validate')
    await mkdir(repo, { recursive: true })
    const options = { repositoryPath: repo, topic: 'engine', name: 'dsh-engine', description: 'd', body: 'b' }
    await expect(distillRehearsal({ ...options, topic: 'Bad' })).rejects.toThrow('lowercase kebab slug')
    await expect(distillRehearsal({ ...options, name: 'Bad Name' })).rejects.toThrow('skill name must be')
    await expect(distillRehearsal({ ...options, description: '   ' })).rejects.toThrow('non-empty one-line summary')
    await expect(distillRehearsal({ ...options, body: '   ' })).rejects.toThrow('non-empty Markdown')
  })

  it('refuses a topic without a green attempt', async () => {
    const repo = join(workspace, 'distill-red')
    await mkdir(repo, { recursive: true })
    await runRehearsalAttempt({ repositoryPath: repo, topic: 'engine', approach: 'a', hypothesis: 'h', gates: ['false'] })
    await expect(distillRehearsal({ repositoryPath: repo, topic: 'engine', name: 'dsh-engine', description: 'd', body: 'b' }))
      .rejects.toThrow('no green rehearsal attempt')
  })

  it('fails loud when the existing skill candidate cannot be read', async () => {
    const repo = join(workspace, 'distill-eacces')
    await mkdir(repo, { recursive: true })
    await runRehearsalAttempt({ repositoryPath: repo, topic: 'engine', approach: 'a', hypothesis: 'h', gates: ['true'] })
    const skillsDir = join(repo, '.rehearsal-home', 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'engine.md'), 'earlier candidate')
    await chmod(skillsDir, 0o000)
    try {
      await expect(distillRehearsal({ repositoryPath: repo, topic: 'engine', name: 'dsh-engine', description: 'd', body: 'b' }))
        .rejects.toThrow()
    } finally {
      await chmod(skillsDir, 0o755)
    }
  })

  it('flattens newlines out of the description', async () => {
    const repo = join(workspace, 'distill-multiline')
    await mkdir(repo, { recursive: true })
    await runRehearsalAttempt({ repositoryPath: repo, topic: 'engine', approach: 'a', hypothesis: 'h', gates: ['true'] })
    await distillRehearsal({ repositoryPath: repo, topic: 'engine', name: 'dsh-engine', description: 'line one\nline two', body: 'b' })
    const skill = await readFile(join(repo, '.rehearsal-home', 'skills', 'engine.md'), 'utf8')
    expect(skill).toContain('description: line one line two')
  })
})

describe('rehearsalCoverage', () => {
  it('reports an empty picture for a checkout without rehearsals', async () => {
    const repo = join(workspace, 'coverage-empty')
    await mkdir(repo, { recursive: true })
    expect(await rehearsalCoverage(repo)).toEqual({ topics: [], skills: [] })
  })

  it('fails loud when the attempts or skills directory cannot be read', async () => {
    const repo = join(workspace, 'coverage-eacces')
    const attemptsDir = join(repo, '.rehearsal-home', 'attempts')
    const skillsDir = join(repo, '.rehearsal-home', 'skills')
    await mkdir(attemptsDir, { recursive: true })
    await mkdir(skillsDir, { recursive: true })
    await chmod(attemptsDir, 0o000)
    try {
      await expect(rehearsalCoverage(repo)).rejects.toThrow()
    } finally {
      await chmod(attemptsDir, 0o755)
    }
    await chmod(skillsDir, 0o000)
    try {
      await expect(rehearsalCoverage(repo)).rejects.toThrow()
    } finally {
      await chmod(skillsDir, 0o755)
    }
  })
})

describe('uncoveredMilestones', () => {
  it('demands green evidence for every goal milestone', async () => {
    const repo = join(workspace, 'coverage-goal')
    await mkdir(repo, { recursive: true })
    const goal = parseGoal('## Milestones\n\n- M1: Engine\n\n- M2: Interface\n\n## Acceptance criteria\n\n- M1: `true` passes\n\n- M2: `true` passes\n')
    expect(await uncoveredMilestones(repo, goal)).toEqual([
      { milestone: 1, title: 'Engine', covered: false },
      { milestone: 2, title: 'Interface', covered: false },
    ])
    await runRehearsalAttempt({ repositoryPath: repo, topic: 'engine', approach: 'a', hypothesis: 'h', milestone: 1, gates: ['true'] })
    await runRehearsalAttempt({ repositoryPath: repo, topic: 'engine-red', approach: 'a', hypothesis: 'h', milestone: 2, gates: ['false'] })
    expect(await uncoveredMilestones(repo, goal)).toEqual([
      { milestone: 2, title: 'Interface', covered: false },
    ])
  })

  it('fails loud when the attempts directory cannot be read', async () => {
    const repo = join(workspace, 'coverage-goal-eacces')
    const attemptsDir = join(repo, '.rehearsal-home', 'attempts')
    await mkdir(attemptsDir, { recursive: true })
    await chmod(attemptsDir, 0o000)
    try {
      const goal = parseGoal('## Milestones\n\n- M1: Engine\n\n## Acceptance criteria\n\n- M1: `true` passes\n')
      await expect(uncoveredMilestones(repo, goal)).rejects.toThrow()
    } finally {
      await chmod(attemptsDir, 0o755)
    }
  })
})

describe('strike thresholds', () => {
  it('exposes the documented defaults', () => {
    expect(MAX_TOPIC_ATTEMPTS).toBe(6)
    expect(STUCK_THRESHOLD).toBe(3)
  })
})
