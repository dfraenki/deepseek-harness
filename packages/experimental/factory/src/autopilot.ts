/**
 * The mutation loop's verification and git autopilot: run a milestone's
 * executable acceptance gates inside the clone, commit on green, count
 * consecutive red attempts, and roll back to the last green commit on the
 * third strike. Every decision is evidence-backed and recorded.
 * @module @deepseek-ai/dsh-experimental-factory/autopilot
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { GoalMilestone } from './goal.ts'
import {
  GOAL_FILE_NAME,
  MUTATION_HOME_NAME,
  SPAWN_RECORD_NAME,
  commitAll,
  excludePathFromGit,
  readSpawnRecord,
  runGit,
  sha256File,
} from './spawn.ts'
import { parseGoal } from './goal.ts'

/** Clone-relative state file holding the loop's milestone position and streak. */
export const LOOP_STATE_NAME = join(MUTATION_HOME_NAME, 'loop-state.json')

/** Home-relative log recording rolled-back approaches and their evidence. */
export const MUTATION_LOG_NAME = join(MUTATION_HOME_NAME, 'mutation-log.md')

/** Home-relative directory holding one full-output log file per executed gate. */
export const GATES_DIR_NAME = join(MUTATION_HOME_NAME, 'gates')

/** Wall-clock limit for one acceptance gate before it is killed as red. */
export const MAX_GATE_MS = 600_000

/** Consecutive red attempts on one milestone that trigger `git reset --hard`. */
export const MAX_ATTEMPTS = 3

/** Durable loop position, persisted between rounds in the clone's home. */
export interface LoopState {
  /** State format version. */
  readonly version: 1
  /** Milestone the next round implements; 0 means uninitialized. */
  readonly currentMilestone: number
  /** Consecutive red gate attempts on the current milestone. */
  readonly attempts: number
  /** Commit the loop rolls back to; never rewritten. */
  readonly lastGreenCommit: string
}

/** One executed acceptance gate and its evidence. */
export interface GateResult {
  /** The command that ran. */
  readonly command: string
  /** Exit code; 1 when the process died without one (killed, aborted). */
  readonly exitCode: number
  /** Whether the gate passed. */
  readonly ok: boolean
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number
  /** Trailing output capped for evidence; never the agent's claim. */
  readonly outputTail: string
}

/** What the autopilot decided after one checkpoint. */
export type CheckpointOutcome = 'committed' | 'failed' | 'rolled-back' | 'complete'

/** The result of one checkpoint: gates plus the autopilot decision. */
export interface CheckpointReport {
  /** Milestone this checkpoint gated. */
  readonly milestone: number
  /** Milestone title from the goal file. */
  readonly title: string
  /** The autopilot decision. */
  readonly outcome: CheckpointOutcome
  /** Consecutive red attempts on this milestone after the checkpoint. */
  readonly attempts: number
  /** Last green commit after the checkpoint. */
  readonly lastGreenCommit: string
  /** Executed gates in order; the first red gate ends the attempt. */
  readonly gates: readonly GateResult[]
  /** Human-readable decision rationale. */
  readonly detail: string
}

/**
 * Run one gate command in the clone and capture its evidence. A gate that
 * exceeds `timeoutMs` is killed and reported red with exit code 124, so a
 * watch-mode command can never hang the loop.
 */
