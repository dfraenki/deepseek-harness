/**
 * Model-facing factory tools: `spawn_and_mutate` replicates the running
 * checkout into an isolated clone, `mutation_checkpoint` verifies and commits
 * one milestone with git-protected strikes, and `mutation_run` drives those
 * checkpoints back to back until the goal reports complete. Explicit-ask only.
 * @module @deepseek-ai/dsh-experimental-factory
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { CheckpointReport } from './autopilot.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runCheckpoint } from './autopilot.ts'
import type { RoundsReport } from './driver.ts'
import { DEFAULT_MAX_ROUNDS, runRounds } from './driver.ts'
import { parseGoal } from './goal.ts'
import type { RehearsalAttemptReport, RehearsalCoverageReport, RehearsalDistillReport } from './rehearsal.ts'
import { distillRehearsal, runRehearsalAttempt, rehearsalCoverage, uncoveredMilestones } from './rehearsal.ts'
import { GOAL_FILE_NAME, SPAWN_RECORD_NAME, spawnClone } from './spawn.ts'

export {
  MUTATION_HOME_NAME,
  REHEARSAL_HOME_NAME,
  REHEARSAL_SKILLS_DIR_NAME,
  SPAWN_RECORD_NAME,
  copyRehearsalSkills,
  readSpawnRecord,
  resolveFreePort,
  writeSpawnRecord,
  type SpawnOutcome,
  type SpawnRecord,
} from './spawn.ts'

export {
  ATTEMPTS_DIR_NAME,
  MAX_TOPIC_ATTEMPTS,
  STUCK_THRESHOLD,
  distillRehearsal,
  isValidSkillName,
  isValidTopic,
  readTopicAttempts,
  rehearsalCoverage,
  runRehearsalAttempt,
  uncoveredMilestones,
  type RehearsalAttempt,
  type RehearsalAttemptOptions,
  type RehearsalAttemptReport,
  type RehearsalCoverageReport,
  type RehearsalDistillOptions,
  type RehearsalDistillReport,
  type TopicCoverage,
} from './rehearsal.ts'

export const name = 'tool-spawn'
export const inject = ['tools', 'systemPrompt']

/** Deployment policy for the spawn tool. */
export interface Config {
  /** The mother checkout to replicate; defaults to the process working directory. */
  repositoryPath?: string
}

/** Schemastery configuration for the spawn tool. */
export const Config: z<Config> = z.object({
  repositoryPath: z.string(),
})

interface ResolvedConfig {
  readonly repositoryPath: string
}

/** Validate defaults even when a caller invokes apply() without Loader normalization. */
export function resolveConfig(config: Config): ResolvedConfig {
  const repositoryPath = config.repositoryPath?.trim() ?? process.cwd()
  if (repositoryPath.length === 0) throw new Error('factory repositoryPath must not be empty')
  return { repositoryPath }
}

const DESCRIPTION = [
  'Spawn an isolated clone of this repository that will transform itself into a target application.',
  'Provide the complete mutation goal in natural language (identity, domain, experience, features, milestones, acceptance criteria).',
  'The clone starts on its own git history, home directory, and port; the current checkout is never modified.',
  'Use only when the human explicitly asks to spawn, replicate, or transform the factory itself.',
].join(' ')

interface SpawnCallArgs {
  goalMarkdown: string
  targetPath: string
  referencePaths?: string[]
  requireRehearsalCoverage?: boolean
}

export function parseArgs(args: unknown): SpawnCallArgs {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('spawn_and_mutate arguments must be an object')
  }
  const record = args as Record<string, unknown>
  const goalMarkdown = record.goalMarkdown
  const targetPath = record.targetPath
  if (typeof goalMarkdown !== 'string' || goalMarkdown.trim().length === 0) {
    throw new Error('spawn_and_mutate requires a non-empty goalMarkdown string')
  }
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    throw new Error('spawn_and_mutate requires a non-empty targetPath string')
  }
  const referencePaths = record.referencePaths
  if (referencePaths !== undefined && (referencePaths as unknown[]).some(entry => typeof entry !== 'string')) {
    throw new Error('spawn_and_mutate referencePaths must be an array of strings')
  }
  const requireRehearsalCoverage = record.requireRehearsalCoverage
  if (requireRehearsalCoverage !== undefined && typeof requireRehearsalCoverage !== 'boolean') {
    throw new Error('spawn_and_mutate requireRehearsalCoverage must be a boolean')
  }
  if (referencePaths === undefined) {
    return requireRehearsalCoverage === undefined
      ? { goalMarkdown, targetPath }
      : { goalMarkdown, targetPath, requireRehearsalCoverage }
  }
  if (requireRehearsalCoverage === undefined) return { goalMarkdown, targetPath, referencePaths: referencePaths as string[] }
  return {
    goalMarkdown,
    targetPath,
    referencePaths: referencePaths as string[],
    requireRehearsalCoverage,
  }
}

