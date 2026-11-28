import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MUTATION_HOME_NAME, resolveFreePort, writeSpawnRecord, type SpawnRecord } from '@deepseek-ai/dsh-experimental-factory'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  LOG_TAIL_CHARS,
  PREVIEW_LOG_NAME,
  PREVIEW_STATE_NAME,
  clearPreview,
  isPidAlive,
  previewStatus,
  probeOrigin,
  probePreview,
  requireSpawnRecord,
  startPreview,
  stopPreview,
} from '../src/preview.ts'

let workspace: string
let appFixture: string
let stubbornFixture: string
let quietFixture: string

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-preview-'))
  const fixtureDir = join(workspace, 'fixture')
  await mkdir(fixtureDir, { recursive: true })
  appFixture = join(fixtureDir, 'app-server.mjs')
  stubbornFixture = join(fixtureDir, 'stubborn-server.mjs')
  quietFixture = join(fixtureDir, 'quiet.mjs')
  await writeFile(quietFixture, 'setInterval(() => {}, 1000)\n')
  await writeFile(appFixture, [
    "import { createServer } from 'node:http'",
    'const port = Number(process.argv[process.argv.length - 1])',
    'const server = createServer((req, res) => {',
    "  if (req.url === '/boom') { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('boom'); return }",
    "  if (req.url === '/bare') { res.writeHead(200); res.end('bare body'); return }",
    "  if (req.url === '/empty') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(); return }",
    "  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })",
    "  res.end('<html><body>app under mutation</body></html>')",
    '})',
    "server.listen(port, '127.0.0.1', () => {",
    '  console.log(`app fixture listening on ${port}`)',
    '  console.error(`app fixture stderr marker ${port}`)',
    '})',
    '',
  ].join('\n'))
  await writeFile(stubbornFixture, [
    "process.on('SIGTERM', () => {})",
    "import { createServer } from 'node:http'",
    'const port = Number(process.argv[process.argv.length - 1])',
    "createServer((req, res) => { res.writeHead(200); res.end('stubborn') }).listen(port, '127.0.0.1')",
    '',
  ].join('\n'))
})

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

function spawnRecord(serverPort: number): SpawnRecord {
  return {
    version: 1,
    sourceCommit: 'a'.repeat(40),
    createdAt: new Date().toISOString(),
    goalSha256: 'b'.repeat(64),
    homePath: MUTATION_HOME_NAME,
    port: serverPort,
  }
}

async function makeClone(name: string): Promise<{ clone: string; serverPort: number }> {
  const clone = join(workspace, name)
  await mkdir(clone, { recursive: true })
  const serverPort = await resolveFreePort()
  await writeSpawnRecord(clone, spawnRecord(serverPort))
  return { clone, serverPort }
}

function appOptions(): { command: string; args: string[] } {
  return { command: process.execPath, args: [appFixture] }
}

describe('requireSpawnRecord', () => {
  it('refuses to operate outside a spawned mutation clone', async () => {
    const bare = join(workspace, 'bare')
    await mkdir(bare, { recursive: true })
    await expect(requireSpawnRecord(bare)).rejects.toThrow('no MUTATION_SPAWN.json in this directory')
    await expect(probePreview(bare)).rejects.toThrow('preview tools operate inside a spawned mutation clone')
  })
})

describe('isPidAlive', () => {
  it('answers for a live process and not for a reaped one', () => {
    expect(isPidAlive(process.pid)).toBe(true)
    const dead = spawnSync('true')
    expect(dead.pid === undefined || isPidAlive(dead.pid)).toBe(false)
  })
})

describe('probeOrigin', () => {
  it('reports no answer when nothing serves the port', async () => {
    const { clone, serverPort } = await makeClone('probe-origin-idle')
    expect(await previewStatus(clone)).toMatchObject({ running: false })
    await expect(probeOrigin(serverPort)).rejects.toThrow()
  })
})

