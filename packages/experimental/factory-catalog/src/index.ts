/**
 * Model-facing catalog tools: `factory_catalog` derives every spawned
 * application's state from its own files, and `factory_publish` records a
 * completed app's publish decision with a ready-to-run hosting manifest.
 * Factory-side only: a clone never catalogs or publishes itself.
 * @module @deepseek-ai/dsh-experimental-factory-catalog
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SPAWN_RECORD_NAME } from '@deepseek-ai/dsh-experimental-factory'
import type { CatalogReport, PublishReport, PublishTarget } from './catalog.ts'
import { PUBLISH_TARGETS, publishApp, scanApps } from './catalog.ts'

export const name = 'factory-catalog'
export const inject = ['tools', 'systemPrompt']

/** Deployment policy for the catalog tools. */
export interface Config {
  /** The factory checkout the catalog serves; defaults to the process working directory. */
  repositoryPath?: string
  /** Directory whose subdirectories are spawned applications; relative to repositoryPath. */
  appsDir?: string
}

/** Schemastery configuration for the catalog tools. */
export const Config: z<Config> = z.object({
  repositoryPath: z.string(),
  appsDir: z.string(),
})

interface ResolvedConfig {
  readonly repositoryPath: string
  readonly appsDir: string
}

/** Validate defaults even when a caller invokes apply() without Loader normalization. */
export function resolveConfig(config: Config): ResolvedConfig {
  const repositoryPath = config.repositoryPath?.trim() ?? process.cwd()
  if (repositoryPath.length === 0) throw new Error('factory-catalog repositoryPath must not be empty')
  const appsDir = (config.appsDir?.trim() ?? 'apps')
  if (appsDir.length === 0) throw new Error('factory-catalog appsDir must not be empty')
  return { repositoryPath, appsDir: join(repositoryPath, appsDir) }
}

const CATALOG_OUTPUT_PROPERTIES = {
  entries: { type: 'array', description: 'Spawned applications with derived status, milestones, and publish decision.' },
  skipped: { type: 'array', description: 'App directories that could not be read, with reasons.' },
} as const

const PUBLISH_OUTPUT_PROPERTIES = {
  app: { type: 'string', description: 'The app that received the decision.' },
  decision: { type: 'string', description: 'What the publish step did.' },
  target: { type: 'string', description: 'The target the decision was made for.' },
  surface: { type: 'string', description: 'The deployable surface detected in the app.' },
  commit: { type: 'string', description: 'The commit the decision was recorded at.' },
  manifestPath: { type: 'string', description: 'Path of the hosting manifest, when the decision wrote one.' },
} as const

function renderCatalog(value: CatalogReport): ContentBlock[] {
  if (value.entries.length === 0 && value.skipped.length === 0) {
    return [{ type: 'text', text: 'The catalog is empty: no spawned applications under the configured apps directory.' }]
  }
  const lines = value.entries.map(entry =>
    `- ${entry.name}: ${entry.status}, milestone M${entry.milestone}/${entry.milestonesTotal}, green at ${entry.lastGreenCommit.slice(0, 12)}${entry.publish ? `, publish ${entry.publish.decision} (${entry.publish.target})` : ', not published'}`)
  for (const item of value.skipped) lines.push(`- ${item.name}: SKIPPED (${item.reason})`)
  return [{ type: 'text', text: `Artifork catalog:\n${lines.join('\n')}` }]
}

function renderPublish(value: PublishReport): ContentBlock[] {
  return [{
    type: 'text',
    text: value.manifestPath === undefined
      ? `Recorded ${value.decision} for ${value.app} (target ${value.target}, surface ${value.surface}) at ${value.recordPath}`
      : `Recorded ${value.decision} for ${value.app} (target ${value.target}, surface ${value.surface}) at ${value.recordPath}; hosting manifest at ${value.manifestPath} — a human or CI job with the cloud credentials must run it`,
  }]
}

/** Validate factory_publish arguments: appPath and an optional known target. */
export function parsePublishArgs(args: unknown): { appPath: string; target: PublishTarget } {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('factory_publish arguments must be an object')
  }
  const record = args as Record<string, unknown>
  const appPath = record.appPath
  if (typeof appPath !== 'string' || appPath.trim().length === 0) {
    throw new Error('factory_publish requires a non-empty appPath string')
  }
  const target = record.target
  if (target === undefined) return { appPath, target: 'catalog-only' }
  if (typeof target !== 'string' || !PUBLISH_TARGETS.includes(target as PublishTarget)) {
    throw new Error(`factory_publish target must be one of ${PUBLISH_TARGETS.join(', ')}`)
  }
  return { appPath, target: target as PublishTarget }
}

/** Register the factory-side catalog policy and tools; inert inside a clone. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  if (existsSync(join(resolved.repositoryPath, SPAWN_RECORD_NAME))) return
  ctx.systemPrompt.section({
    name: 'catalog:policy',
    order: ctx.systemPrompt.getSectionOrder('TOOL_FACTORY_CATALOG'),
    text: 'The factory_catalog tool reports every spawned application: its derived status, milestone progress, last green commit, and publish decision. When an application completes its mutation goal, read the catalog, decide with the human whether to publish it to a hosting provider, and record the decision with factory_publish: catalog-only always works, and hosting targets write a ready-to-run manifest that a human or CI job with the cloud credentials must execute. Never claim an app is publishable without the catalog reporting it complete.',
  })
  ctx.tools.register(defineTool({
    name: 'factory_catalog',
    description: 'Report every spawned application: derived status, milestone progress, last green commit, publish decision.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: CATALOG_OUTPUT_PROPERTIES,
      },
      render: (_args, value) => renderCatalog(value as unknown as CatalogReport),
    },
    async execute(_args, exec) {
      const report = await scanApps(resolved.appsDir, exec.signal)
      return {
        entries: report.entries.map(entry => ({
          name: entry.name,
          appPath: entry.appPath,
          status: entry.status,
          milestone: entry.milestone,
          milestonesTotal: entry.milestonesTotal,
          lastGreenCommit: entry.lastGreenCommit,
          ...(entry.publish === undefined ? {} : { publish: { ...entry.publish } }),
        })),
        skipped: report.skipped.map(item => ({ name: item.name, reason: item.reason })),
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'factory_publish',
    description: 'Record a completed application\'s publish decision: catalog-only, or a hosting target with a ready-to-run manifest.',
    parameters: {
      appPath: {
        type: 'string',
        required: true,
        description: 'Path of the spawned application directory; it must have completed its goal.',
      },
      target: {
        type: 'string',
        description: `Publish target; one of ${PUBLISH_TARGETS.join(', ')}; defaults to catalog-only.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: PUBLISH_OUTPUT_PROPERTIES,
      },
      render: (_args, value) => renderPublish(value as unknown as PublishReport),
    },
    async execute(args, exec) {
      const parsed = parsePublishArgs(args)
      const report = await publishApp({
        appPath: parsed.appPath,
        target: parsed.target,
        signal: exec.signal,
      })
      return {
        app: report.app,
        decision: report.decision,
        target: report.target,
        surface: report.surface,
        commit: report.commit,
        ...(report.manifestPath === undefined ? {} : { manifestPath: report.manifestPath }),
      }
    },
  }))
}
