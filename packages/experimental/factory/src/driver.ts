/**
 * The mutation loop's rounds driver: call the checkpoint back to back until
 * the goal reports complete, a coach pause flag appears, or the round budget
 * runs out. Pure sequencing on top of the deterministic autopilot.
 * @module @deepseek-ai/dsh-experimental-factory/driver
 */

import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import type { CheckpointReport } from './autopilot.ts'
import { runCheckpoint } from './autopilot.ts'

/**
 * Coach pause flag (L2): when present in the clone, the driver stops before
 * the next round and waits. Written only by the coaching layer; removed to
 * resume; loop state survives the pause untouched.
 */
export const PAUSE_FLAG_NAME = join('.coaches', 'PAUSE')

/** Round budget when the caller does not set one. */
export const DEFAULT_MAX_ROUNDS = 64

/** Options for one autonomous rounds run. */
export interface RoundsOptions {
  /** The clone root holding MUTATION_GOAL.md and its own git history. */
  readonly clonePath: string
  /** Maximum checkpoints to run before stopping; defaults to 64. */
  readonly maxRounds?: number
  /** Cancellation signal forwarded to every checkpoint. */
  readonly signal?: AbortSignal
}

/** Why the rounds run stopped. */
export type RoundsStop = 'complete' | 'paused' | 'max-rounds'

/** The result of one rounds run: how far it got and the last checkpoint. */
export interface RoundsReport {
  /** Checkpoints executed in this run. */
  readonly rounds: number
  /** Why the run stopped. */
  readonly stoppedBecause: RoundsStop
  /** Last checkpoint decision; absent when paused before the first round. */
  readonly lastReport?: CheckpointReport
}

/** Whether a coach pause flag is present in the clone. */
export async function isPaused(clonePath: string): Promise<boolean> {
  return access(join(clonePath, PAUSE_FLAG_NAME), constants.F_OK).then(() => true, () => false)
}

/**
 * Run checkpoint rounds back to back until the goal reports `complete`, a
 * coach pause flag appears, or `maxRounds` is reached. A checkpoint error
 * (missing goal, frozen-goal violation, broken state) propagates: fail loud.
 */
export async function runRounds(options: RoundsOptions): Promise<RoundsReport> {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS
  let rounds = 0
  let lastReport: CheckpointReport | undefined
  while (rounds < maxRounds) {
    if (await isPaused(options.clonePath)) {
      return {
        rounds,
        stoppedBecause: 'paused',
        ...(lastReport === undefined ? {} : { lastReport }),
      }
    }
    lastReport = await runCheckpoint({
      clonePath: options.clonePath,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    rounds++
    if (lastReport.outcome === 'complete') {
      return { rounds, stoppedBecause: 'complete', lastReport }
    }
  }
  return { rounds, stoppedBecause: 'max-rounds', ...(lastReport === undefined ? {} : { lastReport }) }
}
