/**
 * The Artifork catalog: every spawned application reports its own state from
 * its own files and git history, and each completed app carries its publish
 * decision as a committed record. The catalog keeps no state of its own.
 * @module @deepseek-ai/dsh-experimental-factory-catalog/catalog
 */

import type { Dirent } from 'node:fs'
import { access, constants, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  GOAL_FILE_NAME,
  PAUSE_FLAG_NAME,
  SPAWN_RECORD_NAME,
  commitAll,
  loadLoopState,
  parseGoal,
  readSpawnRecord,
  requireCleanCheckout,
  runGit,
  type GoalMilestone,
  type ParsedGoal,
} from '@deepseek-ai/dsh-experimental-factory'

/** The publish record every completed app carries once a decision is made. */
export const PUBLISH_RECORD_NAME = 'PUBLISH_RECORD.json'

/** The human- and CI-facing manifest written for hosting publish decisions. */
export const PUBLISH_MANIFEST_NAME = 'PUBLISH_MANIFEST.md'

/** Allowed publish targets; `catalog-only` always works, hosting needs a surface match. */
export const PUBLISH_TARGETS = ['catalog-only', 'cloudflare', 'hostinger'] as const

/** One publish target. */
export type PublishTarget = (typeof PUBLISH_TARGETS)[number]

/** Derived lifecycle status of a spawned application. */
export type AppStatus = 'complete' | 'in-progress' | 'paused'

/** What the publish step actually did. */
export type PublishDecision = 'catalog-only' | 'manifest-ready'

/** The committed record of one app's publish decision. */
export interface PublishRecord {
  /** Record format version. */
  readonly version: 1
  /** The app's directory name. */
  readonly app: string
  /** What the publish step did. */
  readonly decision: PublishDecision
  /** The target the decision was made for. */
  readonly target: PublishTarget
  /** The deployable surface detected in the app. */
  readonly surface: string
  /** The commit the decision was recorded at. */
  readonly commit: string
  /** ISO timestamp of the decision. */
  readonly createdAt: string
}

/** One spawned application as the catalog sees it. */
export interface CatalogEntry {
  /** The app's directory name. */
  readonly name: string
  /** Absolute path of the app directory. */
  readonly appPath: string
  /** Derived lifecycle status. */
  readonly status: AppStatus
  /** Milestone the loop sits on (or finished at). */
  readonly milestone: number
  /** Total milestones the goal defines. */
  readonly milestonesTotal: number
  /** Commit the loop last verified green. */
  readonly lastGreenCommit: string
  /** The app's committed publish decision, when one exists. */
  readonly publish?: PublishRecord
}

/** One app directory the catalog could not read, with the reason. */
export interface SkippedApp {
  /** The app's directory name. */
  readonly name: string
  /** Why the catalog skipped it. */
  readonly reason: string
}

/** What one catalog scan produced. */
export interface CatalogReport {
  /** Readable spawned applications, sorted by name. */
  readonly entries: readonly CatalogEntry[]
  /** App directories under the apps root that could not be read. */
  readonly skipped: readonly SkippedApp[]
}

/** What one publish decision produced. */
export interface PublishReport {
  /** The app's directory name. */
  readonly app: string
  /** The decision recorded. */
  readonly decision: PublishDecision
  /** The target the decision was made for. */
  readonly target: PublishTarget
  /** The deployable surface detected in the app. */
  readonly surface: string
  /** The commit the decision was recorded at. */
  readonly commit: string
  /** Path of the committed publish record. */
  readonly recordPath: string
  /** Path of the hosting manifest, when the decision wrote one. */
  readonly manifestPath?: string
}

/** The goal's final milestone; parseGoal guarantees the tuple is non-empty. */
function lastMilestone(goal: ParsedGoal): GoalMilestone {
  return goal.milestones.reduce((_, milestone) => milestone)
}

/** Whether the app carries a coach pause flag. */
async function isPaused(appPath: string): Promise<boolean> {
  return access(join(appPath, PAUSE_FLAG_NAME), constants.F_OK).then(() => true, () => false)
}

/**
 * Derive one app's lifecycle status: paused beats everything, then complete
 * (clean tree whose history contains the last milestone's Mutation commit),
 * then in-progress. Publish commits after the final Mutation commit keep the
 * app complete.
 */
export async function deriveStatus(
  appPath: string,
  lastMilestoneTitle: string,
  signal?: AbortSignal,
): Promise<AppStatus> {
  if (await isPaused(appPath)) return 'paused'
  const status = await runGit(appPath, ['status', '--porcelain'], signal)
  if (status.trim().length > 0) return 'in-progress'
  const found = await runGit(
    appPath,
    ['log', '--fixed-strings', '--grep', `Mutation: ${lastMilestoneTitle}`, '-1', '--format=%H'],
    signal,
  )
  return found.trim().length > 0 ? 'complete' : 'in-progress'
}

/** The deployable surface a completed app exposes: its web bundle or headless runtime. */
export async function detectSurface(appPath: string): Promise<'web' | 'headless'> {
  const entries = await readdir(join(appPath, 'apps'), { withFileTypes: true }).catch((error: unknown): Dirent[] => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  return entries.some(entry => entry.isDirectory() && entry.name === 'web') ? 'web' : 'headless'
}

/** Read one app's committed publish decision, or undefined when none exists. */
async function readPublishRecord(appPath: string, signal?: AbortSignal): Promise<PublishRecord | undefined> {
  const raw = await readFile(join(appPath, PUBLISH_RECORD_NAME), { encoding: 'utf8', signal }).catch(
    (error: unknown): string | null => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    },
  )
  return raw === null ? undefined : (JSON.parse(raw) as PublishRecord)
}

