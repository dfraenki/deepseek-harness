/**
 * The mutation clone's shared live preview: launch the clone's own web app on
 * the port recorded at spawn, keep its state and logs under
 * `.mutation-home/preview/`, and expose idempotent start, status, stop, and
 * HTTP probe operations. One instance, two observers: the user watches this
 * origin from the mother's UI and the agent probes the same one.
 * @module @deepseek-ai/dsh-experimental-factory-preview/preview
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MUTATION_HOME_NAME,
  SPAWN_RECORD_NAME,
  readSpawnRecord,
  type SpawnRecord,
} from '@deepseek-ai/dsh-experimental-factory'

/** Clone-relative preview state directory, inside the git-excluded home. */
export const PREVIEW_DIR_NAME = join(MUTATION_HOME_NAME, 'preview')

/** Preview process state file. */
export const PREVIEW_STATE_NAME = join(PREVIEW_DIR_NAME, 'state.json')

/** Preview server output log. */
export const PREVIEW_LOG_NAME = join(PREVIEW_DIR_NAME, 'server.log')

/** Default command: the clone's own CLI, resolved against the clone. */
export const DEFAULT_DSH_BIN = join('node_modules', '.bin', 'dsh')

/** Default launch arguments for the clone's web profile. */
export const DEFAULT_DSH_ARGS = ['web', '--port'] as const

/** Milliseconds to wait for the origin to answer HTTP before failing the start. */
export const DEFAULT_START_TIMEOUT_MS = 120_000

/** Milliseconds between readiness probes. */
export const PROBE_INTERVAL_MS = 500

/** Milliseconds a single readiness request may take. */
export const PROBE_TIMEOUT_MS = 1_000

/** Grace period between SIGTERM and SIGKILL when stopping. */
export const STOP_GRACE_MS = 3_000

/** Maximum characters of server log returned by status and start. */
export const LOG_TAIL_CHARS = 8_000

/** Maximum characters of a probe body excerpt. */
export const PROBE_EXCERPT_CHARS = 2_000

/** Spawn-command facts persisted while the preview runs. */
export interface PreviewState {
  /** Whether the preview process was launched and not yet stopped. */
  readonly running: boolean
  /** Child process id; present because a spawn that produced none is abandoned before the state is written. */
  readonly pid: number
  /** The reserved port the app serves on. */
  readonly port: number
  /** ISO timestamp of the launch. */
  readonly startedAt: string
  /** The exact command line launched, for diagnosis. */
  readonly command: string
}

/** Options for one preview launch; command overrides exist for tests and alternative launchers. */
export interface PreviewOptions {
  /** Executable to launch; default the clone's `node_modules/.bin/dsh`. */
  readonly command?: string
  /** Arguments before the port; default `web --port`. */
  readonly args?: readonly string[]
  /** Start budget in milliseconds; default 120000. */
  readonly startTimeoutMs?: number
  /** Cancellation signal forwarded to readiness polling. */
  readonly signal?: AbortSignal
}

/** Report of one preview start or idempotent re-use. */
export interface StartReport {
  /** Whether the shared instance is serving. */
  readonly running: boolean
  /** The reserved port. */
  readonly port: number
  /** The origin both observers share. */
  readonly url: string
  /** Child process id, when running. */
  readonly pid?: number
  /** Whether this call launched the process or re-used a live one. */
  readonly launched: boolean
  /** Tail of the server log. */
  readonly logTail: string
}

/** Report of one preview status check. */
export interface StatusReport {
  /** Whether the recorded process is alive. */
  readonly running: boolean
  /** The reserved port, when a spawn record exists. */
  readonly port?: number
  /** The shared origin, when the spawn record exists. */
  readonly url?: string
  /** Child process id, when running. */
  readonly pid?: number
  /** Tail of the server log. */
  readonly logTail: string
}

/** Report of one HTTP probe against the shared instance. */
export interface ProbeReport {
  /** The origin that was probed. */
  readonly url: string
  /** HTTP status code, or 0 when the origin did not answer. */
  readonly status: number
  /** Response content type, when answered. */
  readonly contentType?: string
  /** First characters of the response body, when answered. */
  readonly bodyExcerpt?: string
}

