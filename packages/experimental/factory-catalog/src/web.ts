/**
 * The factory-catalog web surface: when the composition runs the web GUI's
 * `webServer`, the plugin serves `GET /factory/catalog` (an HTML overview)
 * and `GET /factory/catalog.json` (the same facts as JSON) straight from the
 * derived catalog, with each spawned app's preview port beside it.
 * @module @deepseek-ai/dsh-experimental-factory-catalog/web
 */

import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { readSpawnRecord } from '@deepseek-ai/dsh-experimental-factory'
import { scanApps, type AppStatus, type PublishRecord, type SkippedApp } from './catalog.ts'

/** The HTML catalog overview path. */
export const CATALOG_PAGE_PATH = '/factory/catalog'

/** The JSON catalog path. */
export const CATALOG_JSON_PATH = '/factory/catalog.json'

/** One spawned application as the catalog page renders it. */
export interface CatalogAppView {
  /** The app's directory name. */
  readonly name: string
  /** Derived lifecycle status. */
  readonly status: AppStatus
  /** Milestone the loop sits on (or finished at). */
  readonly milestone: number
  /** Total milestones the goal defines. */
  readonly milestonesTotal: number
  /** Commit the loop last verified green. */
  readonly lastGreenCommit: string
  /** The app's committed publish decision, when one exists. */
  readonly publish?: PublishRecord
  /** The clone's reserved preview port, when its spawn record carries one. */
  readonly previewPort?: number
  /** Absolute preview URL on the web server's own host, when the origin is known. */
  readonly previewHref?: string
}

/** A CatalogAppView under construction. */
type MutableApp = { -readonly [K in keyof CatalogAppView]: CatalogAppView[K] }

/** Everything one catalog page render needs. */
export interface CatalogViewModel {
  /** Readable spawned applications, sorted by name. */
  readonly apps: readonly CatalogAppView[]
  /** App directories that could not be read, with reasons. */
  readonly skipped: readonly SkippedApp[]
  /** ISO timestamp of the scan. */
  readonly generatedAt: string
}

/** Derive the renderable catalog view: one scan plus each app's preview port. */
export async function catalogView(appsDir: string, origin?: string, signal?: AbortSignal): Promise<CatalogViewModel> {
  const report = await scanApps(appsDir, signal)
  const apps: CatalogAppView[] = []
  for (const entry of report.entries) {
    const record = await readSpawnRecord(entry.appPath, signal)
    const port = record?.port
    const href = port === undefined ? undefined : previewHref(origin, port)
    const app: MutableApp = {
      name: entry.name,
      status: entry.status,
      milestone: entry.milestone,
      milestonesTotal: entry.milestonesTotal,
      lastGreenCommit: entry.lastGreenCommit,
    }
    if (entry.publish !== undefined) app.publish = { ...entry.publish }
    if (port !== undefined) app.previewPort = port
    if (href !== undefined) app.previewHref = href
    apps.push(app)
  }
  return { apps, skipped: report.skipped, generatedAt: new Date().toISOString() }
}

/** Absolute preview URL on the web server's own host; undefined when unparseable. */
export function previewHref(origin: string | undefined, port: number): string | undefined {
  if (origin === undefined) return undefined
  try {
    const url = new URL(origin)
    url.port = String(port)
    return url.origin
  } catch {
    return undefined
  }
}

/** Escape a value for safe interpolation into HTML text and attribute contexts. */
export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

const STATUS_LABEL: Record<AppStatus, string> = {
  complete: 'complete',
  'in-progress': 'in progress',
  paused: 'paused',
}

