import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { GOAL_FILE_NAME, SPAWN_RECORD_NAME } from '@deepseek-ai/dsh-experimental-factory'
import { publishApp } from '../src/catalog.ts'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as catalog from '../src/index.ts'

const run = promisify(execFile)

const GOAL = '## Milestones\n\n- M1: Engine\n\n- M2: Interface\n\n## Acceptance criteria\n\n- M1: `echo core > core.ts` builds\n\n- M2: `echo ui > ui.ts` builds\n'

async function git(cwd: string, args: string[]): Promise<string> {
  return run('git', args, { cwd }).then(({ stdout }) => stdout.trim())
}

interface SetupResult {
  section: ReturnType<typeof vi.fn>
  getSectionOrder: ReturnType<typeof vi.fn>
  register: ReturnType<typeof vi.fn>
}

function setup(config: catalog.Config = {}): SetupResult {
  const section = vi.fn()
  const getSectionOrder = vi.fn((key: string) => (key === 'TOOL_FACTORY_CATALOG' ? 2680 : 0))
  const register = vi.fn()
  const ctx = {
    systemPrompt: { section, getSectionOrder },
    tools: { register },
  } as unknown as Context
  catalog.apply(ctx, config)
  return { section, getSectionOrder, register }
}

type ToolName = 'factory_catalog' | 'factory_publish'

function tool(name: ToolName, config: catalog.Config = {}) {
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

/** Create a completed spawned-app fixture under the configured apps directory. */
async function completedApp(root: string, name: string, withWeb = false): Promise<string> {
  const app = join(root, 'apps', name)
  await mkdir(withWeb ? join(app, 'apps', 'web') : app, { recursive: true })
  await writeFile(join(app, SPAWN_RECORD_NAME), '{}\n')
  await writeFile(join(app, GOAL_FILE_NAME), GOAL)
  await git(app, ['init'])
  await git(app, ['config', 'user.name', 'Fixture'])
  await git(app, ['config', 'user.email', 'fixture@example.test'])
  await writeFile(join(app, 'ui.ts'), 'ui\n')
  await git(app, ['add', '-A'])
  await git(app, ['commit', '-m', 'Mutation: M2 Interface'])
  return app
}

let workspace: string

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-factory-catalog-tool-'))
})

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('resolveConfig', () => {
  it('defaults to the process working directory and the apps subdirectory', () => {
    expect(catalog.resolveConfig({})).toEqual({ repositoryPath: process.cwd(), appsDir: join(process.cwd(), 'apps') })
    expect(catalog.resolveConfig({ repositoryPath: `  ${workspace}  `, appsDir: ' gallery ' }))
      .toEqual({ repositoryPath: workspace, appsDir: join(workspace, 'gallery') })
  })

  it('refuses empty values', () => {
    expect(() => catalog.resolveConfig({ repositoryPath: '   ' })).toThrow('repositoryPath must not be empty')
    expect(() => catalog.resolveConfig({ appsDir: '   ' })).toThrow('appsDir must not be empty')
  })
})

describe('parsePublishArgs', () => {
  it('validates appPath and the optional target', () => {
    expect(catalog.parsePublishArgs({ appPath: '/tmp/app' })).toEqual({ appPath: '/tmp/app', target: 'catalog-only' })
    expect(catalog.parsePublishArgs({ appPath: '/tmp/app', target: 'cloudflare' })).toEqual({ appPath: '/tmp/app', target: 'cloudflare' })
    expect(() => catalog.parsePublishArgs(null)).toThrow('must be an object')
    expect(() => catalog.parsePublishArgs('nope')).toThrow('must be an object')
    expect(() => catalog.parsePublishArgs({})).toThrow('non-empty appPath string')
    expect(() => catalog.parsePublishArgs({ appPath: '  ' })).toThrow('non-empty appPath string')
    expect(() => catalog.parsePublishArgs({ appPath: '/tmp/app', target: 'vercel' })).toThrow('target must be one of')
  })
})

describe('apply', () => {
  it('registers the catalog policy and both tools in a factory checkout', () => {
    const { section, getSectionOrder, register } = setup({ repositoryPath: workspace })
    expect(getSectionOrder).toHaveBeenCalledWith('TOOL_FACTORY_CATALOG')
    expect(section).toHaveBeenCalledTimes(1)
    expect(section).toHaveBeenCalledWith(expect.objectContaining({
      name: 'catalog:policy',
      order: 2680,
      text: expect.stringContaining('Never claim an app is publishable without the catalog reporting it complete'),
    }))
    expect(register).toHaveBeenCalledTimes(2)
    expect(tool('factory_catalog', { repositoryPath: workspace }).description).toContain('derived status')
    expect(tool('factory_publish', { repositoryPath: workspace }).description).toContain('ready-to-run manifest')
  })

  it('registers nothing inside a spawned clone', async () => {
    const clone = join(workspace, 'apply-clone')
    await mkdir(clone, { recursive: true })
    await writeFile(join(clone, SPAWN_RECORD_NAME), '{}\n')
    const { section, register } = setup({ repositoryPath: clone })
    expect(section).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()
  })
})