interface SpawnToolResult {
  readonly clonePath: string
  readonly sourceCommit: string
  readonly port: number
  readonly homePath: string
  readonly goalSha256: string
  readonly rehearsedSkills: string[]
}

const SPAWN_OUTPUT_PROPERTIES = {
  clonePath: { type: 'string', description: 'Absolute path of the spawned clone.' },
  sourceCommit: { type: 'string', description: 'Mother checkout commit the clone was cut from.' },
  port: { type: 'number', description: 'Reserved localhost port for the clone web profile.' },
  homePath: { type: 'string', description: 'Clone-relative home directory for state and credentials.' },
  goalSha256: { type: 'string', description: 'SHA-256 of the goal file content at spawn time.' },
  rehearsedSkills: { type: 'array', description: 'Distilled rehearsal skills copied into the clone.' },
} as const

function renderResult(value: SpawnToolResult): ContentBlock[] {
  const skills = value.rehearsedSkills.length === 0
    ? ''
    : `; rehearsed skills carried into the clone: ${value.rehearsedSkills.join(', ')}`
  return [{
    type: 'text',
    text: [
      `Clone spawned at ${value.clonePath}`,
      `source commit ${value.sourceCommit}`,
      `port ${value.port}`,
      `home ${value.homePath}`,
      `goal ${GOAL_FILE_NAME} sha256 ${value.goalSha256}`,
    ].join('; ') + skills,
  }]
}

const CHECKPOINT_OUTPUT_PROPERTIES = {
  outcome: { type: 'string', description: 'committed, failed, rolled-back, or complete.' },
  milestone: { type: 'number', description: 'Milestone this checkpoint gated.' },
  title: { type: 'string', description: 'Milestone title from the goal file.' },
  attempts: { type: 'number', description: 'Consecutive red attempts after this checkpoint.' },
  lastGreenCommit: { type: 'string', description: 'Last green commit after this checkpoint.' },
  detail: { type: 'string', description: 'Decision rationale with gate evidence.' },
} as const

function renderCheckpoint(value: CheckpointReport): ContentBlock[] {
  return [{
    type: 'text',
    text: [
      `M${value.milestone} (${value.title}) — ${value.outcome}`,
      `attempts ${value.attempts}`,
      `last green commit ${value.lastGreenCommit}`,
      value.detail,
    ].join('; '),
  }]
}

const ROUNDS_OUTPUT_PROPERTIES = {
  rounds: { type: 'number', description: 'Checkpoints executed in this run.' },
  stoppedBecause: { type: 'string', description: 'complete, paused (coach pause flag), or max-rounds.' },
  lastMilestone: { type: 'number', description: 'Milestone of the last checkpoint, when one ran.' },
  lastOutcome: { type: 'string', description: 'Outcome of the last checkpoint, when one ran.' },
  lastDetail: { type: 'string', description: 'Decision rationale of the last checkpoint, when one ran.' },
} as const

function renderRounds(value: RoundsReport): ContentBlock[] {
  const last = value.lastReport === undefined
    ? 'no checkpoint ran'
    : `last checkpoint M${value.lastReport.milestone} (${value.lastReport.title}) — ${value.lastReport.outcome}: ${value.lastReport.detail}`
  return [{
    type: 'text',
    text: `Mutation rounds finished: ${value.rounds} checkpoint(s), stopped because ${value.stoppedBecause}; ${last}`,
  }]
}

/** Validate mutation_run arguments: an optional positive integer round budget. */
export function parseRunArgs(args: unknown): { maxRounds?: number } {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('mutation_run arguments must be an object')
  }
  const maxRounds = (args as Record<string, unknown>).maxRounds
  if (maxRounds === undefined) return {}
  if (typeof maxRounds !== 'number' || !Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error('mutation_run maxRounds must be a positive integer')
  }
  return { maxRounds }
}

interface RehearsalAttemptArgs {
  topic: string
  approach: string
  hypothesis: string
  milestone?: number
  gates: string[]
}

