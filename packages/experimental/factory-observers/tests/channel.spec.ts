import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  COACH_PRIORITY,
  COACHES_DIR_NAME,
  PAUSE_FLAG_NAME,
  PROPOSALS_DIR_NAME,
  clearPauseFlag,
  composeDirectives,
  loadGovernedSync,
  loadProposals,
  readPauseReason,
  saveProposal,
  setPauseFlag,
  validateProposal,
} from '../src/channel.ts'

let workspace: string

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-observers-channel-'))
})

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

function clonePath(name: string): string {
  return join(workspace, name)
}

const VALID = { coach: 'process', topic: 'gate-hygiene', evidence: 'gate 2 exited 7 twice', directive: 'Split the failing gate into two smaller gates.' }

describe('validateProposal', () => {
  it('accepts a well-formed proposal and trims its fields', () => {
    const validated = validateProposal({ ...VALID, topic: ' gate-hygiene ', evidence: '  reasons  ', directive: ' do it ' })
    expect(validated).toEqual({
      coach: 'process',
      topic: 'gate-hygiene',
      evidence: 'reasons',
      directive: 'do it',
    })
  })

  it('rejects an unknown coach', () => {
    expect(() => validateProposal({ ...VALID, coach: 'boss' })).toThrow('coach must be one of process, intent, skills')
  })

  it('rejects malformed topics', () => {
    expect(() => validateProposal({ ...VALID, topic: 'Bad Topic' })).toThrow('kebab slug')
    expect(() => validateProposal({ ...VALID, topic: 'a'.repeat(41) })).toThrow('kebab slug')
    expect(() => validateProposal({ ...VALID, topic: '   ' })).toThrow('kebab slug')
  })

  it('rejects empty evidence and empty directives', () => {
    expect(() => validateProposal({ ...VALID, evidence: '   ' })).toThrow('non-empty observable evidence')
    expect(() => validateProposal({ ...VALID, directive: '  ' })).toThrow('directive text must be non-empty')
  })
})

