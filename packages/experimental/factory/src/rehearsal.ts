/**
 * Layer 7 — rehearsal: try candidate approaches against this checkout before
 * spawning, record every attempt with real gate evidence, distill only green
 * approaches into skill candidates, and demand per-milestone coverage at the
 * spawn gate. Deterministic file operations; the expert decides, files carry.
 * @module @deepseek-ai/dsh-experimental-factory/rehearsal
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import type { GateResult } from './autopilot.ts'
import { runGateCommand } from './autopilot.ts'
import type { ParsedGoal } from './goal.ts'
import { REHEARSAL_HOME_NAME, REHEARSAL_SKILLS_DIR_NAME, excludePathFromGit } from './spawn.ts'

/** Mother-relative directory holding one JSON attempt record per rehearsal attempt. */
export const ATTEMPTS_DIR_NAME = join(REHEARSAL_HOME_NAME, 'attempts')

/** Attempt budget per topic before the topic must be distilled or escalated. */
export const MAX_TOPIC_ATTEMPTS = 6

/** Consecutive red attempts on one approach that mark a topic stuck. */
export const STUCK_THRESHOLD = 3

/** One rehearsal gate execution; the same evidence shape the mutation loop uses. */
export type RehearsalGate = GateResult

/** A recorded rehearsal attempt: hypothesis, approach, gate evidence, verdict. */
export interface RehearsalAttempt {
  /** Record format version. */
  readonly version: 1
  /** Kebab-slug capability this attempt rehearsed. */
  readonly topic: string
  /** Attempt number within the topic, starting at 1. */
  readonly seq: number
  /** Short label of the approach that was tried. */
  readonly approach: string
  /** The belief this attempt set out to prove. */
  readonly hypothesis: string
  /** Goal milestone this rehearsal supports, when declared. */
  readonly milestone?: number
  /** Executed gates in order; the first red gate ends the attempt. */
  readonly gates: readonly RehearsalGate[]
  /** Whether every executed gate passed. */
  readonly verdict: 'green' | 'red'
  /** Whether a distilled skill has been written from this attempt. */
  readonly distilled: boolean
  /** ISO timestamp of the attempt. */
  readonly createdAt: string
}

/** The result of one recorded rehearsal attempt. */
export interface RehearsalAttemptReport {
  /** Topic the attempt belongs to. */
  readonly topic: string
  /** Attempt number within the topic. */
  readonly seq: number
  /** Whether the approach validated. */
  readonly verdict: 'green' | 'red'
  /** Whether the topic is now stuck on this approach. */
  readonly stuck: boolean
  /** Attempts recorded on the topic including this one. */
  readonly attemptsUsed: number
  /** Attempt budget per topic. */
  readonly maxAttempts: number
  /** Executed gates in order; the first red gate ends the attempt. */
  readonly gates: readonly RehearsalGate[]
  /** Evidence-backed decision rationale. */
  readonly detail: string
}

/** Options for one recorded rehearsal attempt. */
export interface RehearsalAttemptOptions {
  /** The checkout the rehearsal experiments run against. */
  readonly repositoryPath: string
  /** Kebab-slug capability this attempt rehearses. */
  readonly topic: string
  /** Short label of the approach being tried. */
  readonly approach: string
  /** The belief this attempt sets out to prove. */
  readonly hypothesis: string
  /** Goal milestone this rehearsal supports, when declared. */
  readonly milestone?: number
  /** Gate commands executed in order; the first red gate ends the attempt. */
  readonly gates: readonly string[]
  /** Cancellation signal forwarded to gate commands. */
  readonly signal?: AbortSignal
}

/** Whether a value is a lowercase kebab slug of at most 40 characters. */
export function isValidTopic(value: string): boolean {
  return value.length > 0 && value.length <= 40 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)
}

