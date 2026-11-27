/**
 * The factory's coaching layer: three read-only coach observers (process,
 * intent, skills) that submit evidence-cited directives into a deterministic
 * channel, a governed directive section composed fresh at every prompt
 * assembly, and the skill master's boundary powers (pause and resume).
 * @module @deepseek-ai/dsh-experimental-factory-observers
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_MAX_SECTION_CHARS,
  type CoachProposal,
  clearPauseFlag,
  composeDirectives,
  loadGovernedSync,
  loadProposals,
  readPauseReason,
  saveProposal,
  setPauseFlag,
} from './channel.ts'

export const name = 'factory-observers'
export const inject = ['tools', 'systemPrompt']

/** Deployment policy for the coaching layer. */
export interface Config {
  /** The clone the coaches observe; defaults to the process working directory. */
  repositoryPath?: string
  /** Character budget for the governed directive section (default 2048). */
  maxSectionChars?: number
}

/** Schemastery configuration for the coaching layer. */
export const Config: z<Config> = z.object({
  repositoryPath: z.string(),
  maxSectionChars: z.number(),
})

interface ResolvedConfig {
  readonly repositoryPath: string
  readonly maxSectionChars: number
}

/** Validate defaults even when a caller invokes apply() without Loader normalization. */
export function resolveConfig(config: Config): ResolvedConfig {
  const repositoryPath = config.repositoryPath?.trim() ?? process.cwd()
  if (repositoryPath.length === 0) throw new Error('factory-observers repositoryPath must not be empty')
  const maxSectionChars = config.maxSectionChars ?? DEFAULT_MAX_SECTION_CHARS
  if (!Number.isSafeInteger(maxSectionChars) || maxSectionChars < 1) {
    throw new Error('factory-observers maxSectionChars must be a positive safe integer')
  }
  return { repositoryPath, maxSectionChars }
}

/** Compose the governed directive section body for one prompt assembly. */
export function directiveSectionText(resolved: ResolvedConfig): string {
  const governed = loadGovernedSync(resolved.repositoryPath, resolved.maxSectionChars)
  if (governed.included === 0) return ''
  return [
    'Coach directives for the next round (newest evidence wins; boundary-scoped advice):',
    governed.text,
    governed.dropped > 0 ? `${governed.dropped} further directive(s) were dropped by the section budget.` : '',
  ].filter(line => line.length > 0).join('\n')
}

interface ProposeCallArgs {
  coach: string
  topic: string
  evidence: string
  directive: string
}

/** Validate coach_propose arguments before any channel write. */
export function parseProposeArgs(args: unknown): ProposeCallArgs {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('coach_propose arguments must be an object')
  }
  const record = args as Record<string, unknown>
  const strings: Array<keyof ProposeCallArgs> = ['coach', 'topic', 'evidence', 'directive']
  for (const key of strings) {
    if (typeof record[key] !== 'string') {
      throw new Error(`coach_propose requires a non-empty ${key} string`)
    }
  }
  return {
    coach: record.coach as string,
    topic: record.topic as string,
    evidence: record.evidence as string,
    directive: record.directive as string,
  }
}

/** Require the skill master identity for the boundary powers. */
export function requireSkillMaster(args: unknown): { coach: string; reason?: string } {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('arguments must be an object')
  }
  const record = args as Record<string, unknown>
  if (typeof record.coach !== 'string') {
    throw new Error('requires a non-empty coach string')
  }
  if (record.coach !== 'skills') {
    throw new Error('only the skill master may pause or resume the loop')
  }
  if (record.reason === undefined) return { coach: record.coach }
  if (typeof record.reason !== 'string') {
    throw new Error('the pause reason must be a string')
  }
  return { coach: record.coach, reason: record.reason }
}

/** Validate a coach_pause call: skill master identity plus a stated reason. */
export function parsePauseArgs(args: unknown): { coach: string; reason: string } {
  const parsed = requireSkillMaster(args)
  if (parsed.reason === undefined) {
    throw new Error('the pause reason must be a string')
  }
  return { coach: parsed.coach, reason: parsed.reason }
}

const PROPOSE_OUTPUT_PROPERTIES = {
  coach: { type: 'string', description: 'Coach that submitted the directive.' },
  topic: { type: 'string', description: 'Kebab-slug topic; newest proposal on a topic supersedes older ones.' },
  seq: { type: 'number', description: 'Assigned monotonic sequence for the topic.' },
  accepted: { type: 'boolean', description: 'Always true; saveProposal rejects stale or invalid proposals.' },
} as const

function renderPropose(value: CoachProposal): ContentBlock[] {
  return [{
    type: 'text',
    text: `[${value.coach}/${value.topic}] directive accepted (seq ${value.seq}); it applies at the next round boundary`,
  }]
}

const OBSERVE_OUTPUT_PROPERTIES = {
  paused: { type: 'boolean', description: 'Whether a coach pause flag is present.' },
  pauseReason: { type: 'string', description: 'Recorded pause reason, when paused.' },
  included: { type: 'number', description: 'Directives in the governed section.' },
  dropped: { type: 'number', description: 'Valid directives dropped by the section budget.' },
  directives: { type: 'array', description: 'Governed directive lines, in priority order.' },
} as const