describe('startPreview', () => {
  it('launches the app fixture, reports the shared origin, and reuses the live process', async () => {
    const { clone } = await makeClone('start-basic')
    const first = await startPreview(clone, appOptions())
    expect(first.running).toBe(true)
    expect(first.launched).toBe(true)
    expect(first.logTail).toContain('launching')
    expect(first.logTail).toContain(`listening on ${first.port}`)
    expect(first.url).toBe(`http://127.0.0.1:${first.port}`)
    const second = await startPreview(clone, appOptions())
    expect(second.launched).toBe(false)
    expect(second.pid).toBe(first.pid)
    await stopPreview(clone)
  })

  it('relaunches when the recorded state is not running', async () => {
    const { clone } = await makeClone('start-stale')
    await mkdir(join(clone, MUTATION_HOME_NAME, 'preview'), { recursive: true })
    await writeFile(join(clone, PREVIEW_STATE_NAME), JSON.stringify({ running: false, startedAt: 'x', command: 'x' }))
    const report = await startPreview(clone, appOptions())
    expect(report.launched).toBe(true)
    await stopPreview(clone)
  })

  it('refuses to start without a spawn record', async () => {
    const bare = join(workspace, 'start-bare')
    await mkdir(bare, { recursive: true })
    await expect(startPreview(bare, appOptions())).rejects.toThrow('no MUTATION_SPAWN.json')
  })

  it('diagnoses a missing launcher as missing dependencies', async () => {
    const { clone } = await makeClone('start-missing')
    const options = { command: join(clone, 'node_modules', '.bin', 'dsh') }
    await expect(startPreview(clone, options)).rejects.toThrow("could not launch the clone's app")
    await expect(startPreview(clone, options)).rejects.toThrow("install the clone's dependencies first")
  })

  it('fails fast when the app exits during startup', async () => {
    const { clone } = await makeClone('start-crash')
    const crasher = join(workspace, 'fixture', 'crasher.mjs')
    await writeFile(crasher, 'process.exit(7)\n')
    await expect(startPreview(clone, { command: process.execPath, args: [crasher] }))
      .rejects.toThrow('exited with code 7 during startup')
  })

  it('times out when the app never answers', async () => {
    const { clone } = await makeClone('start-quiet')
    await expect(startPreview(clone, { command: process.execPath, args: [quietFixture], startTimeoutMs: 1_300 }))
      .rejects.toThrow('did not answer on port')
    await expect(startPreview(clone, { command: process.execPath, args: [quietFixture], startTimeoutMs: 1_300 }))
      .rejects.toThrow('within 1300ms')
  })

  it('honors an already aborted signal without launching anything', async () => {
    const { clone } = await makeClone('start-abort')
    const controller = new AbortController()
    controller.abort()
    await expect(startPreview(clone, { ...appOptions(), signal: controller.signal }))
      .rejects.toThrow('preview start aborted')
    expect(await previewStatus(clone)).toMatchObject({ running: false })
  })

  it('abandons the launch when the signal aborts during the startup wait', async () => {
    const { clone } = await makeClone('start-abort-mid')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 600)
    await expect(startPreview(clone, { command: process.execPath, args: [quietFixture], startTimeoutMs: 2_000, signal: controller.signal }))
      .rejects.toThrow('preview start aborted')
    expect(await previewStatus(clone)).toMatchObject({ running: false })
  })
})

describe('probePreview', () => {
  let clone: string
  let serverPort: number

  beforeAll(async () => {
    ;({ clone, serverPort } = await makeClone('probe'))
    await startPreview(clone, appOptions())
  })

  afterAll(async () => {
    await stopPreview(clone)
  })

  it('reports status, content type, and body excerpt', async () => {
    const report = await probePreview(clone)
    expect(report.url).toBe(`http://127.0.0.1:${serverPort}`)
    expect(report.status).toBe(200)
    expect(report.contentType).toContain('text/html')
    expect(report.bodyExcerpt).toContain('app under mutation')
  })

  it('reports a red status with its body', async () => {
    expect((await probePreview(clone, '/boom')).status).toBe(500)
  })

  it('omits a missing content type and an empty body', async () => {
    const bare = await probePreview(clone, '/bare')
    expect(bare.status).toBe(200)
    expect(bare.contentType).toBeUndefined()
    expect(bare.bodyExcerpt).toBe('bare body')
    const empty = await probePreview(clone, '/empty')
    expect(empty.bodyExcerpt).toBeUndefined()
  })

  it('reports status zero when the origin does not answer', async () => {
    await stopPreview(clone)
    const report = await probePreview(clone)
    expect(report).toEqual({ url: `http://127.0.0.1:${serverPort}`, status: 0 })
  })
})