/** Read every valid attempt record of one topic, in file order; unreadable files are skipped. */
export async function readTopicAttempts(
  repositoryPath: string,
  topic: string,
  signal?: AbortSignal,
): Promise<RehearsalAttempt[]> {
  const dir = join(repositoryPath, ATTEMPTS_DIR_NAME, topic)
  const entries = await readdir(dir).catch((error: unknown): string[] => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  const attempts: RehearsalAttempt[] = []
  for (const entry of entries.filter(name => name.endsWith('.json')).sort()) {
    const attempt = await readAttemptFile(join(dir, entry), signal)
    if (attempt !== null) attempts.push(attempt)
  }
  return attempts
}

async function readAttemptFile(path: string, signal?: AbortSignal): Promise<RehearsalAttempt | null> {
  try {
    return JSON.parse(await readFile(path, { encoding: 'utf8', signal })) as RehearsalAttempt
  } catch {
    return null
  }
}

/** Consecutive red attempts on the last attempt's approach, counted from the end. */
function redStreak(attempts: readonly RehearsalAttempt[]): number {
  const last = attempts.at(-1)
  if (last === undefined || last.verdict !== 'red') return 0
  let streak = 0
  for (const attempt of [...attempts].reverse()) {
    if (attempt.verdict !== 'red' || attempt.approach !== last.approach) break
    streak++
  }
  return streak
}

/** Validate, budget, execute, and record one rehearsal attempt with real gate evidence. */
export async function runRehearsalAttempt(options: RehearsalAttemptOptions): Promise<RehearsalAttemptReport> {
  const { repositoryPath, signal } = options
  if (!isValidTopic(options.topic)) {
    throw new Error('rehearsal topic must be a lowercase kebab slug of at most 40 characters')
  }
  const approach = options.approach.trim()
  if (approach.length === 0 || approach.length > 200) {
    throw new Error('rehearsal approach must be a non-empty description of at most 200 characters')
  }
  const hypothesis = options.hypothesis.trim()
  if (hypothesis.length === 0) {
    throw new Error('rehearsal hypothesis must be a non-empty statement')
  }
  if (options.gates.length === 0 || options.gates.some(gate => gate.trim().length === 0)) {
    throw new Error('rehearsal attempt requires at least one non-empty gate command')
  }
  if (options.milestone !== undefined && (!Number.isSafeInteger(options.milestone) || options.milestone < 1)) {
    throw new Error('rehearsal milestone must be a positive safe integer')
  }
  const previous = await readTopicAttempts(repositoryPath, options.topic, signal)
  if (previous.length >= MAX_TOPIC_ATTEMPTS) {
    throw new Error(
      `rehearsal budget for topic ${options.topic} is exhausted (${MAX_TOPIC_ATTEMPTS} attempts); ` +
      'distill a green attempt with rehearsal_distill or rethink the capability with the coaching channel',
    )
  }
  const last = previous.at(-1)
  const streak = redStreak(previous)
  if (streak >= STUCK_THRESHOLD && last !== undefined && last.approach === approach) {
    throw new Error(
      `topic ${options.topic} is stuck: ${streak} consecutive red attempts on approach "${approach}"; ` +
      'change the approach or escalate to the skill master',
    )
  }
  const gates: RehearsalGate[] = []
  for (const command of options.gates) {
    const result = await runGateCommand(repositoryPath, command, signal)
    gates.push(result)
    if (!result.ok) break
  }
  const redGate = gates.find(gate => !gate.ok)
  const verdict: RehearsalAttempt['verdict'] = redGate === undefined ? 'green' : 'red'
  const seq = previous.length + 1
  const attempt: RehearsalAttempt = {
    version: 1,
    topic: options.topic,
    seq,
    approach,
    hypothesis,
    ...(options.milestone === undefined ? {} : { milestone: options.milestone }),
    gates,
    verdict,
    distilled: false,
    createdAt: new Date().toISOString(),
  }
  const dir = join(repositoryPath, ATTEMPTS_DIR_NAME, options.topic)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${seq}.json`), `${JSON.stringify(attempt, null, 2)}\n`, 'utf8')
  await excludePathFromGit(repositoryPath, REHEARSAL_HOME_NAME, signal)
  const stuck = verdict === 'red' && redStreak([...previous, attempt]) >= STUCK_THRESHOLD
  const detail = redGate === undefined
    ? `approach "${approach}" validated on ${gates.length} green gate(s); distill it with rehearsal_distill`
    : `approach "${approach}" failed: ${redGate.command} exited ${redGate.exitCode}`
  return {
    topic: options.topic,
    seq,
    verdict,
    stuck,
    attemptsUsed: seq,
    maxAttempts: MAX_TOPIC_ATTEMPTS,
    gates,
    detail: stuck ? `${detail}; topic is stuck, change the approach or escalate to the skill master` : detail,
  }
}

/** The result of distilling a green rehearsal attempt into a skill candidate. */
export interface RehearsalDistillReport {
  /** Topic the skill was distilled from. */
  readonly topic: string
  /** Absolute path of the written skill candidate. */
  readonly skillPath: string
  /** Skill name recorded in the frontmatter. */
  readonly name: string
  /** Sequence of the green attempt the skill was distilled from. */
  readonly attemptSeq: number
  /** Whether an earlier distilled skill for the topic was replaced. */
  readonly superseded: boolean
}

/** Options for distilling one green rehearsal attempt into a skill candidate. */
export interface RehearsalDistillOptions {
  /** The checkout holding the rehearsal records. */
  readonly repositoryPath: string
  /** Kebab-slug topic with a green attempt. */
  readonly topic: string
  /** Skill name for the frontmatter; lowercase kebab of at most 60 characters. */
  readonly name: string
  /** One-line description for the frontmatter. */
  readonly description: string
  /** The distilled skill body in Markdown. */
  readonly body: string
  /** Cancellation signal forwarded to file operations. */
  readonly signal?: AbortSignal
}

/**
 * Distill a green rehearsal attempt into a skill candidate under
 * `.rehearsal-home/skills/`; red-only topics are refused, and re-distilling a
 * topic replaces its earlier candidate.
 */
export async function distillRehearsal(options: RehearsalDistillOptions): Promise<RehearsalDistillReport> {
  const { repositoryPath, signal } = options
  if (!isValidTopic(options.topic)) {
    throw new Error('rehearsal topic must be a lowercase kebab slug of at most 40 characters')
  }
  if (!isValidSkillName(options.name)) {
    throw new Error('skill name must be a lowercase kebab slug of at most 60 characters')
  }
  const description = options.description.replaceAll(/[\r\n]+/g, ' ').trim()
  if (description.length === 0) {
    throw new Error('skill description must be a non-empty one-line summary')
  }
  const body = options.body.trim()
  if (body.length === 0) {
    throw new Error('skill body must be a non-empty Markdown document')
  }
  const attempts = await readTopicAttempts(repositoryPath, options.topic, signal)
  const green = attempts.filter(attempt => attempt.verdict === 'green').at(-1)
  if (green === undefined) {
    throw new Error(`topic ${options.topic} has no green rehearsal attempt; validate an approach with rehearsal_attempt first`)
  }
  const skillPath = join(repositoryPath, REHEARSAL_SKILLS_DIR_NAME, `${options.topic}.md`)
  const superseded = await readFile(skillPath, 'utf8').then(() => true, (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  })
  const frontmatter = [
    '---',
    `name: ${options.name}`,
    `description: ${description}`,
    `origin: rehearsal topic ${options.topic}, green attempt seq ${green.seq}`,
    '---',
    '',
    body,
    '',
  ]
  await mkdir(join(repositoryPath, REHEARSAL_SKILLS_DIR_NAME), { recursive: true })
  await writeFile(skillPath, frontmatter.join('\n'), 'utf8')
  await writeFile(
    join(repositoryPath, ATTEMPTS_DIR_NAME, options.topic, `${green.seq}.json`),
    `${JSON.stringify({ ...green, distilled: true }, null, 2)}\n`,
    'utf8',
  )
  return {
    topic: options.topic,
    skillPath,
    name: options.name,
    attemptSeq: green.seq,
    superseded,
  }
}

/** Whether a value is a lowercase kebab slug of at most 60 characters. */
export function isValidSkillName(value: string): boolean {
  return value.length > 0 && value.length <= 60 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)
}

/** Aggregated rehearsal coverage of one topic. */
export interface TopicCoverage {
  /** Topic slug. */
  readonly topic: string
  /** Recorded attempts. */
  readonly attempts: number
  /** Green attempts. */
  readonly green: number
  /** Red attempts. */
  readonly red: number
  /** Whether the topic is stuck on its last approach. */
  readonly stuck: boolean
  /** Whether a distilled skill exists for the topic. */
  readonly distilled: boolean
}

/** The full rehearsal picture of one checkout. */
export interface RehearsalCoverageReport {
  /** Coverage per topic with attempts, in topic order. */
  readonly topics: readonly TopicCoverage[]
  /** Topics with a distilled skill candidate. */
  readonly skills: readonly string[]
}

/** Aggregate every recorded rehearsal attempt and distilled skill of a checkout. */
export async function rehearsalCoverage(
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<RehearsalCoverageReport> {
  const root = join(repositoryPath, ATTEMPTS_DIR_NAME)
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown): Dirent[] => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  const topics: TopicCoverage[] = []
  for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const attempts = await readTopicAttempts(repositoryPath, entry.name, signal)
    const green = attempts.filter(attempt => attempt.verdict === 'green').length
    topics.push({
      topic: entry.name,
      attempts: attempts.length,
      green,
      red: attempts.length - green,
      stuck: redStreak(attempts) >= STUCK_THRESHOLD,
      distilled: attempts.some(attempt => attempt.distilled),
    })
  }
  const skills = await readdir(join(repositoryPath, REHEARSAL_SKILLS_DIR_NAME)).catch((error: unknown): string[] => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  return {
    topics,
    skills: skills.filter(name => name.endsWith('.md')).map(name => name.slice(0, -3)).sort(),
  }
}

/** Coverage of one goal milestone by green rehearsal attempts. */
export interface MilestoneCoverage {
  /** Milestone number from the goal. */
  readonly milestone: number
  /** Milestone title from the goal. */
  readonly title: string
  /** Whether a green attempt declared this milestone. */
  readonly covered: boolean
}

/**
 * Map a parsed goal's milestones against green rehearsal attempts that
 * declared them; the spawn gate refuses to clone while one is uncovered.
 */
export async function uncoveredMilestones(
  repositoryPath: string,
  goal: ParsedGoal,
  signal?: AbortSignal,
): Promise<MilestoneCoverage[]> {
  const root = join(repositoryPath, ATTEMPTS_DIR_NAME)
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown): Dirent[] => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  const greenMilestones = new Set<number>()
  for (const entry of entries.filter(item => item.isDirectory())) {
    const attempts = await readTopicAttempts(repositoryPath, entry.name, signal)
    for (const attempt of attempts) {
      if (attempt.verdict === 'green' && attempt.milestone !== undefined) greenMilestones.add(attempt.milestone)
    }
  }
  return goal.milestones.map(milestone => ({
    milestone: milestone.id,
    title: milestone.title,
    covered: greenMilestones.has(milestone.id),
  })).filter(milestone => !milestone.covered)
}