function previewHome(clonePath: string, record: SpawnRecord): string {
  return join(clonePath, record.homePath)
}

function previewUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

/** True when a process id exists and answers a zero-signal probe. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readPreviewState(clonePath: string, signal?: AbortSignal): Promise<PreviewState | null> {
  try {
    const raw = await readFile(join(clonePath, PREVIEW_STATE_NAME), { encoding: 'utf8', signal })
    return JSON.parse(raw) as PreviewState
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writePreviewState(clonePath: string, state: PreviewState): Promise<void> {
  await mkdir(join(clonePath, PREVIEW_DIR_NAME), { recursive: true })
  await writeFile(join(clonePath, PREVIEW_STATE_NAME), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

async function appendPreviewLog(clonePath: string, line: string): Promise<void> {
  try {
    await mkdir(join(clonePath, PREVIEW_DIR_NAME), { recursive: true })
    await appendFile(join(clonePath, PREVIEW_LOG_NAME), line, 'utf8')
  } catch {
  }
}

async function tailPreviewLog(clonePath: string): Promise<string> {
  try {
    const raw = await readFile(join(clonePath, PREVIEW_LOG_NAME), { encoding: 'utf8' })
    return raw.length > LOG_TAIL_CHARS ? raw.slice(-LOG_TAIL_CHARS) : raw
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/** One HTTP request to the shared origin; resolves on any response, rejects when nothing answers. */
export async function probeOrigin(port: number, path = '/', signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  const signals = signal === undefined ? timeout : AbortSignal.any([timeout, signal])
  return fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', signal: signals })
}

async function isOriginUp(port: number, signal?: AbortSignal): Promise<boolean> {
  try {
    await probeOrigin(port, '/', signal)
    return true
  } catch {
    return false
  }
}

/** Require a spawn record: preview tools only operate inside a mutation clone. */
export async function requireSpawnRecord(clonePath: string, signal?: AbortSignal): Promise<SpawnRecord> {
  const record = await readSpawnRecord(clonePath, signal)
  if (record === null) {
    throw new Error(`no ${SPAWN_RECORD_NAME} in this directory: preview tools operate inside a spawned mutation clone`)
  }
  return record
}

async function settleRunningState(clonePath: string, state: PreviewState | null): Promise<PreviewState | null> {
  if (state === null || !state.running) return null
  if (isPidAlive(state.pid)) return state
  await writePreviewState(clonePath, { ...state, running: false })
  return null
}

/**
 * Abandon a launch that never became ready: kill the child so no orphaned
 * process outlives the failed start, mark the state stopped, and rethrow.
 */
async function abandonLaunch(clonePath: string, child: ChildProcess, state: PreviewState, reason: string): Promise<never> {
  if (isPidAlive(state.pid)) child.kill('SIGKILL')
  await appendPreviewLog(clonePath, `[preview] launch abandoned: ${reason}\n`)
  await writePreviewState(clonePath, { ...state, running: false })
  throw new Error(reason)
}

/**
 * Launch the clone's web app on its reserved port. Idempotent: a live
 * recorded process is re-used; a dead one is cleaned up and restarted.
 */