/** Validate rehearsal_attempt arguments: topic, approach, hypothesis, gates, optional milestone. */
export function parseAttemptArgs(args: unknown): RehearsalAttemptArgs {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('rehearsal_attempt arguments must be an object')
  }
  const record = args as Record<string, unknown>
  const topic = record.topic
  const approach = record.approach
  const hypothesis = record.hypothesis
  if (typeof topic !== 'string') throw new Error('rehearsal_attempt requires a topic string')
  if (typeof approach !== 'string') throw new Error('rehearsal_attempt requires an approach string')
  if (typeof hypothesis !== 'string') throw new Error('rehearsal_attempt requires a hypothesis string')
  const milestone = record.milestone
  if (milestone !== undefined && (typeof milestone !== 'number' || !Number.isSafeInteger(milestone) || milestone < 1)) {
    throw new Error('rehearsal_attempt milestone must be a positive safe integer')
  }
  const gates = record.gates
  if (!Array.isArray(gates) || gates.some(gate => typeof gate !== 'string')) {
    throw new Error('rehearsal_attempt gates must be an array of command strings')
  }
  return {
    topic,
    approach,
    hypothesis,
    ...(milestone === undefined ? {} : { milestone }),
    gates: gates as string[],
  }
}

interface RehearsalDistillArgs {
  topic: string
  name: string
  description: string
  body: string
}

/** Validate rehearsal_distill arguments: topic, skill name, description, body. */
export function parseDistillArgs(args: unknown): RehearsalDistillArgs {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('rehearsal_distill arguments must be an object')
  }
  const record = args as Record<string, unknown>
  const topic = record.topic
  const name = record.name
  const description = record.description
  const body = record.body
  if (typeof topic !== 'string') throw new Error('rehearsal_distill requires a topic string')
  if (typeof name !== 'string') throw new Error('rehearsal_distill requires a name string')
  if (typeof description !== 'string') throw new Error('rehearsal_distill requires a description string')
  if (typeof body !== 'string') throw new Error('rehearsal_distill requires a body string')
  return { topic, name, description, body }
}

const ATTEMPT_OUTPUT_PROPERTIES = {
  topic: { type: 'string', description: 'Capability the attempt rehearsed.' },
  seq: { type: 'number', description: 'Attempt number within the topic.' },
  verdict: { type: 'string', description: 'green when every executed gate passed, red otherwise.' },
  stuck: { type: 'boolean', description: 'Whether the topic is now stuck on this approach.' },
  attemptsUsed: { type: 'number', description: 'Attempts recorded on the topic including this one.' },
  maxAttempts: { type: 'number', description: 'Attempt budget per topic.' },
  gates: { type: 'array', description: 'Executed gates in order with their evidence.' },
  detail: { type: 'string', description: 'Evidence-backed decision rationale.' },
} as const

function renderAttempt(value: RehearsalAttemptReport): ContentBlock[] {
  return [{
    type: 'text',
    text: `Rehearsal ${value.topic} attempt ${value.seq} — ${value.verdict} (attempt ${value.attemptsUsed} of ${value.maxAttempts})${value.stuck ? '; topic is STUCK' : ''}; ${value.detail}`,
  }]
}

const DISTILL_OUTPUT_PROPERTIES = {
  topic: { type: 'string', description: 'Topic the skill was distilled from.' },
  name: { type: 'string', description: 'Skill name recorded in the frontmatter.' },
  skillPath: { type: 'string', description: 'Path of the written skill candidate.' },
  attemptSeq: { type: 'number', description: 'Green attempt the skill was distilled from.' },
  superseded: { type: 'boolean', description: 'Whether an earlier distilled skill was replaced.' },
} as const

function renderDistill(value: RehearsalDistillReport): ContentBlock[] {
  return [{
    type: 'text',
    text: `Distilled skill ${value.name} for topic ${value.topic} from green attempt ${value.attemptSeq} at ${value.skillPath}${value.superseded ? '; replaced an earlier distilled skill' : ''}`,
  }]
}

const COVERAGE_OUTPUT_PROPERTIES = {
  topics: { type: 'array', description: 'Per-topic coverage: attempts, verdicts, stuck, distilled.' },
  skills: { type: 'array', description: 'Topics with a distilled skill candidate.' },
} as const

function renderCoverage(value: RehearsalCoverageReport): ContentBlock[] {
  if (value.topics.length === 0 && value.skills.length === 0) {
    return [{ type: 'text', text: 'No rehearsal attempts recorded yet.' }]
  }
  const topicLines = value.topics.map(topic =>
    `- ${topic.topic}: ${topic.attempts} attempt(s), ${topic.green} green, ${topic.red} red${topic.stuck ? ', STUCK' : ''}${topic.distilled ? ', distilled' : ''}`)
  const skillLine = value.skills.length === 0 ? '' : `\nDistilled skills: ${value.skills.join(', ')}`
  return [{ type: 'text', text: `Rehearsal coverage:\n${topicLines.join('\n')}${skillLine}` }]
}

