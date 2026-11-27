/**
 * Machine-readable slices of the immutable mutation goal: the milestone order
 * and the executable acceptance criteria the loop's verifier runs.
 * @module @deepseek-ai/dsh-experimental-factory/goal
 */

/** One ordered milestone of the mutation goal. */
export interface GoalMilestone {
  /** Milestone number from the goal file (`- M1: title`). */
  readonly id: number
  /** Milestone title after the id. */
  readonly title: string
}

/** One executable acceptance check bound to a milestone. */
export interface GoalCriterion {
  /** Milestone this check gates. */
  readonly milestone: number
  /** The shell command the verifier runs inside the clone. */
  readonly command: string
  /** The expected outcome text after the command. */
  readonly description: string
}

/** The parsed machine-readable goal contract. */
export interface ParsedGoal {
  /** Ordered milestones as defined in the goal file; parseGoal guarantees at least one. */
  readonly milestones: readonly [GoalMilestone, ...GoalMilestone[]]
  /** Executable acceptance criteria, in goal-file order. */
  readonly criteria: readonly GoalCriterion[]
}

/** Extract the body lines of one `## <name>` section, up to the next `## `. */
function section(lines: readonly string[], name: string): readonly string[] {
  const start = lines.findIndex(line => line.trim() === `## ${name}`)
  if (start === -1) throw new Error(`the goal file must contain a "## ${name}" section`)
  const body = lines.slice(start + 1)
  const end = body.findIndex(line => line.startsWith('## '))
  return end === -1 ? body : body.slice(0, end)
}

/**
 * Parse the goal contract. Milestones are list items `- M<n>: title` under
 * `## Milestones`; acceptance criteria are items `- M<n>: \`command\`
 * expectation` under `## Acceptance criteria`. Fails loud on a goal the
 * verifier cannot execute, because an unparsable goal stalls the run.
 */
export function parseGoal(markdown: string): ParsedGoal {
  const lines = markdown.split('\n')
  const milestones = section(lines, 'Milestones').flatMap(line => {
    const match = /^- M(\d+): (.+)$/.exec(line.trim())
    return match ? [{ id: Number(match[1]), title: match[2] as string }] : []
  })
  if (milestones.length === 0) {
    throw new Error('the goal file must define at least one milestone ("## Milestones" item "- M1: title")')
  }
  const criteria = section(lines, 'Acceptance criteria').flatMap(line => {
    const match = /^- M(\d+): `([^`]+)` ?(.*)$/.exec(line.trim())
    return match ? [{ milestone: Number(match[1]), command: match[2] as string, description: match[3] as string }] : []
  })
  if (criteria.length === 0) {
    throw new Error('the goal file must define executable acceptance criteria ("## Acceptance criteria" item "- M1: `command` expectation")')
  }
  const milestoneIds = new Set(milestones.map(milestone => milestone.id))
  const unknown = criteria.find(criterion => !milestoneIds.has(criterion.milestone))
  if (unknown !== undefined) {
    throw new Error(`acceptance criterion references unknown milestone M${unknown.milestone}`)
  }
  return { milestones: milestones as [GoalMilestone, ...GoalMilestone[]], criteria }
}
