import { describe, expect, it } from 'vitest'
import { parseGoal } from '../src/goal.ts'

const GOAL = [
  '# Mutation goal',
  '',
  '## Identity',
  '',
  'Name: Test App.',
  '',
  '## Milestones',
  '',
  'Ship the core first, then the surface.',
  '',
  '- M1: Core engine plugin',
  '- M2: Sequencer surface',
  '',
  '## Acceptance criteria',
  '',
  '- M1: `pnpm run build:lib` exits 0',
  '- M1: `node scripts/boot-smoke.mjs` boots console-free',
  '- M2: `pnpm exec vitest run sequencer` passes',
  '',
  '## References',
  '',
  '- mockup.png contributes the layout.',
  '',
].join('\n')

describe('parseGoal', () => {
  it('parses ordered milestones and executable criteria', () => {
    const goal = parseGoal(GOAL)
    expect(goal.milestones).toEqual([
      { id: 1, title: 'Core engine plugin' },
      { id: 2, title: 'Sequencer surface' },
    ])
    expect(goal.criteria).toHaveLength(3)
    expect(goal.criteria[2]).toEqual({
      milestone: 2,
      command: 'pnpm exec vitest run sequencer',
      description: 'passes',
    })
  })

  it('ignores prose and non-item lines', () => {
    const goal = parseGoal(GOAL)
    expect(goal.milestones).toHaveLength(2)
  })

  it('requires the Milestones section', () => {
    expect(() => parseGoal('# Mutation goal\n\nNo sections here.\n')).toThrow('"## Milestones" section')
  })

  it('requires the Acceptance criteria section', () => {
    expect(() => parseGoal('## Milestones\n\n- M1: Engine\n')).toThrow('"## Acceptance criteria" section')
  })

  it('refuses a goal without milestone items', () => {
    expect(() => parseGoal('## Milestones\n\njust prose\n\n## Acceptance criteria\n\n- M1: `true` ok\n')).toThrow('at least one milestone')
  })

  it('refuses a goal without executable criteria', () => {
    expect(() => parseGoal('## Milestones\n\n- M1: Engine\n\n## Acceptance criteria\n\n"works well" is not a criterion\n')).toThrow('executable acceptance criteria')
  })

  it('refuses criteria bound to an unknown milestone', () => {
    expect(() => parseGoal('## Milestones\n\n- M1: Engine\n\n## Acceptance criteria\n\n- M9: `true` ok\n')).toThrow('unknown milestone M9')
  })

  it('stops a section at the next heading', () => {
    const goal = parseGoal(GOAL)
    expect(goal.criteria.some(criterion => criterion.milestone === 3)).toBe(false)
  })

  it('accepts a criterion without a trailing expectation', () => {
    const goal = parseGoal('## Milestones\n\n- M1: Engine\n\n## Acceptance criteria\n\n- M1: `true`\n')
    expect(goal.criteria[0]).toEqual({ milestone: 1, command: 'true', description: '' })
  })
})
