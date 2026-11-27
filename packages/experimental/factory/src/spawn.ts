/**
 * Isolated self-replication: clone this checkout into a fresh directory, wire
 * its own home, port, and goal, and commit the mutation baseline. The mother
 * checkout is read-only input; every write lands inside the clone.
 * @module @deepseek-ai/dsh-experimental-factory/spawn
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, appendFile, constants, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** Name of the goal file the clone's mutation loop treats as its immutable objective. */
export const GOAL_FILE_NAME = 'MUTATION_GOAL.md'

/** Name of the spawn record tying a clone back to its source commit and isolation facts. */
export const SPAWN_RECORD_NAME = 'MUTATION_SPAWN.json'

/** Clone-local home directory for state, sessions, and credentials. */
export const MUTATION_HOME_NAME = '.mutation-home'

/** Baseline commit message of every spawned clone. */
export const BASELINE_COMMIT_MESSAGE = 'Spawn mutation baseline'

/** Facts a clone needs to boot isolated and to report where it came from. */
export interface SpawnRecord {
  /** Record format version. */
  readonly version: 1
  /** Mother checkout commit the clone was cut from. */
  readonly sourceCommit: string
  /** ISO timestamp of the spawn. */
  readonly createdAt: string
  /** SHA-256 of the goal file content at spawn time. */
  readonly goalSha256: string
  /** Clone-relative home directory path. */
  readonly homePath: string
  /** Reserved localhost port for the clone's web profile. */
  readonly port: number
}

/** Options for one clone spawn. */
export interface SpawnOptions {
  /** The mother checkout to replicate (must be a clean git work tree). */
  readonly repositoryPath: string
  /** Target directory for the clone (must not exist). */
  readonly targetPath: string
  /** Full mutation goal content written to {@link GOAL_FILE_NAME} at the clone root. */
  readonly goalMarkdown: string
  /** Optional files copied verbatim into the clone's `references/` directory. */
  readonly referencePaths?: readonly string[]
  /** Cancellation signal forwarded to every child process and file operation. */
  readonly signal?: AbortSignal
}

/** Extract a human-readable message from any thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Run one git command in a repository and return its trimmed standard output. */
export async function runGit(repositoryPath: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFileP('git', [...args], { cwd: repositoryPath, signal, maxBuffer: 16 * 1024 * 1024 })
    return stdout.trim()
  } catch (error) {
    throw new Error(`git ${args.join(' ')} failed in ${repositoryPath}: ${errorMessage(error)}`)
  }
}

/** Deterministic commit identity for autonomous commits inside a clone. */
const COMMIT_IDENTITY = ['-c', 'user.name=Artifork Factory', '-c', 'user.email=factory@artifork.local']

/** Commit every change in the clone with the factory identity; fails loud on a git error. */
export async function commitAll(clonePath: string, message: string, signal?: AbortSignal): Promise<string> {
  await runGit(clonePath, ['add', '-A'], signal)
  return runGit(clonePath, [...COMMIT_IDENTITY, 'commit', '-m', message], signal)
}

/**
 * Fail loud unless the checkout is a clean git work tree; return its HEAD commit.
 * A dirty mother could clone half-written state and break the rollback guarantee.
 */
export async function requireCleanCheckout(repositoryPath: string, signal?: AbortSignal): Promise<string> {
  const status = await runGit(repositoryPath, ['status', '--porcelain'], signal)
  if (status.length > 0) {
    throw new Error(`refusing to spawn: ${repositoryPath} is not a clean checkout (${status.split('\n').length} dirty entries)`)
  }
  return runGit(repositoryPath, ['rev-parse', 'HEAD'], signal)
}

/**
 * Reserve a free localhost port and release it for the clone's launcher.
 * The reservation window is inherent to port probing; the launcher owns the retry.
 */
export async function resolveFreePort(desiredPort = 0): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on('error', error => {
      server.close()
      reject(new Error(`reserving a free port failed: ${error.message}`))
    })
    server.listen(desiredPort, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => { resolve(port) })
    })
  })
}

/** Write the goal file and copy every declared reference into `references/`. */
export async function prepareGoal(
  clonePath: string,
  goalMarkdown: string,
  referencePaths: readonly string[],
): Promise<string> {
  const goal = goalMarkdown.trim()
  if (goal.length === 0) throw new Error('the mutation goal must be a non-empty document')
  const goalPath = join(clonePath, GOAL_FILE_NAME)
  await writeFile(goalPath, `${goal}\n`, 'utf8')
  if (referencePaths.length > 0) {
    const referencesDir = join(clonePath, 'references')
    await mkdir(referencesDir, { recursive: true })
    for (const reference of referencePaths) {
      try {
        await access(reference, constants.R_OK)
        await cp(reference, join(referencesDir, basename(reference)))
      } catch (error) {
        throw new Error(`reference file ${reference} is not readable: ${errorMessage(error)}`)
      }
    }
  }
  return goalPath
}

/** Idempotently exclude one clone-relative directory from the clone's git status. */
export async function excludePathFromGit(clonePath: string, relativePath: string, signal?: AbortSignal): Promise<void> {
  const infoDir = join(clonePath, '.git', 'info')
  const excludePath = join(infoDir, 'exclude')
  const exclude = await readFile(excludePath, { encoding: 'utf8', signal }).catch(() => '')
  const lines = exclude.split('\n')
  if (!lines.includes(relativePath) && !lines.includes(`${relativePath}/`)) {
    await mkdir(infoDir, { recursive: true })
    await appendFile(excludePath, `${relativePath}/\n`)
  }
}

/** Write the spawn record and exclude the clone's home directory from its git status. */
export async function writeSpawnRecord(clonePath: string, record: SpawnRecord, signal?: AbortSignal): Promise<void> {
  await writeFile(join(clonePath, SPAWN_RECORD_NAME), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  await excludePathFromGit(clonePath, MUTATION_HOME_NAME, signal)
}

/**
 * Spawn one isolated clone: clean-checkout proof, `git clone --no-hardlinks`,
 * remote cut, isolation facts, goal and references, and the baseline commit.
 * Every write lands inside the clone; the mother is only read.
 */
export async function spawnClone(options: SpawnOptions): Promise<SpawnRecord> {
  const { repositoryPath, targetPath, goalMarkdown, signal } = options
  const referencePaths = options.referencePaths ?? []
  const sourceCommit = await requireCleanCheckout(repositoryPath, signal)
  try {
    await access(targetPath, constants.F_OK)
    throw new Error(`refusing to spawn: target ${targetPath} already exists`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await runGit(repositoryPath, ['clone', '--no-hardlinks', repositoryPath, targetPath], signal)
  await runGit(targetPath, ['remote', 'remove', 'origin'], signal)
  const port = await resolveFreePort()
  const homePath = join(targetPath, MUTATION_HOME_NAME)
  await mkdir(homePath)
  const goalPath = await prepareGoal(targetPath, goalMarkdown, referencePaths)
  const goalSha256 = createHash('sha256').update(await readFile(goalPath, { encoding: 'utf8', signal })).digest('hex')
  const record: SpawnRecord = {
    version: 1,
    sourceCommit,
    createdAt: new Date().toISOString(),
    goalSha256,
    homePath: MUTATION_HOME_NAME,
    port,
  }
  await writeSpawnRecord(targetPath, record, signal)
  await commitAll(targetPath, BASELINE_COMMIT_MESSAGE, signal)
  return record
}
