import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BASELINE_COMMIT_MESSAGE,
  GOAL_FILE_NAME,
  MUTATION_HOME_NAME,
  REHEARSAL_HOME_NAME,
  SPAWN_RECORD_NAME,
  commitAll,
  copyRehearsalSkills,
  errorMessage,
  excludePathFromGit,
  prepareGoal,
  requireCleanCheckout,
  resolveFreePort,
  spawnClone,
  writeSpawnRecord,
} from '../src/spawn.ts'
import { createServer } from 'node:net'

const run = promisify(execFile)

const GOAL = '# Mutation goal\n\nBecome an intuitive electronic-music DAW.\n'

async function git(cwd: string, args: string[]): Promise<string> {
  return run('git', args, { cwd }).then(({ stdout }) => stdout.trim())
}

let workspace: string
let mother: string

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-factory-'))
  mother = join(workspace, 'mother')
  await mkdir(mother, { recursive: true })
  await git(mother, ['init'])
  await git(mother, ['config', 'user.name', 'Fixture'])
  await git(mother, ['config', 'user.email', 'fixture@example.test'])
  await writeFile(join(mother, 'README.md'), 'mother\n')
  await git(mother, ['add', '-A'])
  await git(mother, ['commit', '-m', 'fixture root'])
})

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('requireCleanCheckout', () => {
  it('returns the HEAD commit of a clean checkout', async () => {
    const head = await git(mother, ['rev-parse', 'HEAD'])
    await expect(requireCleanCheckout(mother)).resolves.toBe(head)
  })

  it('refuses a dirty checkout with the dirty entry count', async () => {
    await writeFile(join(mother, 'dirty.txt'), 'uncommitted\n')
    await expect(requireCleanCheckout(mother)).rejects.toThrow('not a clean checkout (1 dirty entries)')
    await rm(join(mother, 'dirty.txt'))
  })

  it('fails loud outside a repository', async () => {
    await expect(requireCleanCheckout(workspace)).rejects.toThrow(/git status --porcelain failed/)
  })
})

describe('resolveFreePort', () => {
  it('returns a positive port number', async () => {
    await expect(resolveFreePort()).resolves.toBeGreaterThan(0)
  })

  it('fails loud when the desired port is taken', async () => {
    const blocker = createServer()
    await new Promise<void>(resolve => {
      blocker.listen(0, '127.0.0.1', () => resolve())
    })
    const occupied = (blocker.address() as { port: number }).port
    await expect(resolveFreePort(occupied)).rejects.toThrow('reserving a free port failed')
    await new Promise<void>(resolve => {
      blocker.close(() => resolve())
    })
  })
})

describe('errorMessage', () => {
  it('keeps the message of an Error', () => {
    expect(errorMessage(new Error('git exploded'))).toBe('git exploded')
  })

  it('stringifies non-Error throwables', () => {
    expect(errorMessage('raw failure')).toBe('raw failure')
  })
})

describe('prepareGoal', () => {
  let clone: string

  beforeAll(async () => {
    clone = join(workspace, 'goal-clone')
    await mkdir(clone, { recursive: true })
  })

  it('writes the trimmed goal with a trailing newline and copies references', async () => {
    const reference = join(workspace, 'mockup.png')
    await writeFile(reference, 'png bytes')
    const goalPath = await prepareGoal(clone, `  ${GOAL}  `, [reference])
    expect(goalPath).toBe(join(clone, GOAL_FILE_NAME))
    await expect(readFile(goalPath, 'utf8')).resolves.toBe(`${GOAL.trim()}\n`)
    await expect(readFile(join(clone, 'references', 'mockup.png'), 'utf8')).resolves.toBe('png bytes')
  })

  it('refuses an empty goal document', async () => {
    await expect(prepareGoal(clone, '   \n\t', [])).rejects.toThrow('non-empty document')
  })

  it('refuses an unreadable reference file', async () => {
    await expect(prepareGoal(clone, GOAL, [join(workspace, 'missing.png')])).rejects.toThrow('not readable')
  })
})

