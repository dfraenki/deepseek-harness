import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { MUTATION_HOME_NAME, resolveFreePort, writeSpawnRecord, type SpawnRecord } from '@deepseek-ai/dsh-experimental-factory'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as preview from '../src/index.ts'

interface SetupResult {
  section: ReturnType<typeof vi.fn>
  getSectionOrder: ReturnType<typeof vi.fn>
  register: ReturnType<typeof vi.fn>
}

function setup(config: preview.Config = {}): SetupResult {
  const section = vi.fn()
  const getSectionOrder = vi.fn((key: string) => (key === 'TOOL_FACTORY_PREVIEW' ? 2675 : 0))
  const register = vi.fn()
  const ctx = {
    systemPrompt: { section, getSectionOrder },
    tools: { register },
  } as unknown as Context
  preview.apply(ctx, config)
  return { section, getSectionOrder, register }
}

type ToolName = 'preview_start' | 'preview_status' | 'preview_stop' | 'preview_probe'

function tool(name: ToolName, config: preview.Config = {}) {
  const { register } = setup(config)
  const found = register.mock.calls
    .map(call => call[0] as { name: string })
    .find(registered => registered.name === name)
  if (found === undefined) throw new Error(`tool ${name} was not registered`)
  return found as {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: { schema: unknown; render: (args: unknown, value: unknown) => unknown }
    execute: (args: unknown, exec: { signal: AbortSignal }) => Promise<Record<string, unknown>>
  }
}

function exec(): { signal: AbortSignal } {
  return { signal: new AbortController().signal } as never
}

let workspace: string
let appFixture: string
let serverPort: number

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-preview-tool-'))
  const fixtureDir = join(workspace, 'fixture')
  await mkdir(fixtureDir, { recursive: true })
  appFixture = join(fixtureDir, 'app-server.mjs')
  await writeFileFixture(appFixture)
  serverPort = await resolveFreePort()
})

async function writeFileFixture(path: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, [
    "import { createServer } from 'node:http'",
    'const port = Number(process.argv[process.argv.length - 1])',
    "createServer((req, res) => {",
    "  if (req.url === '/boom') { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('boom'); return }",
    "  if (req.url === '/bare') { res.writeHead(200); res.end(); return }",
    "  res.writeHead(200, { 'content-type': 'text/html' })",
    "  res.end('<html><body>app under mutation</body></html>')",
    '})',
    ".listen(port, '127.0.0.1', () => console.log(`listening on ${port}`))",
    '',
  ].join('\n'))
}

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

async function makeClone(name: string): Promise<string> {
  const clone = join(workspace, name)
  await mkdir(clone, { recursive: true })
  const record: SpawnRecord = {
    version: 1,
    sourceCommit: 'c'.repeat(40),
    createdAt: new Date().toISOString(),
    goalSha256: 'd'.repeat(64),
    homePath: MUTATION_HOME_NAME,
    port: serverPort,
  }
  await writeSpawnRecord(clone, record)
  return clone
}

function fixtureConfig(clone: string): preview.Config {
  return { repositoryPath: clone, command: process.execPath, args: [appFixture], startTimeoutMs: 10_000 }
}

describe('resolveConfig', () => {
  it('defaults to the process working directory', () => {
    expect(preview.resolveConfig({})).toEqual({ repositoryPath: process.cwd() })
  })

  it('trims the repository path and accepts command overrides', () => {
    expect(preview.resolveConfig({ repositoryPath: `  ${workspace}  `, command: ' node ', args: ['x'], startTimeoutMs: 5 }))
      .toEqual({ repositoryPath: workspace, command: 'node', args: ['x'], startTimeoutMs: 5 })
  })

  it('refuses an empty repository path, command, and bad start budgets', () => {
    expect(() => preview.resolveConfig({ repositoryPath: '   ' })).toThrow('must not be empty')
    expect(() => preview.resolveConfig({ command: '   ' })).toThrow('command must not be empty')
    expect(() => preview.resolveConfig({ startTimeoutMs: 0 })).toThrow('positive safe integer')
    expect(() => preview.resolveConfig({ startTimeoutMs: 1.5 })).toThrow('positive safe integer')
  })
})

describe('parsePreviewArgs', () => {
  it('requires an object and an optional string path', () => {
    expect(() => preview.parsePreviewArgs(null)).toThrow('must be an object')
    expect(() => preview.parsePreviewArgs('nope')).toThrow('must be an object')
    expect(() => preview.parsePreviewArgs([])).toThrow('must be an object')
    expect(() => preview.parsePreviewArgs({ path: 42 })).toThrow('must be a string')
    expect(preview.parsePreviewArgs({})).toEqual({})
    expect(preview.parsePreviewArgs({ path: '/status' })).toEqual({ path: '/status' })
  })
})

describe('apply', () => {
  it('registers the policy section and the four tools', () => {
    const { section, getSectionOrder, register } = setup({ repositoryPath: workspace })
    expect(getSectionOrder).toHaveBeenCalledWith('TOOL_FACTORY_PREVIEW')
    expect(section).toHaveBeenCalledWith(expect.objectContaining({
      name: 'preview:policy',
      order: 2675,
      text: expect.stringContaining('the same instance the user sees'),
    }))
    expect(section).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledTimes(4)
    expect(tool('preview_start').description).toContain('one preview instance')
    expect(tool('preview_status').description).toContain('log tail')
    expect(tool('preview_stop').description).toContain('milestone state is preserved')
    expect(tool('preview_probe').description).toContain('same instance the user watches')
  })
})