export async function startPreview(clonePath: string, options: PreviewOptions = {}): Promise<StartReport> {
  if (options.signal?.aborted) throw new Error('preview start aborted')
  const record = await requireSpawnRecord(clonePath, options.signal)
  const live = await settleRunningState(clonePath, await readPreviewState(clonePath, options.signal))
  if (live !== null) {
    return {
      running: true,
      port: live.port,
      url: previewUrl(live.port),
      pid: live.pid,
      launched: false,
      logTail: await tailPreviewLog(clonePath),
    }
  }
  const command = options.command ?? join(clonePath, DEFAULT_DSH_BIN)
  const args = [...(options.args ?? DEFAULT_DSH_ARGS), String(record.port)]
  await appendPreviewLog(clonePath, `[preview] launching ${command} ${args.join(' ')}\n`)
  const child = spawn(command, args, {
    cwd: clonePath,
    env: { ...process.env, DSH_HOME: previewHome(clonePath, record) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const pid = child.pid
  if (pid === undefined) {
    const reason = await new Promise<string>(resolve => child.once('error', error => resolve(error.message)))
    await appendPreviewLog(clonePath, `[preview] launch abandoned: ${reason}\n`)
    throw new Error(`could not launch the clone's app (${reason}); install the clone's dependencies first`)
  }
  const state: PreviewState = {
    running: true,
    pid,
    port: record.port,
    startedAt: new Date().toISOString(),
    command: `${command} ${args.join(' ')}`,
  }
  await writePreviewState(clonePath, state)
  child.stdout?.on('data', chunk => {
    void appendPreviewLog(clonePath, String(chunk))
  })
  child.stderr?.on('data', chunk => {
    void appendPreviewLog(clonePath, String(chunk))
  })
  child.on('exit', code => {
    void appendPreviewLog(clonePath, `[preview] process exited with code ${code}\n`)
  })

  const budget = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
  const deadline = Date.now() + budget
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      await abandonLaunch(clonePath, child, state, 'preview start aborted')
    }
    if (child.exitCode !== null) {
      await abandonLaunch(clonePath, child, state, `the clone's app exited with code ${child.exitCode} during startup; check the preview log`)
    }
    if (await isOriginUp(record.port, options.signal)) {
      return {
        running: true,
        port: record.port,
        url: previewUrl(record.port),
        pid: state.pid,
        launched: true,
        logTail: await tailPreviewLog(clonePath),
      }
    }
    await new Promise(resolve => setTimeout(resolve, PROBE_INTERVAL_MS))
  }
  return abandonLaunch(clonePath, child, state, `the clone's app did not answer on port ${record.port} within ${budget}ms; check the preview log`)
}

/** Report the current preview state without launching anything. */
export async function previewStatus(clonePath: string, signal?: AbortSignal): Promise<StatusReport> {
  const record = await readSpawnRecord(clonePath, signal)
  const state = await settleRunningState(clonePath, await readPreviewState(clonePath, signal))
  return {
    running: state !== null,
    ...(record === null ? {} : { port: record.port }),
    ...(record === null ? {} : { url: previewUrl(record.port) }),
    ...(state !== null ? { pid: state.pid } : {}),
    logTail: await tailPreviewLog(clonePath),
  }
}

/** Stop the recorded preview process; a stopped preview is idempotent. */
export async function stopPreview(clonePath: string, signal?: AbortSignal): Promise<void> {
  const state = await readPreviewState(clonePath, signal)
  if (state === null || !state.running) return
  if (isPidAlive(state.pid)) {
    process.kill(state.pid, 'SIGTERM')
    const deadline = Date.now() + STOP_GRACE_MS
    while (Date.now() < deadline && isPidAlive(state.pid)) {
      await new Promise(resolve => setTimeout(resolve, PROBE_INTERVAL_MS))
    }
    if (isPidAlive(state.pid)) process.kill(state.pid, 'SIGKILL')
  }
  await writePreviewState(clonePath, { ...state, running: false })
}

/**
 * Probe the shared instance the way the user sees it: one HTTP request
 * against the reserved origin, reporting status, content type, and a body
 * excerpt for gate evidence.
 */
export async function probePreview(clonePath: string, path = '/', signal?: AbortSignal): Promise<ProbeReport> {
  const record = await requireSpawnRecord(clonePath, signal)
  let response: Response
  try {
    response = await probeOrigin(record.port, path, signal)
  } catch {
    return { url: previewUrl(record.port), status: 0 }
  }
  const excerpt = await response.text()
  const contentType = response.headers.get('content-type')
  return {
    url: previewUrl(record.port),
    status: response.status,
    ...(contentType === null ? {} : { contentType }),
    ...(excerpt.length === 0 ? {} : { bodyExcerpt: excerpt.slice(0, PROBE_EXCERPT_CHARS) }),
  }
}

/** Remove the preview state and log; used when a clone is torn down. */
export async function clearPreview(clonePath: string): Promise<void> {
  await rm(join(clonePath, PREVIEW_DIR_NAME), { recursive: true, force: true })
}