describe('writeSpawnRecord', () => {
  it('writes the record and excludes the mutation home exactly once', async () => {
    const clone = join(workspace, 'record-clone')
    await mkdir(join(clone, '.git', 'info'), { recursive: true })
    const record = {
      version: 1 as const,
      sourceCommit: 'a'.repeat(40),
      createdAt: '2026-11-27T00:00:00.000Z',
      goalSha256: 'b'.repeat(64),
      homePath: MUTATION_HOME_NAME,
      port: 4123,
    }
    await writeSpawnRecord(clone, record)
    await writeSpawnRecord(clone, record)
    await expect(readFile(join(clone, SPAWN_RECORD_NAME), 'utf8')).resolves.toContain('"version": 1')
    const exclude = await readFile(join(clone, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n').filter(line => line === `${MUTATION_HOME_NAME}/`)).toHaveLength(1)
  })
})

describe('commitAll', () => {
  it('commits with the factory identity without local git config', async () => {
    const clone = join(workspace, 'commit-clone')
    await mkdir(clone, { recursive: true })
    await git(clone, ['init'])
    await writeFile(join(clone, 'goal.md'), 'goal\n')
    await commitAll(clone, 'factory commit')
    const subject = await git(clone, ['log', '-1', '--format=%s'])
    const author = await git(clone, ['log', '-1', '--format=%an'])
    expect(subject).toBe('factory commit')
    expect(author).toBe('Artifork Factory')
  })
})

describe('spawnClone', () => {
  it('clones, isolates, writes goal and record, and commits the baseline without touching the mother', async () => {
    const reference = join(workspace, 'brief.md')
    await writeFile(reference, 'reference brief')
    const motherHead = await git(mother, ['rev-parse', 'HEAD'])
    const target = join(workspace, 'clone-a')
    const { record, rehearsedSkills } = await spawnClone({
      repositoryPath: mother,
      targetPath: target,
      goalMarkdown: GOAL,
      referencePaths: [reference],
    })
    expect(record.version).toBe(1)
    expect(record.sourceCommit).toBe(motherHead)
    expect(record.goalSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(record.homePath).toBe(MUTATION_HOME_NAME)
    expect(record.port).toBeGreaterThan(0)
    expect(rehearsedSkills).toEqual([])
    await expect(readFile(join(target, GOAL_FILE_NAME), 'utf8')).resolves.toContain('electronic-music DAW')
    const stored = JSON.parse(await readFile(join(target, SPAWN_RECORD_NAME), 'utf8') as string)
    expect(stored.sourceCommit).toBe(motherHead)
    expect(stored.port).toBe(record.port)
    await expect(readFile(join(target, 'README.md'), 'utf8')).resolves.toBe('mother\n')
    await expect(readFile(join(target, 'references', 'brief.md'), 'utf8')).resolves.toBe('reference brief')
    expect(await git(target, ['remote'])).toBe('')
    expect(await git(target, ['log', '-1', '--format=%s'])).toBe(BASELINE_COMMIT_MESSAGE)
    await expect(git(target, ['status', '--porcelain'])).resolves.toBe('')
    expect(await git(mother, ['rev-parse', 'HEAD'])).toBe(motherHead)
    await expect(git(mother, ['status', '--porcelain'])).resolves.toBe('')
  })

  it('refuses an existing target directory', async () => {
    await expect(spawnClone({
      repositoryPath: mother,
      targetPath: join(workspace, 'clone-a'),
      goalMarkdown: GOAL,
    })).rejects.toThrow('already exists')
  })

  it('refuses a dirty mother before cloning', async () => {
    await writeFile(join(mother, 'dirty.txt'), 'uncommitted\n')
    const target = join(workspace, 'clone-b')
    await expect(spawnClone({
      repositoryPath: mother,
      targetPath: target,
      goalMarkdown: GOAL,
    })).rejects.toThrow('not a clean checkout')
    await rm(target, { recursive: true, force: true })
    await rm(join(mother, 'dirty.txt'))
  })

  it('carries distilled rehearsal skills into the clone and skips nameless files', async () => {
    await excludePathFromGit(mother, REHEARSAL_HOME_NAME)
    const skillsDir = join(mother, REHEARSAL_HOME_NAME, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'engine.md'), '---\nname: dsh-rehearsed-engine\ndescription: Build the engine.\n---\n\n# Engine\n')
    await writeFile(join(skillsDir, 'broken.md'), 'no frontmatter name here\n')
    const target = join(workspace, 'clone-skills')
    const { record: _record, rehearsedSkills } = await spawnClone({
      repositoryPath: mother,
      targetPath: target,
      goalMarkdown: GOAL,
    })
    expect(rehearsedSkills).toEqual(['dsh-rehearsed-engine'])
    await expect(readFile(join(target, '.agents', 'skills', 'dsh-rehearsed-engine', 'SKILL.md'), 'utf8'))
      .resolves.toContain('name: dsh-rehearsed-engine')
  })
})

describe('copyRehearsalSkills', () => {
  it('copies nothing when the rehearsal home does not exist', async () => {
    const empty = join(workspace, 'no-rehearsal')
    await mkdir(empty, { recursive: true })
    await expect(copyRehearsalSkills(empty, empty)).resolves.toEqual([])
  })

  it('skips unreadable skill files and fails loud on an unreadable skills directory', async () => {
    const repo = join(workspace, 'rehearsal-eacces')
    const skillsDir = join(repo, REHEARSAL_HOME_NAME, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'locked.md'), '---\nname: dsh-locked\ndescription: d\n---\n')
    await chmod(join(skillsDir, 'locked.md'), 0o000)
    const target = join(workspace, 'clone-locked')
    await mkdir(target, { recursive: true })
    await expect(copyRehearsalSkills(repo, target)).resolves.toEqual([])
    await chmod(join(skillsDir, 'locked.md'), 0o644)
    await chmod(skillsDir, 0o000)
    try {
      await expect(copyRehearsalSkills(repo, target)).rejects.toThrow()
    } finally {
      await chmod(skillsDir, 0o755)
    }
  })
})