describe('saveProposal and loadProposals', () => {
  it('saves a proposal and reads it back with its sequence', async () => {
    const clone = clonePath('save-basic')
    const saved = await saveProposal(clone, VALID)
    expect(saved.seq).toBe(1)
    expect(await loadProposals(clone)).toEqual([{ ...VALID, seq: 1 }])
  })

  it('supersedes the previous proposal on the same topic with seq plus one', async () => {
    const clone = clonePath('save-supersede')
    await saveProposal(clone, VALID)
    const second = await saveProposal(clone, { ...VALID, directive: 'Try the other approach.' })
    expect(second.seq).toBe(2)
    const proposals = await loadProposals(clone)
    expect(proposals).toHaveLength(1)
    expect(proposals[0].directive).toBe('Try the other approach.')
    expect(proposals[0].seq).toBe(2)
  })

  it('keeps separate topics separate', async () => {
    const clone = clonePath('save-topics')
    await saveProposal(clone, VALID)
    await saveProposal(clone, { ...VALID, topic: 'ui-focus' })
    expect(await loadProposals(clone)).toHaveLength(2)
  })

  it('recovers from a malformed existing proposal file by restarting the sequence', async () => {
    const clone = clonePath('save-malformed')
    await mkdir(join(clone, PROPOSALS_DIR_NAME, 'process'), { recursive: true })
    await writeFile(join(clone, PROPOSALS_DIR_NAME, 'process', 'gate-hygiene.json'), 'not json at all')
    const saved = await saveProposal(clone, VALID)
    expect(saved.seq).toBe(1)
  })

  it('skips malformed or invalid stored proposals instead of failing the loop', async () => {
    const clone = clonePath('load-skip')
    await saveProposal(clone, VALID)
    await mkdir(join(clone, PROPOSALS_DIR_NAME, 'intent'), { recursive: true })
    await writeFile(join(clone, PROPOSALS_DIR_NAME, 'intent', 'bad.txt'), 'ignored extension')
    await writeFile(join(clone, PROPOSALS_DIR_NAME, 'intent', 'broken.json'), '{oops')
    await writeFile(join(clone, PROPOSALS_DIR_NAME, 'intent', 'wrong-shape.json'), JSON.stringify({ seq: 'x', evidence: 'a', directive: 'b' }))
    await writeFile(join(clone, PROPOSALS_DIR_NAME, 'intent', 'negative.json'), JSON.stringify({ seq: -1, evidence: 'a', directive: 'b' }))
    await mkdir(join(clone, PROPOSALS_DIR_NAME, 'stranger'), { recursive: true })
    await writeFile(join(clone, PROPOSALS_DIR_NAME, 'stranger', 'topic.json'), JSON.stringify({ seq: 1, evidence: 'a', directive: 'b' }))
    const proposals = await loadProposals(clone)
    expect(proposals).toEqual([{ ...VALID, seq: 1 }])
  })

  it('skips stored proposals whose evidence or topic fails validation', async () => {
    const clone = clonePath('load-invalid')
    await mkdir(join(clone, PROPOSALS_DIR_NAME, 'intent'), { recursive: true })
    await writeFile(join(clone, PROPOSALS_DIR_NAME, 'intent', 'wrong-evidence.json'), JSON.stringify({ seq: 1, evidence: 42, directive: 'b' }))
    await writeFile(join(clone, PROPOSALS_DIR_NAME, 'intent', 'Bad Topic.json'), JSON.stringify({ seq: 1, evidence: 'a', directive: 'b' }))
    expect(await loadProposals(clone)).toEqual([])
  })

  it('skips a proposal file that cannot be read instead of failing the loop', async () => {
    const clone = clonePath('load-sealed')
    const file = join(clone, PROPOSALS_DIR_NAME, 'process', 'sealed.json')
    await mkdir(join(clone, PROPOSALS_DIR_NAME, 'process'), { recursive: true })
    await writeFile(file, JSON.stringify({ seq: 1, evidence: 'a', directive: 'b' }))
    await chmod(file, 0o000)
    try {
      expect(await loadProposals(clone)).toEqual([])
    } finally {
      await chmod(file, 0o644)
    }
  })

  it('rethrows read errors that are not a missing channel', async () => {
    const clone = clonePath('load-notdir')
    await mkdir(join(clone, COACHES_DIR_NAME), { recursive: true })
    await writeFile(join(clone, PROPOSALS_DIR_NAME), 'a plain file where the channel should be')
    await expect(loadProposals(clone)).rejects.toThrow()
  })

  it('returns an empty list when the channel does not exist yet', async () => {
    expect(await loadProposals(clonePath('load-empty'))).toEqual([])
  })
})

describe('composeDirectives', () => {
  const base = { seq: 1, evidence: 'e', directive: 'd' }

  it('orders by coach priority and then by topic', () => {
    const composed = composeDirectives([
      { ...base, coach: 'skills', topic: 'z-topic' },
      { ...base, coach: 'intent', topic: 'b-topic' },
      { ...base, coach: 'intent', topic: 'a-topic' },
      { ...base, coach: 'process', topic: 'm-topic' },
    ])
    expect(composed.included).toBe(4)
    expect(composed.dropped).toBe(0)
    expect(composed.text.split('\n').map(line => /\[([a-z]+\/[a-z-]+)\]/.exec(line)?.[1])).toEqual([
      'process/m-topic',
      'intent/a-topic',
      'intent/b-topic',
      'skills/z-topic',
    ])
  })

  it('drops directives beyond the budget instead of truncating mid-line', () => {
    const long = { ...base, coach: 'intent', topic: 'long', directive: 'x'.repeat(300) }
    const short = { ...base, coach: 'intent', topic: 'short', directive: 'y' }
    const composed = composeDirectives([long, short], 200)
    expect(composed.included).toBe(1)
    expect(composed.dropped).toBe(1)
    expect(composed.text).toContain('- [intent/short]')
  })

  it('keeps duplicate topics in a stable order', () => {
    const composed = composeDirectives([
      { ...base, coach: 'intent', topic: 'same', directive: 'first' },
      { ...base, coach: 'intent', topic: 'same', directive: 'second' },
    ])
    expect(composed.included).toBe(2)
    expect(composed.dropped).toBe(0)
  })

  it('composes an empty section without proposals', () => {
    expect(composeDirectives([])).toEqual({ text: '', included: 0, dropped: 0 })
  })
})

