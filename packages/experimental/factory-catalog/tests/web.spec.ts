import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { GOAL_FILE_NAME, SPAWN_RECORD_NAME } from '@deepseek-ai/dsh-experimental-factory'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { publishApp } from '../src/catalog.ts'
import { CATALOG_JSON_PATH, CATALOG_PAGE_PATH, catalogView, escapeHtml, previewHref, registerCatalogWeb, renderCatalogPage } from '../src/web.ts'
import * as catalog from '../src/index.ts'

const run = promisify(execFile)

const GOAL = '## Milestones\n\n- M1: Engine\n\n- M2: Interface\n\n## Acceptance criteria\n\n- M1: `echo core > core.ts` builds\n\n- M2: `echo ui > ui.ts` builds\n'

let workspace: string

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-factory-catalog-web-'))
})

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

async function git(cwd: string, args: string[]): Promise<string> {
  return run('git', args, { cwd }).then(({ stdout }) => stdout.trim())
}

/** Create a spawned-app fixture with the goal committed as the spawn baseline. */
async function appFixture(root: string, name: string, spawnRecord = '{}\n'): Promise<string> {
  const app = join(root, name)
  await mkdir(app, { recursive: true })
  await writeFile(join(app, SPAWN_RECORD_NAME), spawnRecord)
  await writeFile(join(app, GOAL_FILE_NAME), GOAL)
  await git(app, ['init'])
  await git(app, ['config', 'user.name', 'Fixture'])
  await git(app, ['config', 'user.email', 'fixture@example.test'])
  await git(app, ['add', '-A'])
  await git(app, ['commit', '-m', 'Spawn mutation baseline'])
  return app
}

/** Drive the fixture to a completed run: green commit for the last milestone, clean tree. */
async function completeApp(app: string): Promise<void> {
  await writeFile(join(app, 'ui.ts'), 'ui\n')
  await git(app, ['add', '-A'])
  await git(app, ['commit', '-m', 'Mutation: M2 Interface'])
}

interface RegisteredRoute {
  kind: 'exact'
  path: string
  resource: (request: Request) => Promise<Response>
}

interface FakeWeb {
  origin: string
  routes: Map<string, RegisteredRoute>
  disposed: number
}

function fakeWebServer(origin = 'http://localhost:8080'): { web: FakeWeb; service: unknown } {
  const web: FakeWeb = { origin, routes: new Map(), disposed: 0 }
  const service = {
    getOrigin: () => web.origin,
    register: (route: RegisteredRoute) => {
      web.routes.set(route.path, route)
      return () => {
        web.disposed += 1
        web.routes.delete(route.path)
      }
    },
  }
  return { web, service }
}

function fakeCtx(service: unknown): Context {
  return { webServer: service, connection: { requestRejection: () => undefined } } as unknown as Context
}

describe('previewHref', () => {
  it('swaps the port onto the web server origin and refuses unparseable origins', () => {
    expect(previewHref('http://localhost:8080/', 34567)).toBe('http://localhost:34567')
    expect(previewHref(undefined, 34567)).toBeUndefined()
    expect(previewHref('::::', 34567)).toBeUndefined()
  })
})

describe('escapeHtml', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml('<script>"x"&amp;</script>')).toBe('&lt;script&gt;&quot;x&quot;&amp;amp;&lt;/script&gt;')
  })
})

describe('catalogView', () => {
  it('returns an empty view for a missing apps directory', async () => {
    const view = await catalogView(join(workspace, 'missing'))
    expect(view.apps).toEqual([])
    expect(view.skipped).toEqual([])
  })

  it('carries status, publish, and the preview link with the spawn port', async () => {
    const app = await appFixture(workspace, 'web-complete', JSON.stringify({
      version: 1, sourceCommit: 'a'.repeat(40), createdAt: '2026-01-01T00:00:00.000Z',
      goalSha256: 'b'.repeat(64), homePath: '.mutation-home', port: 34567,
    }, null, 2))
    await completeApp(app)
    await publishApp({ appPath: app, target: 'hostinger' })
    const view = await catalogView(workspace, 'http://localhost:8080')
    const entry = view.apps.find(item => item.name === 'web-complete')
    expect(entry).toMatchObject({
      status: 'complete', previewPort: 34567, previewHref: 'http://localhost:34567',
      publish: { decision: 'manifest-ready', target: 'hostinger' },
    })
  })

  it('omits the preview link when the spawn record carries no port', async () => {
    await appFixture(workspace, 'web-no-port')
    const view = await catalogView(workspace)
    const entry = view.apps.find(item => item.name === 'web-no-port')
    expect(entry?.previewPort).toBeUndefined()
    expect(entry?.previewHref).toBeUndefined()
  })
})

