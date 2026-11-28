/**
 * Model-facing live preview tools for the mutation clone: `preview_start`
 * launches the clone's own web app on the port recorded at spawn,
 * `preview_status` and `preview_probe` verify the shared instance the user
 * watches, and `preview_stop` ends it. The user and the agent always see one
 * origin, so verification evidence and user experience cannot diverge.
 * @module @deepseek-ai/dsh-experimental-factory-preview
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  type ProbeReport,
  type StartReport,
  type StatusReport,
  previewStatus,
  probePreview,
  startPreview,
  stopPreview,
} from './preview.ts'

export const name = 'factory-preview'
export const inject = ['tools', 'systemPrompt']

/** Deployment policy for the live preview. */
export interface Config {
  /** The mutation clone whose app is previewed; defaults to the process working directory. */
  repositoryPath?: string
  /** Executable launching the app; default the clone's `node_modules/.bin/dsh`. */
  command?: string
  /** Arguments before the port; default `web --port`. */
  args?: string[]
  /** Start budget in milliseconds; default 120000. */
  startTimeoutMs?: number
}

/** Schemastery configuration for the live preview. */
export const Config: z<Config> = z.object({
  repositoryPath: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  startTimeoutMs: z.number(),
})

interface ResolvedConfig {
  readonly repositoryPath: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly startTimeoutMs?: number
}

/** Validate defaults even when a caller invokes apply() without Loader normalization. */
export function resolveConfig(config: Config): ResolvedConfig {
  const repositoryPath = config.repositoryPath?.trim() ?? process.cwd()
  if (repositoryPath.length === 0) throw new Error('factory-preview repositoryPath must not be empty')
  const command = config.command?.trim()
  if (command !== undefined && command.length === 0) {
    throw new Error('factory-preview command must not be empty')
  }
  const startTimeoutMs = config.startTimeoutMs
  if (startTimeoutMs !== undefined && (!Number.isSafeInteger(startTimeoutMs) || startTimeoutMs < 1)) {
    throw new Error('factory-preview startTimeoutMs must be a positive safe integer')
  }
  return {
    repositoryPath,
    ...(command === undefined ? {} : { command }),
    ...(config.args === undefined ? {} : { args: config.args }),
    ...(startTimeoutMs === undefined ? {} : { startTimeoutMs }),
  }
}

/** Validate preview_start or preview_probe arguments before any launch. */
export function parsePreviewArgs(args: unknown): { path?: string } {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('preview arguments must be an object')
  }
  const record = args as Record<string, unknown>
  if (record.path === undefined) return {}
  if (typeof record.path !== 'string') {
    throw new Error('preview path must be a string')
  }
  return { path: record.path }
}

const START_OUTPUT_PROPERTIES = {
  running: { type: 'boolean', description: 'Whether the shared instance is serving.' },
  port: { type: 'number', description: 'The reserved port the app serves on.' },
  url: { type: 'string', description: 'The origin both the user and the agent share.' },
  pid: { type: 'number', description: 'Preview process id, when running.' },
  launched: { type: 'boolean', description: 'True when this call launched the process; false when a live one was re-used.' },
  logTail: { type: 'string', description: 'Tail of the preview server log.' },
} as const

function renderStart(value: StartReport): ContentBlock[] {
  const how = value.launched ? 'launched' : 'already serving'
  return [{
    type: 'text',
    text: `Preview ${how} at ${value.url} (port ${value.port}); the user watches this same origin. Probe it with preview_probe before trusting it.`,
  }]
}

const STATUS_OUTPUT_PROPERTIES = {
  running: { type: 'boolean', description: 'Whether the recorded preview process is alive.' },
  port: { type: 'number', description: 'The reserved port, when a spawn record exists.' },
  url: { type: 'string', description: 'The shared origin, when a spawn record exists.' },
  pid: { type: 'number', description: 'Preview process id, when running.' },
  logTail: { type: 'string', description: 'Tail of the preview server log.' },
} as const