/** Render the catalog view as one self-contained HTML page; every app value is escaped. */
export function renderCatalogPage(view: CatalogViewModel): string {
  const cards = view.apps.map(app => {
    const publish = app.publish === undefined
      ? '<span class="muted">not published</span>'
      : `<span class="badge publish">${escapeHtml(app.publish.decision)} (${escapeHtml(app.publish.target)})</span>`
    const preview = app.previewHref === undefined
      ? ''
      : ` <a class="preview" href="${escapeHtml(app.previewHref)}">open preview ↗</a>`
    return [
      '<li class="app">',
      `<span class="badge ${app.status === 'complete' ? 'complete' : app.status === 'paused' ? 'paused' : 'progress'}">${STATUS_LABEL[app.status]}</span>`,
      ` <strong>${escapeHtml(app.name)}</strong>`,
      ` <span class="muted">milestone M${app.milestone}/${app.milestonesTotal} · green at ${escapeHtml(app.lastGreenCommit.slice(0, 12))}</span>`,
      ` ${publish}${preview}`,
      '</li>',
    ].join('')
  })
  const skips = view.skipped.map(item => `<li><code>${escapeHtml(item.name)}</code> skipped: ${escapeHtml(item.reason)}</li>`)
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Artifork catalog</title>`,
    '<style>',
    'body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 46rem; padding: 0 1rem; color: inherit; }',
    'h1 { font-size: 1.4rem; } .muted { opacity: 0.65; font-size: 0.9rem; }',
    '.badge { border: 1px solid currentColor; border-radius: 999px; padding: 0.05rem 0.55rem; font-size: 0.75rem; }',
    '.complete { opacity: 1; } .progress, .paused { opacity: 0.75; } .publish { font-weight: 600; }',
    'ul { list-style: none; padding: 0; } li.app { padding: 0.6rem 0; border-top: 1px solid color-mix(in srgb, currentColor 20%, transparent); }',
    'a.preview { margin-left: 0.35rem; }',
    '</style>',
    '</head>',
    '<body>',
    '<h1>Artifork catalog</h1>',
    '<p class="muted">Every spawned application, derived from its own files and git history. JSON: <a href="/factory/catalog.json">/factory/catalog.json</a></p>',
    view.apps.length === 0 ? '<p class="muted">The catalog is empty: no spawned applications under the configured apps directory.</p>' : `<ul>${cards.join('')}</ul>`,
    skips.length === 0 ? '' : `<h2>Skipped</h2><ul>${skips.join('')}</ul>`,
    `<p class="muted">Generated ${escapeHtml(view.generatedAt)}</p>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/** The trust surface consumed here; the browser-side connection package owns the full type. */
interface CatalogConnection {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** The web server surface consumed here: route registration plus the origin previews link against. */
interface CatalogWebServer {
  getOrigin(): string
  register(route: { kind: 'exact'; path: string; resource: (request: Request) => Promise<Response> }): () => void
}

/** Register both catalog routes with the composition's connection fence in front of them. */
export function registerCatalogWeb(ctx: Context, appsDir: string): () => void {
  const webServer = Reflect.get(ctx, 'webServer') as CatalogWebServer
  const connection = Reflect.get(ctx, 'connection') as CatalogConnection
  const origin = webServer.getOrigin()
  const admitted = (request: Request): Response | undefined => {
    const rejection = connection.requestRejection({ headers: Object.fromEntries(request.headers) })
    return rejection === undefined ? undefined : new Response(null, { status: rejection })
  }
  const disposeJson = webServer.register({
    kind: 'exact',
    path: CATALOG_JSON_PATH,
    resource: async request => {
      const rejected = admitted(request)
      if (rejected !== undefined) return rejected
      const view = await catalogView(appsDir, origin, request.signal)
      return new Response(JSON.stringify(view), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    },
  })
  const disposePage = webServer.register({
    kind: 'exact',
    path: CATALOG_PAGE_PATH,
    resource: async request => {
      const rejected = admitted(request)
      if (rejected !== undefined) return rejected
      const view = await catalogView(appsDir, origin, request.signal)
      return new Response(renderCatalogPage(view), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      })
    },
  })
  return () => {
    disposeJson()
    disposePage()
  }
}