describe('renderCatalogPage', () => {
  it('renders an explicit empty state', () => {
    const page = renderCatalogPage({ apps: [], skipped: [], generatedAt: '2026-01-01T00:00:00.000Z' })
    expect(page).toContain('The catalog is empty')
  })

  it('renders escaped app rows with status, publish, and preview links', () => {
    const page = renderCatalogPage({
      apps: [
        {
          name: '<script>alert(1)</script>', status: 'complete', milestone: 2, milestonesTotal: 2,
          lastGreenCommit: 'a'.repeat(40),
          publish: { version: 1, app: 'x', decision: 'manifest-ready', target: 'cloudflare', surface: 'web', commit: 'a'.repeat(40), createdAt: '2026-01-01T00:00:00.000Z' },
          previewPort: 34567, previewHref: 'http://localhost:34567',
        },
        { name: 'draft', status: 'in-progress', milestone: 1, milestonesTotal: 2, lastGreenCommit: 'b'.repeat(40) },
        { name: 'halted', status: 'paused', milestone: 1, milestonesTotal: 2, lastGreenCommit: 'c'.repeat(40) },
      ],
      skipped: [{ name: 'sealed', reason: 'EACCES: sealed' }],
      generatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(page).not.toContain('<script>alert')
    expect(page).toContain('&lt;script&gt;')
    expect(page).toContain('badge complete')
    expect(page).toContain('in progress')
    expect(page).toContain('badge paused')
    expect(page).toContain('manifest-ready (cloudflare)')
    expect(page).toContain('href="http://localhost:34567"')
    expect(page).toContain('not published')
    expect(page).toContain('skipped:')
    expect(page).toContain('sealed')
  })
})

describe('registerCatalogWeb', () => {
  it('registers both routes and serves JSON and HTML after the connection fence', async () => {
    const app = await appFixture(workspace, 'web-served', JSON.stringify({
      version: 1, sourceCommit: 'a'.repeat(40), createdAt: '2026-01-01T00:00:00.000Z',
      goalSha256: 'b'.repeat(64), homePath: '.mutation-home', port: 34567,
    }, null, 2))
    await completeApp(app)
    const { web, service } = fakeWebServer()
    const dispose = registerCatalogWeb(fakeCtx(service), workspace)
    expect([...web.routes.keys()]).toEqual([CATALOG_JSON_PATH, CATALOG_PAGE_PATH])

    const json = await web.routes.get(CATALOG_JSON_PATH)!.resource(new Request(`http://localhost${CATALOG_JSON_PATH}`))
    expect(json.status).toBe(200)
    expect(json.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(json.headers.get('cache-control')).toBe('no-store')
    const body = await json.json() as { apps: { previewHref?: string }[] }
    expect(body.apps[0]?.previewHref).toBe('http://localhost:34567')

    const page = await web.routes.get(CATALOG_PAGE_PATH)!.resource(new Request(`http://localhost${CATALOG_PAGE_PATH}`))
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await page.text()).toContain('Artifork catalog')

    dispose()
    expect(web.disposed).toBe(2)
    expect(web.routes.size).toBe(0)
  })

  it('refuses rejected requests before any scan runs, on both routes', async () => {
    const { web, service } = fakeWebServer()
    const ctx = { webServer: service, connection: { requestRejection: () => 403 } } as unknown as Context
    registerCatalogWeb(ctx, join(workspace, 'never-read'))
    const json = await web.routes.get(CATALOG_JSON_PATH)!.resource(new Request(`http://localhost${CATALOG_JSON_PATH}`))
    const page = await web.routes.get(CATALOG_PAGE_PATH)!.resource(new Request(`http://localhost${CATALOG_PAGE_PATH}`))
    expect(json.status).toBe(403)
    expect(page.status).toBe(403)
  })

  it('keeps serving when the origin is unparseable; the port survives but the link does not', async () => {
    const app = await appFixture(workspace, 'web-bad-origin', JSON.stringify({
      version: 1, sourceCommit: 'a'.repeat(40), createdAt: '2026-01-01T00:00:00.000Z',
      goalSha256: 'b'.repeat(64), homePath: '.mutation-home', port: 34567,
    }, null, 2))
    await completeApp(app)
    const { web, service } = fakeWebServer('::::')
    registerCatalogWeb(fakeCtx(service), workspace)
    const route = web.routes.get(CATALOG_JSON_PATH)!
    const response = await route.resource(new Request(`http://localhost${CATALOG_JSON_PATH}`))
    const body = await response.json() as { apps: { name: string; previewPort?: number; previewHref?: string }[] }
    expect(body.apps.find(item => item.name === 'web-bad-origin')).toMatchObject({ name: 'web-bad-origin', previewPort: 34567 })
    expect(body.apps.every(item => item.previewHref === undefined)).toBe(true)
  })
})

describe('apply', () => {
  it('mounts the catalog web routes only when the composition runs a web server', () => {
    const { web, service } = fakeWebServer()
    const section = vi.fn()
    const register = vi.fn()
    let injectNames: string[] = []
    const ctx = {
      systemPrompt: { section, getSectionOrder: (key: string) => (key === 'TOOL_FACTORY_CATALOG' ? 2680 : 0) },
      tools: { register },
      inject: (names: string[], callback: (webCtx: Context) => void) => {
        injectNames = names
        callback({ webServer: service, connection: { requestRejection: () => undefined } } as unknown as Context)
      },
    } as unknown as Context
    catalog.apply(ctx, { repositoryPath: workspace })
    expect(injectNames).toEqual(['webServer', 'connection'])
    expect(web.routes.has(CATALOG_JSON_PATH)).toBe(true)
    expect(web.routes.has(CATALOG_PAGE_PATH)).toBe(true)
  })

  it('leaves a web-server-less composition untouched: the tools still register', () => {
    const section = vi.fn()
    const register = vi.fn()
    const ctx = {
      systemPrompt: { section, getSectionOrder: (key: string) => (key === 'TOOL_FACTORY_CATALOG' ? 2680 : 0) },
      tools: { register },
      inject: vi.fn(),
    } as unknown as Context
    catalog.apply(ctx, { repositoryPath: workspace })
    expect(register).toHaveBeenCalled()
  })
})