/** Scan the apps root and derive every spawned application's catalog entry. */
export async function scanApps(appsDir: string, signal?: AbortSignal): Promise<CatalogReport> {
  const dirents = await readdir(appsDir, { withFileTypes: true }).catch((error: unknown): Dirent[] => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  const entries: CatalogEntry[] = []
  const skipped: SkippedApp[] = []
  for (const dirent of dirents.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const appPath = join(appsDir, dirent.name)
    try {
      const spawnRecord = await readSpawnRecord(appPath, signal)
      if (spawnRecord === null) continue
      const goal = parseGoal(await readFile(join(appPath, GOAL_FILE_NAME), { encoding: 'utf8', signal }))
      const state = await loadLoopState(appPath, goal.milestones[0].id)
      const last = lastMilestone(goal)
      const status = await deriveStatus(appPath, `M${last.id} ${last.title}`, signal)
      const publish = await readPublishRecord(appPath, signal)
      entries.push({
        name: dirent.name,
        appPath,
        status,
        milestone: state.currentMilestone,
        milestonesTotal: goal.milestones.length,
        lastGreenCommit: state.lastGreenCommit,
        ...(publish === undefined ? {} : { publish }),
      })
    } catch (error) {
      skipped.push({ name: dirent.name, reason: String(error) })
    }
  }
  return { entries, skipped }
}

/** The hosting manifest body for one decided target and surface. */
export function renderManifest(app: string, target: PublishTarget, surface: 'web' | 'headless', commit: string): string {
  const lines = [
    `# Publish manifest: ${app}`,
    '',
    `- Target: ${target}`,
    `- Surface: ${surface}`,
    `- Commit: ${commit}`,
    '',
    'The harness never stores cloud credentials; a human or a CI job with the',
    'secrets must run the commands below.',
    '',
  ]
  if (target === 'cloudflare' && surface === 'web') {
    lines.push(
      '```sh',
      'pnpm install --frozen-lockfile',
      'pnpm --filter @deepseek-ai/dsh-web run build',
      'npx wrangler pages deploy apps/web/dist',
      '```',
    )
  } else if (target === 'hostinger' && surface === 'web') {
    lines.push(
      '```sh',
      'pnpm install --frozen-lockfile',
      'pnpm --filter @deepseek-ai/dsh-web run build',
      '# upload the built output and the node runtime to the VPS, then:',
      'node node_modules/.bin/dsh web --port 8080',
      '```',
    )
  } else {
    lines.push(
      '```sh',
      'pnpm install --frozen-lockfile',
      'pnpm build:lib:host',
      '# run the node service on the VPS:',
      'node node_modules/.bin/dsh web --port 8080',
      '```',
    )
  }
  lines.push('')
  return lines.join('\n')
}

/** Validate, verify, and record one publish decision for a completed app. */
export async function publishApp(options: {
  readonly appPath: string
  readonly target: PublishTarget
  readonly signal?: AbortSignal
}): Promise<PublishReport> {
  const { appPath, signal } = options
  if (!PUBLISH_TARGETS.includes(options.target)) {
    throw new Error(`publish target must be one of ${PUBLISH_TARGETS.join(', ')}`)
  }
  const spawnRecord = await readSpawnRecord(appPath, signal)
  if (spawnRecord === null) {
    throw new Error(`not a spawned factory app: no ${SPAWN_RECORD_NAME} in ${appPath}`)
  }
  const app = basename(appPath)
  const goal = parseGoal(await readFile(join(appPath, GOAL_FILE_NAME), { encoding: 'utf8', signal }))
  const last = lastMilestone(goal)
  const status = await deriveStatus(appPath, `M${last.id} ${last.title}`, signal)
  if (status !== 'complete') {
    throw new Error(`app ${app} is not complete (status ${status}); publish decisions record finished applications only`)
  }
  const commit = await requireCleanCheckout(appPath, signal)
  const surface = await detectSurface(appPath)
  if (options.target === 'cloudflare' && surface === 'headless') {
    throw new Error('a headless app cannot deploy to cloudflare; choose hostinger or catalog-only')
  }
  const decision: PublishDecision = options.target === 'catalog-only' ? 'catalog-only' : 'manifest-ready'
  const record: PublishRecord = {
    version: 1,
    app,
    decision,
    target: options.target,
    surface,
    commit,
    createdAt: new Date().toISOString(),
  }
  const recordPath = join(appPath, PUBLISH_RECORD_NAME)
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  await commitAll(appPath, `Publish: ${options.target} (${decision})`, signal)
  if (decision === 'manifest-ready') {
    const manifestPath = join(appPath, PUBLISH_MANIFEST_NAME)
    await writeFile(manifestPath, renderManifest(app, options.target, surface, commit), 'utf8')
    await commitAll(appPath, `Publish manifest for ${options.target}`, signal)
    return { app, decision, target: options.target, surface, commit, recordPath, manifestPath }
  }
  return { app, decision, target: options.target, surface, commit, recordPath }
}