describe('preview_start and preview_status', () => {
  it('launches the shared instance and reuses it, rendering both outcomes', async () => {
    const clone = await makeClone('start')
    const start = tool('preview_start', fixtureConfig(clone))
    const first = await start.execute({}, exec()) as unknown as { running: boolean; launched: boolean; url: string; pid: number }
    expect(first).toMatchObject({ running: true, launched: true, url: `http://127.0.0.1:${serverPort}` })
    expect((start.output.render({}, first) as Array<{ text: string }>)[0].text).toContain('launched at')
    const second = await start.execute({}, exec()) as unknown as { launched: boolean }
    expect(second.launched).toBe(false)
    expect((start.output.render({}, second) as Array<{ text: string }>)[0].text).toContain('already serving')
    const status = tool('preview_status', fixtureConfig(clone))
    const report = await status.execute({}, exec()) as unknown as { running: boolean; pid: number }
    expect(report.running).toBe(true)
    expect(report.pid).toBe(first.pid)
    expect((status.output.render({}, report) as Array<{ text: string }>)[0].text).toContain('serving at')
    await tool('preview_stop', fixtureConfig(clone)).execute({}, exec())
  })

  it('renders a bare status when no spawn record exists', async () => {
    const bare = join(workspace, 'status-bare')
    await mkdir(bare, { recursive: true })
    const status = tool('preview_status', { repositoryPath: bare })
    const report = await status.execute({}, exec()) as unknown as { running: boolean; logTail: string }
    expect(report).toEqual({ running: false, logTail: '' })
    expect((status.output.render({}, report) as Array<{ text: string }>)[0].text)
      .toBe('Preview is not running. Log tail: (empty)')
  })

  it('renders an empty log tail and refuses to launch without dependencies', async () => {
    const clone = await makeClone('start-default')
    const status = tool('preview_status', { repositoryPath: clone })
    const idle = await status.execute({}, exec()) as unknown as { running: boolean; logTail: string }
    expect(idle.logTail).toBe('')
    expect((status.output.render({}, idle) as Array<{ text: string }>)[0].text).toContain('(empty)')
    await expect(tool('preview_start', { repositoryPath: clone }).execute({}, exec()))
      .rejects.toThrow("could not launch the clone's app")
  })
})

describe('preview_probe', () => {
  let clone: string
  beforeAll(async () => {
    clone = await makeClone('probe')
    await tool('preview_start', fixtureConfig(clone)).execute({}, exec())
  })
  afterAll(async () => {
    await tool('preview_stop', fixtureConfig(clone)).execute({}, exec())
  })

  it('probes the shared origin and renders the answer', async () => {
    const probe = tool('preview_probe', fixtureConfig(clone))
    const report = await probe.execute({}, exec()) as unknown as { status: number; url: string }
    expect(report.status).toBe(200)
    expect(report.url).toBe(`http://127.0.0.1:${serverPort}`)
    expect((probe.output.render({}, report) as Array<{ text: string }>)[0].text).toContain(`GET http://127.0.0.1:${serverPort} → 200`)
  })

  it('renders a bare answer without type or body', async () => {
    const probe = tool('preview_probe', fixtureConfig(clone))
    const report = await probe.execute({ path: '/bare' }, exec()) as unknown as { status: number }
    expect(report.status).toBe(200)
    expect((probe.output.render({}, report) as Array<{ text: string }>)[0].text)
      .toBe(`GET http://127.0.0.1:${serverPort} → 200`)
  })

  it('renders a red status and a silent origin', async () => {
    const probe = tool('preview_probe', fixtureConfig(clone))
    const red = await probe.execute({ path: '/boom' }, exec()) as unknown as { status: number }
    expect(red.status).toBe(500)
    expect((probe.output.render({}, red) as Array<{ text: string }>)[0].text).toContain('→ 500 (text/plain)')
    await tool('preview_stop', fixtureConfig(clone)).execute({}, exec())
    const silent = await probe.execute({ path: '/' }, exec()) as unknown as { status: number; url: string }
    expect(silent.status).toBe(0)
    expect((probe.output.render({}, silent) as Array<{ text: string }>)[0].text).toContain('No answer from')
  })

  it('rejects malformed arguments', async () => {
    const probe = tool('preview_probe', fixtureConfig(clone))
    await expect(probe.execute(null, exec())).rejects.toThrow('must be an object')
    await expect(probe.execute({ path: 42 }, exec())).rejects.toThrow('must be a string')
  })
})

describe('preview_stop', () => {
  it('is idempotent and renders the preserved state', async () => {
    const clone = await makeClone('stop')
    const stop = tool('preview_stop', fixtureConfig(clone))
    expect(await stop.execute({}, exec())).toEqual({ stopped: true })
    expect((stop.output.render({}, { stopped: true }) as Array<{ text: string }>)[0].text).toContain('milestone state is preserved')
  })
})