describe('previewStatus', () => {
  it('reports a stopped preview without a record or log', async () => {
    const bare = join(workspace, 'status-bare')
    await mkdir(bare, { recursive: true })
    expect(await previewStatus(bare)).toEqual({ running: false, logTail: '' })
  })

  it('reports the port and url when a spawn record exists', async () => {
    const { clone, serverPort } = await makeClone('status-idle')
    expect(await previewStatus(clone)).toEqual({
      running: false,
      port: serverPort,
      url: `http://127.0.0.1:${serverPort}`,
      logTail: '',
    })
  })

  it('caps the log tail', async () => {
    const { clone } = await makeClone('status-log')
    await mkdir(join(clone, MUTATION_HOME_NAME, 'preview'), { recursive: true })
    await writeFile(join(clone, PREVIEW_LOG_NAME), 'x'.repeat(LOG_TAIL_CHARS + 500))
    const report = await previewStatus(clone)
    expect(report.logTail.length).toBe(LOG_TAIL_CHARS)
  })

  it('fails loud on a malformed state file', async () => {
    const { clone } = await makeClone('status-garbage')
    await mkdir(join(clone, MUTATION_HOME_NAME, 'preview'), { recursive: true })
    await writeFile(join(clone, PREVIEW_STATE_NAME), 'not json')
    await expect(previewStatus(clone)).rejects.toThrow()
  })

  it('fails loud when the preview log cannot be read', async () => {
    const { clone } = await makeClone('status-log-dir')
    await mkdir(join(clone, PREVIEW_LOG_NAME), { recursive: true })
    await expect(previewStatus(clone)).rejects.toThrow()
  })

  it('cleans up a running state whose recorded process is gone', async () => {
    const { clone } = await makeClone('status-dead')
    const deadPid = spawnSync('true').pid as number
    await mkdir(join(clone, MUTATION_HOME_NAME, 'preview'), { recursive: true })
    await writeFile(join(clone, PREVIEW_STATE_NAME), JSON.stringify({ running: true, pid: deadPid, port: 1, startedAt: 'x', command: 'x' }))
    expect(await previewStatus(clone)).toMatchObject({ running: false })
    expect(JSON.parse(await readFile(join(clone, PREVIEW_STATE_NAME), 'utf8'))).toMatchObject({ running: false })
  })
})

describe('stopPreview', () => {
  it('stops a serving preview and is idempotent', async () => {
    const { clone } = await makeClone('stop-basic')
    await startPreview(clone, appOptions())
    await stopPreview(clone)
    await stopPreview(clone)
    expect(await previewStatus(clone)).toMatchObject({ running: false })
  })

  it('kills a process that ignores SIGTERM after the grace period', async () => {
    const { clone } = await makeClone('stop-stubborn')
    const stubborn = await startPreview(clone, { command: process.execPath, args: [stubbornFixture] })
    expect(stubborn.pid).toBeDefined()
    await stopPreview(clone)
    expect(await previewStatus(clone)).toMatchObject({ running: false })
  })

  it('cleans up state when the recorded process is already gone', async () => {
    const { clone } = await makeClone('stop-gone')
    await mkdir(join(clone, MUTATION_HOME_NAME, 'preview'), { recursive: true })
    const deadPid = spawnSync('true').pid as number
    await writeFile(join(clone, PREVIEW_STATE_NAME), JSON.stringify({ running: true, pid: deadPid, port: 1, startedAt: 'x', command: 'x' }))
    await stopPreview(clone)
    expect(await previewStatus(clone)).toMatchObject({ running: false })
  })
})

describe('clearPreview', () => {
  it('removes the preview state directory', async () => {
    const { clone } = await makeClone('clear')
    await startPreview(clone, appOptions())
    await stopPreview(clone)
    await clearPreview(clone)
    expect(await previewStatus(clone)).toMatchObject({ running: false, logTail: '' })
  })
})
