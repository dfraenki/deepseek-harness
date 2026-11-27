import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { GOAL_FILE_NAME, SPAWN_RECORD_NAME } from '@deepseek-ai/dsh-experimental-factory'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deriveStatus, detectSurface, publishApp, scanApps } from '../src/catalog.ts'

const run = promisify(execFile)

let workspace: string

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-factory-catalog-'))
})

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

const GOAL = '## Milestones\n\n- M1: Engine\n\n- M2: Interface\n\n## Acceptance criteria\n\n- M1: `echo core > core.ts` builds\n\n- M2: `echo ui > ui.ts` builds\n'

async function git(cwd: string, args: string[]): Promise<string> {
  return run('git', args, { cwd }).then(({ stdout }) => stdout.trim())
}

/** Create a spawned-app fixture with the goal committed as the spawn baseline. */
async function appFixture(root: string, name: string): Promise<string> {
  const app = join(root, name)
  await mkdir(app, { recursive: true })
  await writeFile(join(app, SPAWN_RECORD_NAME), '{}\n')
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

describe('scanApps', () => {
  it('returns an empty report for a missing apps directory', async () => {
    const report = await scanApps(join(workspace, 'missing'))
    expect(report.entries).toEqual([])
    expect(report.skipped).toEqual([])
  })

  it('skips directories without a spawn record and reports unreadable apps', async () => {
    const plain = join(workspace, 'plain-dir')
    await mkdir(plain, { recursive: true })
    await appFixture(workspace, 'broken-app')
    await rm(join(workspace, 'broken-app', GOAL_FILE_NAME))
    const report = await scanApps(workspace)
    expect(report.entries).toEqual([])
    expect(report.skipped).toHaveLength(1)
    expect(report.skipped[0]?.name).toBe('broken-app')
  })

  it('derives in-progress, complete, and paused entries with milestone progress', async () => {
    const running = await appFixture(workspace, 'app-running')
    const finished = await appFixture(workspace, 'app-finished')
    await completeApp(finished)
    const paused = await appFixture(workspace, 'app-paused')
    await mkdir(join(paused, '.coaches'), { recursive: true })
    await writeFile(join(paused, '.coaches', 'PAUSE'), 'paused\n')
    const report = await scanApps(workspace)
    const names = report.entries.map(entry => entry.name)
    expect(names).toEqual(['app-finished', 'app-paused', 'app-running'])
    const finishedEntry = report.entries.find(entry => entry.name === 'app-finished')
    expect(finishedEntry).toMatchObject({ status: 'complete', milestone: 1, milestonesTotal: 2 })
    expect(report.entries.find(entry => entry.name === 'app-paused')?.status).toBe('paused')
    expect(report.entries.find(entry => entry.name === 'app-running')?.status).toBe('in-progress')
  })

  it('carries the committed publish decision into the entry', async () => {
    const app = await appFixture(workspace, 'app-published')
    await completeApp(app)
    await publishApp({ appPath: app, target: 'catalog-only' })
    const report = await scanApps(workspace)
    const entry = report.entries.find(item => item.name === 'app-published')
    expect(entry?.publish).toMatchObject({ decision: 'catalog-only', target: 'catalog-only', app: 'app-published' })
  })

  it('skips an app whose publish record cannot be read, and rethrows other read errors', async () => {
    const app = await appFixture(workspace, 'app-sealed-record')
    await completeApp(app)
    await writeFile(join(app, 'PUBLISH_RECORD.json'), '{}\n')
    await chmod(join(app, 'PUBLISH_RECORD.json'), 0o000)
    try {
      const report = await scanApps(workspace)
      expect(report.skipped.find(item => item.name === 'app-sealed-record')?.reason).toBeTruthy()
    } finally {
      await chmod(join(app, 'PUBLISH_RECORD.json'), 0o644)
    }
    await mkdir(join(workspace, 'sealed-apps'), { recursive: true })
    await chmod(join(workspace, 'sealed-apps'), 0o000)
    try {
      await expect(scanApps(join(workspace, 'sealed-apps'))).rejects.toThrow()
    } finally {
      await chmod(join(workspace, 'sealed-apps'), 0o755)
    }
  })
})

describe('deriveStatus', () => {
  it('treats a dirty tree as in-progress even after the last milestone commit', async () => {
    const app = await appFixture(workspace, 'status-dirty')
    await completeApp(app)
    await writeFile(join(app, 'stray.txt'), 'uncommitted\n')
    expect(await deriveStatus(app, 'M2 Interface')).toBe('in-progress')
  })
})

describe('detectSurface', () => {
  it('detects the web bundle from the apps directory layout', async () => {
    const app = await appFixture(workspace, 'surface-web')
    await mkdir(join(app, 'apps', 'web'), { recursive: true })
    expect(await detectSurface(app)).toBe('web')
  })

  it('falls back to headless without an apps directory', async () => {
    const app = await appFixture(workspace, 'surface-headless')
    expect(await detectSurface(app)).toBe('headless')
  })

  it('rethrows read errors that are not missing-directory errors', async () => {
    const app = await appFixture(workspace, 'surface-sealed')
    await mkdir(join(app, 'apps'), { recursive: true })
    await chmod(join(app, 'apps'), 0o000)
    try {
      await expect(detectSurface(app)).rejects.toThrow()
    } finally {
      await chmod(join(app, 'apps'), 0o755)
    }
  })
})

describe('publishApp', () => {
  it('refuses unknown targets and apps without a spawn record', async () => {
    const app = await appFixture(workspace, 'publish-invalid')
    await expect(publishApp({ appPath: app, target: 'vercel' as never })).rejects.toThrow('target must be one of')
    await expect(publishApp({ appPath: join(workspace, 'not-an-app'), target: 'catalog-only' }))
      .rejects.toThrow('no MUTATION_SPAWN.json')
  })

  it('refuses an app that has not completed its goal', async () => {
    const app = await appFixture(workspace, 'publish-incomplete')
    await expect(publishApp({ appPath: app, target: 'catalog-only' })).rejects.toThrow('is not complete')
  })

  it('records a catalog-only decision as a committed publish record', async () => {
    const app = await appFixture(workspace, 'publish-catalog')
    await completeApp(app)
    const report = await publishApp({ appPath: app, target: 'catalog-only' })
    expect(report.decision).toBe('catalog-only')
    expect(report.manifestPath).toBeUndefined()
    const record = JSON.parse(await readFile(join(app, 'PUBLISH_RECORD.json'), 'utf8'))
    expect(record).toMatchObject({ version: 1, app: 'publish-catalog', decision: 'catalog-only', surface: 'headless' })
    expect(await git(app, ['status', '--porcelain'])).toBe('')
    expect(await git(app, ['log', '-1', '--format=%s'])).toBe('Publish: catalog-only (catalog-only)')
  })

  it('writes a ready-to-run manifest for a hosting decision and commits both files', async () => {
    const app = await appFixture(workspace, 'publish-cloudflare')
    await mkdir(join(app, 'apps', 'web'), { recursive: true })
    await completeApp(app)
    const report = await publishApp({ appPath: app, target: 'cloudflare' })
    expect(report.decision).toBe('manifest-ready')
    expect(report.manifestPath).toBeDefined()
    const manifest = await readFile(report.manifestPath, 'utf8')
    expect(manifest).toContain('wrangler pages deploy')
    expect(manifest).toContain('never stores cloud credentials')
    expect(await git(app, ['status', '--porcelain'])).toBe('')
    expect(await git(app, ['log', '-1', '--format=%s'])).toBe('Publish manifest for cloudflare')
  })

  it('refuses a headless app on the cloudflare target', async () => {
    const app = await appFixture(workspace, 'publish-headless-cloud')
    await completeApp(app)
    await expect(publishApp({ appPath: app, target: 'cloudflare' })).rejects.toThrow('cannot deploy to cloudflare')
  })

  it('writes the hostinger manifest for both surfaces', async () => {
    const webApp = await appFixture(workspace, 'publish-hostinger-web')
    await mkdir(join(webApp, 'apps', 'web'), { recursive: true })
    await completeApp(webApp)
    const webReport = await publishApp({ appPath: webApp, target: 'hostinger' })
    const webManifest = await readFile(webReport.manifestPath, 'utf8')
    expect(webManifest).toContain('upload the built output')
    const headlessApp = await appFixture(workspace, 'publish-hostinger-headless')
    await completeApp(headlessApp)
    const headlessReport = await publishApp({ appPath: headlessApp, target: 'hostinger' })
    const headlessManifest = await readFile(headlessReport.manifestPath, 'utf8')
    expect(headlessManifest).toContain('pnpm build:lib:host')
  })

  it('refuses a dirty tree before recording any decision', async () => {
    const app = await appFixture(workspace, 'publish-dirty')
    await completeApp(app)
    await writeFile(join(app, 'stray.txt'), 'uncommitted\n')
    await expect(publishApp({ appPath: app, target: 'catalog-only' })).rejects.toThrow('is not complete')
  })
})