function renderStatus(value: StatusReport): ContentBlock[] {
  const where = value.url === undefined ? '' : ` at ${value.url}`
  const state = value.running ? `serving${where}` : 'not running'
  return [{
    type: 'text',
    text: `Preview is ${state}. Log tail: ${value.logTail.length === 0 ? '(empty)' : `${value.logTail.length} chars, ending: ${value.logTail.slice(-300)}`}`,
  }]
}

const PROBE_OUTPUT_PROPERTIES = {
  url: { type: 'string', description: 'The origin that was probed.' },
  status: { type: 'number', description: 'HTTP status code, or 0 when the origin did not answer.' },
  contentType: { type: 'string', description: 'Response content type, when answered.' },
  bodyExcerpt: { type: 'string', description: 'First characters of the response body, when answered.' },
} as const

function renderProbe(value: ProbeReport): ContentBlock[] {
  if (value.status === 0) {
    return [{ type: 'text', text: `No answer from ${value.url}: the preview is not serving; start it with preview_start and check the log.` }]
  }
  const type = value.contentType === undefined ? '' : ` (${value.contentType})`
  const body = value.bodyExcerpt === undefined ? '' : `; body starts: ${JSON.stringify(value.bodyExcerpt.slice(0, 120))}`
  return [{ type: 'text', text: `GET ${value.url} → ${value.status}${type}${body}` }]
}

/** Register the live preview tools and the shared-instance policy section. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'preview:policy',
    order: ctx.systemPrompt.getSectionOrder('TOOL_FACTORY_PREVIEW'),
    text: 'The mutation clone runs one shared live preview: preview_start launches this clone\'s own app on the port recorded at spawn, and the user watches that exact origin from the factory UI. Every preview_probe request hits the same instance the user sees, so verification evidence and user experience cannot diverge — and tests that mutate application state must clean up after themselves, or the user\'s session is trashed mid-watch. A preview that will not start or answer is a red gate: report it with its log tail, never hide it. The clone is untrusted code: never point the preview at the factory mother\'s origin, cookies, or credentials. Outside a spawned mutation clone the preview tools refuse to operate.',
  })
  ctx.tools.register(defineTool({
    name: 'preview_start',
    description: 'Launch the clone\'s web app on its reserved port so the user and this agent share one preview instance; idempotent when already serving.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: START_OUTPUT_PROPERTIES,
      },
      render: (_args, value) => renderStart(value as unknown as StartReport),
    },
    async execute(_args, exec) {
      return startPreview(resolved.repositoryPath, {
        ...(resolved.command === undefined ? {} : { command: resolved.command }),
        ...(resolved.args === undefined ? {} : { args: resolved.args }),
        ...(resolved.startTimeoutMs === undefined ? {} : { startTimeoutMs: resolved.startTimeoutMs }),
        signal: exec.signal,
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'preview_status',
    description: 'Report whether the shared preview instance is serving, on which port, with the server log tail.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: STATUS_OUTPUT_PROPERTIES,
      },
      render: (_args, value) => renderStatus(value as unknown as StatusReport),
    },
    async execute(_args, exec) {
      return previewStatus(resolved.repositoryPath, exec.signal)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'preview_stop',
    description: 'Stop the shared preview instance; milestone state is preserved and preview_start relaunches it.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stopped: { type: 'boolean', description: 'Always true; stopping an already stopped preview is idempotent.' },
        },
      },
      render: () => [{ type: 'text', text: 'Preview stopped; milestone state is preserved. preview_start relaunches it on the same port.' }],
    },
    async execute(_args, exec) {
      await stopPreview(resolved.repositoryPath, exec.signal)
      return { stopped: true }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'preview_probe',
    description: 'One HTTP request against the shared preview origin — the same instance the user watches; the mechanical way to verify the app answers.',
    parameters: {
      path: { type: 'string', description: 'Absolute path to request; defaults to /.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: PROBE_OUTPUT_PROPERTIES,
      },
      render: (_args, value) => renderProbe(value as unknown as ProbeReport),
    },
    async execute(args, exec) {
      const parsed = parsePreviewArgs(args)
      const report = await probePreview(resolved.repositoryPath, parsed.path ?? '/', exec.signal)
      return { ...report }
    },
  }))
}
