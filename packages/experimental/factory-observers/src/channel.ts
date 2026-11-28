/**
 * The deterministic directive channel between the coach observers and the
 * mutation agent: evidence-validated proposals under `.coaches/proposals/`,
 * newest-wins supersede per topic, one size-capped governed section, and the
 * skill master's pause flag. Pure mechanics — no model judgment here.
 * @module @deepseek-ai/dsh-experimental-factory-observers/channel
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { readdirSync as readdirSyncEntries, readFileSync as readFileSyncText, type Dirent } from 'node:fs'
import { join } from 'node:path'

/** Clone-relative root directory of the coaching channel. */
export const COACHES_DIR_NAME = '.coaches'

/** Clone-relative directory holding one proposal file per coach and topic. */
export const PROPOSALS_DIR_NAME = join(COACHES_DIR_NAME, 'proposals')

/** Clone-relative pause flag the rounds driver honors before each round (L2). */
export const PAUSE_FLAG_NAME = join(COACHES_DIR_NAME, 'PAUSE')

/** The three coach observers, in governed-section priority order. */
export const COACH_PRIORITY = ['process', 'intent', 'skills'] as const

/** Valid coach identities allowed to submit proposals or pause the loop. */
export type CoachName = (typeof COACH_PRIORITY)[number]

/** Default character budget for the governed directive section. */
export const DEFAULT_MAX_SECTION_CHARS = 2048

/** One accepted coach directive proposal. */
export interface CoachProposal {
  /** Which coach submitted it. */
  readonly coach: CoachName
  /** Kebab-slug topic; the newest proposal on a topic supersedes older ones. */
  readonly topic: string
  /** Monotonic per-topic sequence assigned on save. */
  readonly seq: number
  /** Observable evidence the directive is based on; never a bare opinion. */
  readonly evidence: string
  /** The directive itself, boundary-scoped advice for the next round. */
  readonly directive: string
}

/** Input for a new proposal; the sequence is assigned on save. */
export interface ProposalInput {
  /** Which coach submitted it. */
  readonly coach: string
  /** Kebab-slug topic. */
  readonly topic: string
  /** Observable evidence. */
  readonly evidence: string
  /** The directive. */
  readonly directive: string
}

/** The governed composition of current proposals. */
export interface GovernedDirectives {
  /** Composed section body; empty when no directive is active. */
  readonly text: string
  /** How many directives made it into the section. */
  readonly included: number
  /** How many valid directives were dropped by the size cap. */
  readonly dropped: number
}

function isKebabTopic(value: string): boolean {
  return value.length > 0 && value.length <= 40 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)
}

/** Validate a proposal input; throws with the specific rule that was violated. */
export function validateProposal(input: ProposalInput): Omit<CoachProposal, 'seq'> {
  const coach = COACH_PRIORITY.find(name => name === input.coach)
  if (coach === undefined) {
    throw new Error(`coach must be one of ${COACH_PRIORITY.join(', ')}`)
  }
  const topic = input.topic.trim()
  if (!isKebabTopic(topic)) {
    throw new Error('topic must be a lowercase kebab slug of at most 40 characters')
  }
  const evidence = input.evidence.trim()
  if (evidence.length === 0) {
    throw new Error('a directive must cite non-empty observable evidence')
  }
  const directive = input.directive.trim()
  if (directive.length === 0) {
    throw new Error('the directive text must be non-empty')
  }
  return { coach, topic, evidence, directive }
}

/**
 * Save one proposal: the newest write on a coach-topic file always supersedes
 * the previous one, and the saved sequence is the previous sequence plus one,
 * so supersede order is durable and observable.
 */
export async function saveProposal(
  clonePath: string,
  input: ProposalInput,
  signal?: AbortSignal,
): Promise<CoachProposal> {
  const validated = validateProposal(input)
  const file = join(clonePath, PROPOSALS_DIR_NAME, validated.coach, `${validated.topic}.json`)
  let seq = 1
  const existing = await readFile(file, { encoding: 'utf8', signal }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (existing !== null) {
    try {
      const parsed = JSON.parse(existing) as { seq?: unknown }
      if (typeof parsed.seq === 'number' && Number.isSafeInteger(parsed.seq) && parsed.seq >= 1) {
        seq = parsed.seq + 1
      }
    } catch {
      seq = 1
    }
  }
  const proposal: CoachProposal = { ...validated, seq }
  await mkdir(join(clonePath, PROPOSALS_DIR_NAME, validated.coach), { recursive: true })
  await writeFile(file, `${JSON.stringify({
    seq: proposal.seq,
    evidence: proposal.evidence,
    directive: proposal.directive,
  }, null, 2)}\n`, 'utf8')
  return proposal
}

/** Read every valid proposal from the channel; malformed entries are skipped. */
export async function loadProposals(clonePath: string): Promise<CoachProposal[]> {
  const root = join(clonePath, PROPOSALS_DIR_NAME)
  const coachDirs = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const proposals: CoachProposal[] = []
  for (const coachDir of coachDirs) {
    if (!coachDir.isDirectory() || !(COACH_PRIORITY as readonly string[]).includes(coachDir.name)) continue
    const files = await readdir(join(root, coachDir.name), { withFileTypes: true })
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue
      const topic = file.name.slice(0, -'.json'.length)
      const raw = await readFile(join(root, coachDir.name, file.name), { encoding: 'utf8' }).catch(() => null)
      if (raw === null) continue
      let parsed: { seq?: unknown; evidence?: unknown; directive?: unknown }
      try {
        parsed = JSON.parse(raw) as { seq?: unknown; evidence?: unknown; directive?: unknown }
      } catch {
        continue
      }
      if (typeof parsed.seq !== 'number' || !Number.isSafeInteger(parsed.seq) || parsed.seq < 1) continue
      if (typeof parsed.evidence !== 'string' || typeof parsed.directive !== 'string') continue
      try {
        const validated = validateProposal({
          coach: coachDir.name,
          topic,
          evidence: parsed.evidence,
          directive: parsed.directive,
        })
        proposals.push({ ...validated, seq: parsed.seq })
      } catch {
        continue
      }
    }
  }
  return proposals
}