/** Register the explicit-ask spawn tool and its usage policy. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  if (existsSync(join(resolved.repositoryPath, SPAWN_RECORD_NAME))) {
    registerCloneTools(ctx, resolved)
    return
  }
  ctx.systemPrompt.section({
    name: 'tool:spawn',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SPAWN'),
    text: 'Use the spawn_and_mutate tool ONLY when the human explicitly asks to spawn, replicate, or transform the factory itself. It clones this repository into an isolated directory with its own git history, home, and port, writes the mutation goal there, and never modifies the current checkout. The mutation loop that works inside a clone is a separate deployment capability; spawning does not start it.',
  })
  ctx.systemPrompt.section({
    name: 'rehearsal:policy',
    order: ctx.systemPrompt.getSectionOrder('TOOL_FACTORY_REHEARSAL'),
    text: 'Rehearse before you spawn: before proposing spawn_and_mutate for a capability, try candidate approaches against this checkout with rehearsal_attempt — run real gates, record every attempt with its evidence, and let the record pick the winning approach. Do rehearsal experiments inside a scratch directory (for example .rehearsal-home/scratch/<topic>/) so the mother checkout stays clean; rehearsal records are git-excluded. Only green attempts may be distilled into skills with rehearsal_distill, and distilled skills ship into every clone this factory spawns. When a topic goes stuck (three consecutive red attempts on the same approach), stop hammering: change the approach or escalate to the coaching channel, whose skill master can pause and reconfigure. When the human expects a rehearsed spawn, pass requireRehearsalCoverage to spawn_and_mutate so the clone only starts when every goal milestone has a green rehearsal behind it.',
  })
  ctx.tools.register(defineTool({
    name: 'rehearsal_attempt',
    description: 'Run real gate commands for one candidate approach on a capability, record the attempt with its evidence, and enforce the per-topic budget and strike rule.',
    parameters: {
      topic: {
        type: 'string',
        required: true,
        description: 'Kebab-slug capability being rehearsed, at most 40 characters.',
      },
      approach: {
        type: 'string',
        required: true,
        description: 'Short label of the approach being tried, at most 200 characters.',
      },
      hypothesis: {
        type: 'string',
        required: true,
        description: 'The belief this attempt sets out to prove.',
      },
      milestone: {
        type: 'number',
        description: 'Goal milestone this rehearsal supports.',
      },
      gates: {
        type: 'array',
        required: true,
        description: 'Gate commands executed in order; the first failure ends the attempt.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: ATTEMPT_OUTPUT_PROPERTIES,
      },
      render: (_args, value) => renderAttempt(value as unknown as RehearsalAttemptReport),
    },
    async execute(args, exec) {
      const parsed = parseAttemptArgs(args)
      const report = await runRehearsalAttempt({
        repositoryPath: resolved.repositoryPath,
        topic: parsed.topic,
        approach: parsed.approach,
        hypothesis: parsed.hypothesis,
        ...parsed.milestone === undefined ? {} : { milestone: parsed.milestone },
        gates: parsed.gates,
        signal: exec.signal,
      })
      return { ...report, gates: report.gates.map(gate => ({ ...gate })) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'rehearsal_distill',
    description: 'Distill a green rehearsal attempt of a topic into a skill candidate that ships into every spawned clone.',
    parameters: {
      topic: {
        type: 'string',
        required: true,
        description: 'Kebab-slug topic with a green attempt.',
      },
      name: {
        type: 'string',
        required: true,
        description: 'Skill name for the frontmatter; lowercase kebab, at most 60 characters.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'One-line skill description for the frontmatter.',
      },
      body: {
        type: 'string',
        required: true,
        description: 'The distilled skill body in Markdown.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: DISTILL_OUTPUT_PROPERTIES,
      },
      render: (_args, value) => renderDistill(value as unknown as RehearsalDistillReport),
    },
    async execute(args, exec) {
      const parsed = parseDistillArgs(args)
      return distillRehearsal({
        repositoryPath: resolved.repositoryPath,
        topic: parsed.topic,
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        signal: exec.signal,
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'rehearsal_report',
    description: 'Report rehearsal coverage: attempts, verdicts, stuck topics, distilled skills.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: COVERAGE_OUTPUT_PROPERTIES,
      },
      render: (_args, value) => renderCoverage(value as unknown as RehearsalCoverageReport),
    },
    async execute(_args, exec) {
      const report = await rehearsalCoverage(resolved.repositoryPath, exec.signal)
      return { topics: report.topics.map(topic => ({ ...topic })), skills: [...report.skills] }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'spawn_and_mutate',
    description: DESCRIPTION,
    parameters: {
      goalMarkdown: {
        type: 'string',
        required: true,
        description: 'The complete mutation goal document the clone must satisfy.',
      },
      targetPath: {
        type: 'string',
        required: true,
        description: 'Filesystem path for the new clone directory; it must not exist.',
      },
      referencePaths: {
        type: 'array',
        description: 'Optional file paths copied verbatim into the clone references directory.',
      },
      requireRehearsalCoverage: {
        type: 'boolean',
        description: 'Refuse to spawn until every goal milestone has a green rehearsal attempt.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: SPAWN_OUTPUT_PROPERTIES,
      },
      render: (_args, value) => renderResult(value as unknown as SpawnToolResult),
    },
    async execute(args, exec) {
      const parsed = parseArgs(args)
      if (parsed.requireRehearsalCoverage === true) {
        const uncovered = await uncoveredMilestones(resolved.repositoryPath, parseGoal(parsed.goalMarkdown), exec.signal)
        if (uncovered.length > 0) {
          const list = uncovered.map(entry => `M${entry.milestone} (${entry.title})`).join(', ')
          throw new Error(
            `rehearsal coverage is incomplete: ${list} ${uncovered.length === 1 ? 'has' : 'have'} no green rehearsal attempt; ` +
            'rehearse with rehearsal_attempt (declaring the milestone) before spawning',
          )
        }
      }
      const { record, rehearsedSkills } = await spawnClone({
        repositoryPath: resolved.repositoryPath,
        targetPath: parsed.targetPath,
        goalMarkdown: parsed.goalMarkdown,
        ...parsed.referencePaths === undefined ? {} : { referencePaths: parsed.referencePaths },
        signal: exec.signal,
      })
      return {
        clonePath: parsed.targetPath,
        sourceCommit: record.sourceCommit,
        port: record.port,
        homePath: record.homePath,
        goalSha256: record.goalSha256,
        rehearsedSkills: [...rehearsedSkills],
      } satisfies SpawnToolResult
    },
  }))
}

/** Register the clone-side loop tools: a clone verifies and advances its own goal. */
function registerCloneTools(ctx: Context, resolved: ResolvedConfig): void {
  ctx.systemPrompt.section({
    name: 'tool:mutation-checkpoint',
    order: ctx.systemPrompt.getSectionOrder('TOOL_MUTATION_CHECKPOINT'),
    text: 'Call the mutation_checkpoint tool after implementing the current milestone slice inside a spawned clone. It runs the milestone executable acceptance gates from MUTATION_GOAL.md itself: a green run is committed automatically and the loop advances, a red run counts one strike, and the third consecutive strike resets the clone to its last green commit and logs the failed approach. Never claim a milestone is green without a checkpoint report, and never commit mutation work outside the checkpoint.',
  })
  ctx.tools.register(defineTool({
    name: 'mutation_checkpoint',
    description: 'Run the current milestone acceptance gates inside the spawned clone, commit on green, count strikes on red, and roll back on the third consecutive failure.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: CHECKPOINT_OUTPUT_PROPERTIES,
      },
      render: (_args, value) => renderCheckpoint(value as unknown as CheckpointReport),
    },
    async execute(_args, exec) {
      return runCheckpoint({ clonePath: resolved.repositoryPath, signal: exec.signal })
    },
  }))
  ctx.systemPrompt.section({
    name: 'tool:mutation-run',
    order: ctx.systemPrompt.getSectionOrder('TOOL_MUTATION_RUN'),
    text: 'Call the mutation_run tool to drive checkpoint rounds back to back until the mutation goal reports complete. It stops on its own when a coaching pause flag appears or the round budget runs out, and every round is still gated by mutation_checkpoint. Never use it outside a spawned clone, and never bypass the checkpoint by committing mutation work directly.',
  })
  ctx.tools.register(defineTool({
    name: 'mutation_run',
    description: 'Drive mutation checkpoint rounds back to back until the goal reports complete, a coach pause flag appears, or the round budget runs out.',
    parameters: {
      maxRounds: {
        type: 'number',
        description: `Optional round budget; defaults to ${DEFAULT_MAX_ROUNDS}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: ROUNDS_OUTPUT_PROPERTIES,
      },
      render: (_args, value) => renderRounds(value as unknown as RoundsReport),
    },
    async execute(args, exec) {
      const parsed = parseRunArgs(args)
      return runRounds({
        clonePath: resolved.repositoryPath,
        ...parsed.maxRounds === undefined ? {} : { maxRounds: parsed.maxRounds },
        signal: exec.signal,
      })
    },
  }))
}