describe('loadGovernedSync', () => {
  it('reads the channel synchronously for prompt assembly', async () => {
    const clone = clonePath('governed-sync')
    await saveProposal(clone, VALID)
    const governed = loadGovernedSync(clone, 2048)
    expect(governed.included).toBe(1)
    expect(governed.text).toContain('[process/gate-hygiene]')
  })

  it('returns an empty section when the channel is absent', () => {
    expect(loadGovernedSync(clonePath('governed-absent'))).toEqual({ text: '', included: 0, dropped: 0 })
  })

  it('skips unreadable or malformed entries without failing', async () => {
    const clone = clonePath('governed-skip')
    await saveProposal(clone, VALID)
    await writeFile(join(clone, PROPOSALS_DIR_NAME, 'a plain file'), 'ignored')
    await mkdir(join(clone, PROPOSALS_DIR_NAME, 'intent'), { recursive: true })
    await mkdir(join(clone, PROPOSALS_DIR_NAME, 'intent', 'nested'), { recursive: true })
    await writeFile(join(clone, PROPOSALS_DIR_NAME, 'intent', 'broken.json'), '{oops')
    await writeFile(join(clone, PROPOSALS_DIR_NAME, 'intent', 'wrong-shape.json'), JSON.stringify({ seq: 'x', evidence: 'a', directive: 'b' }))
    await writeFile(join(clone, PROPOSALS_DIR_NAME, 'intent', 'wrong-evidence.json'), JSON.stringify({ seq: 1, evidence: 42, directive: 'b' }))
    const sealed = join(clone, PROPOSALS_DIR_NAME, 'skills')
    await mkdir(sealed, { recursive: true })
    await writeFile(join(sealed, 'topic.json'), JSON.stringify({ seq: 1, evidence: 'a', directive: 'b' }))
    await chmod(sealed, 0o000)
    try {
      const governed = loadGovernedSync(clone, 2048)
      expect(governed.included).toBe(1)
    } finally {
      await chmod(sealed, 0o755)
    }
  })
})

describe('pause flag', () => {
  it('writes, reads, and clears the pause reason', async () => {
    const clone = clonePath('pause-cycle')
    expect(await readPauseReason(clone)).toBeNull()
    const reason = await setPauseFlag(clone, '  three rollbacks on M2  ')
    expect(reason).toBe('three rollbacks on M2')
    expect(await readPauseReason(clone)).toBe('three rollbacks on M2')
    await clearPauseFlag(clone)
    expect(await readPauseReason(clone)).toBeNull()
    await expect(clearPauseFlag(clone)).resolves.toBeUndefined()
  })

  it('refuses a pause without a reason', async () => {
    await expect(setPauseFlag(clonePath('pause-empty'), '   ')).rejects.toThrow('must state its reason')
  })

  it('rethrows read errors that are not a missing flag', async () => {
    const clone = clonePath('pause-notdir')
    await mkdir(join(clone, COACHES_DIR_NAME, 'PAUSE'), { recursive: true })
    await expect(readPauseReason(clone)).rejects.toThrow()
  })

  it('rethrows write errors from saveProposal on an unreadable topic file', async () => {
    const clone = clonePath('save-notdir')
    await mkdir(join(clone, PROPOSALS_DIR_NAME, 'process', 'gate-hygiene.json'), { recursive: true })
    await expect(saveProposal(clone, VALID)).rejects.toThrow()
  })

  it('writes the flag where the rounds driver looks for it', async () => {
    const clone = clonePath('pause-location')
    await setPauseFlag(clone, 'reason')
    const raw = await readFile(join(clone, PAUSE_FLAG_NAME), 'utf8')
    expect(raw).toBe('reason\n')
  })
})

describe('COACH_PRIORITY', () => {
  it('fixes the governed priority order', () => {
    expect(COACH_PRIORITY).toEqual(['process', 'intent', 'skills'])
  })
})