/**
 * Compose the governed directive section: proposals in coach priority order
 * (process, intent, skills) then topic order, each rendered as one
 * evidence-cited line, until the size budget is exhausted; anything beyond
 * the budget is counted as dropped, never silently truncated mid-line.
 */
export function composeDirectives(
  proposals: readonly CoachProposal[],
  maxChars = DEFAULT_MAX_SECTION_CHARS,
): GovernedDirectives {
  const ordered = [...proposals].sort((a, b) => {
    const coachDelta = COACH_PRIORITY.indexOf(a.coach) - COACH_PRIORITY.indexOf(b.coach)
    if (coachDelta !== 0) return coachDelta
    return a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0
  })
  const lines: string[] = []
  let dropped = 0
  for (const proposal of ordered) {
    const line = `- [${proposal.coach}/${proposal.topic}] ${proposal.directive} (evidence: ${proposal.evidence})`
    const candidate = lines.length === 0 ? line : `${lines.join('\n')}\n${line}`
    if (candidate.length > maxChars) {
      dropped++
      continue
    }
    lines.push(line)
  }
  return { text: lines.join('\n'), included: lines.length, dropped }
}

/** Synchronous channel read for prompt-assembly providers; fail-soft by design. */
export function loadGovernedSync(clonePath: string, maxChars = DEFAULT_MAX_SECTION_CHARS): GovernedDirectives {
  const root = join(clonePath, PROPOSALS_DIR_NAME)
  let coachDirs: Dirent[]
  try {
    coachDirs = readdirSyncEntries(root, { withFileTypes: true })
  } catch {
    return { text: '', included: 0, dropped: 0 }
  }
  const proposals: CoachProposal[] = []
  for (const coachDir of coachDirs) {
    if (!coachDir.isDirectory() || !(COACH_PRIORITY as readonly string[]).includes(coachDir.name)) continue
    let files: Dirent[]
    try {
      files = readdirSyncEntries(join(root, coachDir.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue
      const topic = file.name.slice(0, -'.json'.length)
      let raw: string
      try {
        raw = readFileSyncText(join(root, coachDir.name, file.name), 'utf8')
        const parsed = JSON.parse(raw) as { seq?: unknown; evidence?: unknown; directive?: unknown }
        if (typeof parsed.seq !== 'number' || !Number.isSafeInteger(parsed.seq) || parsed.seq < 1) continue
        if (typeof parsed.evidence !== 'string' || typeof parsed.directive !== 'string') continue
        const validated = validateProposal({
          coach: coachDir.name,
          topic,
          evidence: parsed.evidence,
          directive: parsed.directive,
        })
        proposals.push({ ...validated, seq: parsed.seq })
      } catch {
        continue
      }
    }
  }
  return composeDirectives(proposals, maxChars)
}

/** Write the coach pause flag with its reason; the driver stops before the next round. */
export async function setPauseFlag(clonePath: string, reason: string): Promise<string> {
  const trimmed = reason.trim()
  if (trimmed.length === 0) {
    throw new Error('a pause must state its reason')
  }
  await mkdir(join(clonePath, COACHES_DIR_NAME), { recursive: true })
  await writeFile(join(clonePath, PAUSE_FLAG_NAME), `${trimmed}\n`, 'utf8')
  return trimmed
}

/** Read the pause reason, or null when the loop is not paused. */
export async function readPauseReason(clonePath: string, signal?: AbortSignal): Promise<string | null> {
  const raw = await readFile(join(clonePath, PAUSE_FLAG_NAME), { encoding: 'utf8', signal }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  return raw === null ? null : raw.trim()
}

/** Clear the coach pause flag; a missing flag is already resumed. */
export async function clearPauseFlag(clonePath: string): Promise<void> {
  await rm(join(clonePath, PAUSE_FLAG_NAME), { force: true })
}