describe('factory_catalog execute', () => {
  it('reports completed and in-progress applications with publish decisions', async () => {
    const root = join(workspace, 'catalog-execute')
    const gallery = await completedApp(root, 'gallery')
    await publishApp({ appPath: gallery, target: 'catalog-only' })
    const app = join(root, 'apps', 'draft')
    await mkdir(app, { recursive: true })
    await writeFile(join(app, SPAWN_RECORD_NAME), '{}\n')
    await writeFile(join(app, GOAL_FILE_NAME), GOAL)
    await git(app, ['init'])
    await git(app, ['config', 'user.name', 'Fixture'])
    await git(app, ['config', 'user.email', 'fixture@example.test'])
    await git(app, ['add', '-A'])
    await git(app, ['commit', '-m', 'Spawn mutation baseline'])
    const broken = join(root, 'apps', 'broken')
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, SPAWN_RECORD_NAME), '{}\n')
    const catalogTool = tool('factory_catalog', { repositoryPath: root })
    const report = await catalogTool.execute({}, exec()) as { entries: Array<{ name: string; status: string; publish?: unknown }>; skipped: Array<{ name: string }> }
    expect(report.entries).toHaveLength(2)
    expect(report.entries.find(entry => entry.name === 'gallery')?.status).toBe('complete')
    expect(report.entries.find(entry => entry.name === 'gallery')?.publish).toMatchObject({ decision: 'catalog-only' })
    expect(report.entries.find(entry => entry.name === 'draft')?.status).toBe('in-progress')
    expect(report.skipped.map(item => item.name)).toEqual(['broken'])
    const rendered = catalogTool.output.render({}, report) as Array<{ type: string; text: string }>
    expect(rendered[0].text).toContain('gallery: complete')
    expect(rendered[0].text).toContain('publish catalog-only (catalog-only)')
    expect(rendered[0].text).toContain('broken: SKIPPED')
  })

  it('renders the empty state when the apps directory has no spawned apps', async () => {
    const root = join(workspace, 'catalog-empty')
    const catalogTool = tool('factory_catalog', { repositoryPath: root })
    const report = await catalogTool.execute({}, exec()) as { entries: unknown[]; skipped: unknown[] }
    expect(report.entries).toEqual([])
    const rendered = catalogTool.output.render({}, report) as Array<{ type: string; text: string }>
    expect(rendered[0].text).toContain('catalog is empty')
  })
})

describe('factory_publish execute', () => {
  it('records a catalog-only decision through the tool surface', async () => {
    const root = join(workspace, 'publish-execute')
    const app = await completedApp(root, 'shipped')
    const publish = tool('factory_publish', { repositoryPath: root })
    const report = await publish.execute({ appPath: app }, exec()) as Record<string, unknown>
    expect(report).toMatchObject({ app: 'shipped', decision: 'catalog-only', target: 'catalog-only', surface: 'headless' })
    const rendered = publish.output.render({}, report) as Array<{ type: string; text: string }>
    expect(rendered[0].text).toContain('Recorded catalog-only')
    expect(rendered[0].text).not.toContain('manifest at')
  })

  it('writes and reports the hosting manifest for a hosting decision', async () => {
    const root = join(workspace, 'publish-manifest-execute')
    const app = await completedApp(root, 'hosted', true)
    const publish = tool('factory_publish', { repositoryPath: root })
    const report = await publish.execute({ appPath: app, target: 'cloudflare' }, exec()) as Record<string, unknown>
    expect(report.decision).toBe('manifest-ready')
    const rendered = publish.output.render({}, report) as Array<{ type: string; text: string }>
    expect(rendered[0].text).toContain('cloud credentials must run it')
    expect(await readFile(join(app, 'PUBLISH_MANIFEST.md'), 'utf8')).toContain('wrangler pages deploy')
  })

  it('rejects malformed arguments before any filesystem work', async () => {
    const publish = tool('factory_publish', { repositoryPath: workspace })
    await expect(publish.execute(null, exec())).rejects.toThrow('must be an object')
    await expect(publish.execute({ appPath: '' }, exec())).rejects.toThrow('non-empty appPath')
    await expect(publish.execute({ appPath: '/tmp/x', target: 'vercel' }, exec())).rejects.toThrow('target must be one of')
  })
})
