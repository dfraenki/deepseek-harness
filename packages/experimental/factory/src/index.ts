/**
 * Model-facing `spawn_and_mutate` tool: spawn an isolated clone of the running
 * checkout that then mutates itself toward a mutation goal. Explicit-ask only;
 * the loop that drives a spawned clone is mounted by the factory bundle, not
 * by this tool.
 * @module @deepseek-ai/dsh-experimental-factory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { GOAL_FILE_NAME, spawnClone } from './spawn.ts'

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
  if (referencePaths === undefined) return { goalMarkdown, targetPath }
  return { goalMarkdown, targetPath, referencePaths: referencePaths as string[] }
}

interface SpawnToolResult {
  readonly clonePath: string
  readonly sourceCommit: string
  readonly port: number
  readonly homePath: string
  readonly goalSha256: string
}

const SPAWN_OUTPUT_PROPERTIES = {
  clonePath: { type: 'string', description: 'Absolute path of the spawned clone.' },
  sourceCommit: { type: 'string', description: 'Mother checkout commit the clone was cut from.' },
  port: { type: 'number', description: 'Reserved localhost port for the clone web profile.' },
  homePath: { type: 'string', description: 'Clone-relative home directory for state and credentials.' },
  goalSha256: { type: 'string', description: 'SHA-256 of the goal file content at spawn time.' },
} as const

function renderResult(value: SpawnToolResult): ContentBlock[] {
  return [{
    type: 'text',
    text: [
      `Clone spawned at ${value.clonePath}`,
      `source commit ${value.sourceCommit}`,
      `port ${value.port}`,
      `home ${value.homePath}`,
      `goal ${GOAL_FILE_NAME} sha256 ${value.goalSha256}`,
    ].join('; '),
  }]
}

/** Register the explicit-ask spawn tool and its usage policy. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:spawn',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SPAWN'),
    text: 'Use the spawn_and_mutate tool ONLY when the human explicitly asks to spawn, replicate, or transform the factory itself. It clones this repository into an isolated directory with its own git history, home, and port, writes the mutation goal there, and never modifies the current checkout. The mutation loop that works inside a clone is a separate deployment capability; spawning does not start it.',
  })
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
      const record = await spawnClone({
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
      } satisfies SpawnToolResult
    },
  }))
}