export async function runGateCommand(
  clonePath: string,
  command: string,
  signal?: AbortSignal,
  timeoutMs = MAX_GATE_MS,
): Promise<GateResult> {
  const started = Date.now()
  const child = spawn('/bin/bash', ['-c', command], { cwd: clonePath, signal })
  let output = ''
  let timedOut = false
  child.stdout.on('data', chunk => {
    output += chunk
  })
  child.stderr.on('data', chunk => {
    output += chunk
  })
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)
  try {
    const code = await new Promise<number | null>(resolve => {
      child.on('error', () => {
        resolve(null)
      })
      child.on('close', exitCode => {
        resolve(exitCode)
      })
    })
    return {
      command,
      exitCode: timedOut ? 124 : code ?? 1,
      ok: code === 0 && !timedOut,
      durationMs: Date.now() - started,
      outputTail: output.split('\n').slice(-40).join('\n').slice(-2000),
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Load the loop state, or initialize it from the clone's HEAD and its first milestone. */
export async function loadLoopState(clonePath: string, firstMilestone: number): Promise<LoopState> {
  const path = join(clonePath, LOOP_STATE_NAME)
  const raw = await readFile(path, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (raw !== null) return JSON.parse(raw) as LoopState
  const head = await runGit(clonePath, ['rev-parse', 'HEAD'])
  return { version: 1, currentMilestone: firstMilestone, attempts: 0, lastGreenCommit: head }
}

/** Persist the loop state inside the clone's home directory. */
export async function saveLoopState(clonePath: string, state: LoopState): Promise<void> {
  const path = join(clonePath, LOOP_STATE_NAME)
  await mkdir(join(clonePath, MUTATION_HOME_NAME), { recursive: true })
  await excludePathFromGit(clonePath, MUTATION_HOME_NAME)
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export interface CheckpointOptions {
  /** The clone root containing MUTATION_GOAL.md and its own git history. */
  readonly clonePath: string
  /** Cancellation signal forwarded to gate commands and git. */
  readonly signal?: AbortSignal
}

/**
 * Run one checkpoint on the current milestone: gates in goal order (first red
 * ends the attempt), then the autopilot decision — commit and advance on
 * green, count the strike on red, roll back to the last green commit on the
 * third consecutive failure with the failed approach logged.
 */
export async function runCheckpoint(options: CheckpointOptions): Promise<CheckpointReport> {
  const { clonePath, signal } = options
  let goalMarkdown: string
  try {
    goalMarkdown = await readFile(join(clonePath, GOAL_FILE_NAME), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`the goal file is missing at ${join(clonePath, GOAL_FILE_NAME)}`)
    }
    throw error
  }
  const spawnRecord = await readSpawnRecord(clonePath, signal)
  if (spawnRecord !== null) {
    const currentSha256 = await sha256File(join(clonePath, GOAL_FILE_NAME), signal)
    if (currentSha256 !== spawnRecord.goalSha256) {
      throw new Error(
        `the goal file changed after spawn (spawn record ${SPAWN_RECORD_NAME} pins sha256 ${spawnRecord.goalSha256}, the current file hashes to ${currentSha256}); the goal is frozen for this mutation`,
      )
    }
  }
  const goal = parseGoal(goalMarkdown)
  const [first] = goal.milestones
  const state = await loadLoopState(clonePath, first.id)
  const milestone = goal.milestones.find(entry => entry.id === state.currentMilestone)
  if (milestone === undefined) {
    throw new Error(`loop state references milestone M${state.currentMilestone}, which the goal file does not define`)
  }
  const criteria = goal.criteria.filter(criterion => criterion.milestone === milestone.id)
  if (criteria.length === 0) {
    throw new Error(`milestone M${milestone.id} has no executable acceptance criteria in the goal file`)
  }
  const gates: GateResult[] = []
  for (const criterion of criteria) {
    const result = await runGateCommand(clonePath, criterion.command, signal)
    gates.push(result)
    if (!result.ok) break
  }
  await excludePathFromGit(clonePath, MUTATION_HOME_NAME)
  await saveGateLogs(clonePath, milestone.id, gates)
  const red = gates.find(gate => !gate.ok)
  if (red === undefined) {
    const status = await runGit(clonePath, ['status', '--porcelain'], signal)
    if (status.length === 0) {
      return settleStrike(clonePath, state, milestone, gates, {
        detail: 'the acceptance gates are green but the work tree has no changes to commit',
        evidence: ['- the acceptance gates passed but produced no work-tree changes'],
      }, signal)
    }
    return commitGreen(clonePath, state, goal.milestones, milestone, gates, signal)
  }
  return settleStrike(clonePath, state, milestone, gates, {
    detail: `${red.command} exited ${red.exitCode}`,
    evidence: gates.map(gate => `- \`${gate.command}\` exited ${gate.exitCode}: ${gate.outputTail.split('\n').slice(-1)[0] || 'no output'}`),
  }, signal)
}

/** Persist one full-output log file per executed gate inside the clone's home directory. */
async function saveGateLogs(clonePath: string, milestone: number, gates: readonly GateResult[]): Promise<void> {
  const dir = join(clonePath, GATES_DIR_NAME)
  await mkdir(dir, { recursive: true })
  for (const [index, gate] of gates.entries()) {
    const lines = [
      `milestone M${milestone}`,
      `command: ${gate.command}`,
      `exit code: ${gate.exitCode}`,
      `duration ms: ${gate.durationMs}`,
      '',
      gate.outputTail,
      '',
    ]
    await writeFile(join(dir, `M${milestone}-${index + 1}.log`), lines.join('\n'), 'utf8')
  }
}

/** Commit a green milestone and advance the loop, or report the goal complete. */
async function commitGreen(
  clonePath: string,
  state: LoopState,
  milestones: readonly GoalMilestone[],
  milestone: GoalMilestone,
  gates: readonly GateResult[],
  signal?: AbortSignal,
): Promise<CheckpointReport> {
  const commitMessage = `Mutation: M${milestone.id} ${milestone.title}`
  await commitAll(clonePath, commitMessage, signal)
  const head = await runGit(clonePath, ['rev-parse', 'HEAD'], signal)
  const index = milestones.findIndex(entry => entry.id === milestone.id)
  const next = milestones[index + 1]
    if (next === undefined) {
      const complete: LoopState = { ...state, attempts: 0, lastGreenCommit: head }
      await saveLoopState(clonePath, complete)
      return {
        milestone: milestone.id,
        title: milestone.title,
        outcome: 'complete',
        attempts: 0,
        lastGreenCommit: head,
        gates,
        detail: `every milestone is green; the run satisfied its goal at commit ${head}`,
      }
    }
    await saveLoopState(clonePath, { ...state, currentMilestone: next.id, attempts: 0, lastGreenCommit: head })
    return {
      milestone: milestone.id,
      title: milestone.title,
      outcome: 'committed',
      attempts: 0,
      lastGreenCommit: head,
      gates,
      detail: `M${milestone.id} is green at commit ${head}; the next round implements M${next.id}`,
    }
}

/** What went wrong in one failed checkpoint attempt, with its log evidence. */
interface StrikeEvidence {
  readonly detail: string
  readonly evidence: readonly string[]
}

/**
 * Count one failed attempt on the current milestone; on the third consecutive
 * strike, reset the clone to its last green commit, remove untracked debris
 * from the failed approach, and log the evidence so the next round must take
 * a different approach.
 */
async function settleStrike(
  clonePath: string,
  state: LoopState,
  milestone: GoalMilestone,
  gates: readonly GateResult[],
  failure: StrikeEvidence,
  signal?: AbortSignal,
): Promise<CheckpointReport> {
  const attempts = state.attempts + 1
  if (attempts < MAX_ATTEMPTS) {
    await saveLoopState(clonePath, { ...state, attempts })
    return {
      milestone: milestone.id,
      title: milestone.title,
      outcome: 'failed',
      attempts,
      lastGreenCommit: state.lastGreenCommit,
      gates,
      detail: `${failure.detail} (attempt ${attempts} of ${MAX_ATTEMPTS})`,
    }
  }
  await runGit(clonePath, ['reset', '--hard', state.lastGreenCommit], signal)
  await runGit(clonePath, ['clean', '-fd'], signal)
  const entry = [
    `## ${new Date().toISOString()} — M${milestone.id} rolled back`,
    '',
    `Three consecutive failed attempts on milestone M${milestone.id} (${milestone.title}).`,
    `Rolled back to ${state.lastGreenCommit}. The next round must take a different approach.`,
    '',
    'Failed approach evidence:',
    ...failure.evidence,
    '',
  ]
  await appendFile(join(clonePath, MUTATION_LOG_NAME), `${entry.join('\n')}\n`, 'utf8')
  await saveLoopState(clonePath, { ...state, attempts: 0 })
  return {
    milestone: milestone.id,
    title: milestone.title,
    outcome: 'rolled-back',
    attempts: 0,
    lastGreenCommit: state.lastGreenCommit,
    gates,
    detail: `third consecutive failure (${failure.detail}); reset --hard to ${state.lastGreenCommit} and logged the failed approach`,
  }
}