interface ObserveResult {
  readonly paused: boolean
  readonly pauseReason?: string
  readonly included: number
  readonly dropped: number
  readonly directives: readonly string[]
}

function renderObserve(value: ObserveResult): ContentBlock[] {
  const pause = value.paused ? `paused: ${value.pauseReason ?? ''}` : 'not paused'
  return [{
    type: 'text',
    text: `Coach channel: ${pause}; ${value.included} directive(s) governed, ${value.dropped} dropped by budget.`,
  }]
}

const PAUSE_OUTPUT_PROPERTIES = {
  paused: { type: 'boolean', description: 'True after pausing; false after resuming.' },
  reason: { type: 'string', description: 'The recorded pause reason, when pausing.' },
} as const

function renderPause(): ContentBlock[] {
  return [{ type: 'text', text: 'Loop paused at the next round boundary; milestone state is preserved. Resume with coach_resume once reconfiguration is in place.' }]
}

function renderResume(): ContentBlock[] {
  return [{ type: 'text', text: 'Pause cleared; the rounds driver will start the next checkpoint round.' }]
}

/** Register the coaching channel tools and the governed directive section. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'observers:policy',
    order: ctx.systemPrompt.getSectionOrder('TOOL_FACTORY_OBSERVERS'),
    text: 'Three coach observers watch this mutation run: the process coach (how the work is executed), the intent coach (whether the work still serves the human request), and the skill master (which skills the agent needs, and the only observer allowed to pause the loop). They submit directives with coach_propose; every directive must cite observable evidence, the newest one on a topic supersedes older ones, and the governed section is applied only at round boundaries. A coach pause halts the loop before the next round with milestone state preserved; coach_resume clears it. Coaches never execute project code and never modify the goal file.',
  })
  ctx.systemPrompt.section({
    name: 'observers:directives',
    order: ctx.systemPrompt.getSectionOrder('TOOL_FACTORY_OBSERVERS') + 1,
    text: () => directiveSectionText(resolved),
    interpolate: false,
  })
  ctx.tools.register(defineTool({
    name: 'coach_propose',
    description: 'Submit one evidence-cited coach directive; the newest proposal on a topic supersedes the previous ones and applies at the next round boundary.',
    parameters: {
      coach: { type: 'string', required: true, description: 'One of process, intent, skills.' },
      topic: { type: 'string', required: true, description: 'Kebab-slug topic of at most 40 characters.' },
      evidence: { type: 'string', required: true, description: 'Observable evidence the directive is based on.' },
      directive: { type: 'string', required: true, description: 'Boundary-scoped advice for the next round.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: PROPOSE_OUTPUT_PROPERTIES,
      },
      render: (_args, value) => renderPropose(value as unknown as CoachProposal),
    },
    async execute(args, exec) {
      const parsed = parseProposeArgs(args)
      const proposal = await saveProposal(resolved.repositoryPath, parsed, exec.signal)
      return { ...proposal, accepted: true }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'coach_observe',
    description: 'Read the current coaching channel: pause state and the governed directives with their evidence.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: OBSERVE_OUTPUT_PROPERTIES,
      },
      render: (_args, value) => renderObserve(value as unknown as ObserveResult),
    },
    async execute(_args, exec) {
      const [proposals, pauseReason] = await Promise.all([
        loadProposals(resolved.repositoryPath),
        readPauseReason(resolved.repositoryPath, exec.signal),
      ])
      const governed = composeDirectives(proposals, resolved.maxSectionChars)
      return {
        paused: pauseReason !== null,
        ...(pauseReason === null ? {} : { pauseReason }),
        included: governed.included,
        dropped: governed.dropped,
        directives: governed.text.length === 0 ? [] : governed.text.split('\n'),
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'coach_pause',
    description: 'Skill master only: pause the mutation loop at the next round boundary, with milestone state preserved, stating the reason.',
    parameters: {
      coach: { type: 'string', required: true, description: 'Must be skills; the other coaches cannot pause the loop.' },
      reason: { type: 'string', required: true, description: 'Why the loop must stop, with the evidence that justifies it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: PAUSE_OUTPUT_PROPERTIES,
      },
      render: () => renderPause(),
    },
    async execute(args, _exec) {
      const parsed = parsePauseArgs(args)
      const reason = await setPauseFlag(resolved.repositoryPath, parsed.reason)
      return { paused: true, reason }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'coach_resume',
    description: 'Skill master only: clear a coach pause so the rounds driver starts the next checkpoint round.',
    parameters: {
      coach: { type: 'string', required: true, description: 'Must be skills; the other coaches cannot resume the loop.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { paused: PAUSE_OUTPUT_PROPERTIES.paused },
      },
      render: () => renderResume(),
    },
    async execute(args, _exec) {
      requireSkillMaster(args)
      await clearPauseFlag(resolved.repositoryPath)
      return { paused: false }
    },
  }))
}
