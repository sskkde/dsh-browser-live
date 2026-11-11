/**
 * dsh-browser-live — host-side `browser_live_*` tools.
 *
 * Restores the high-frequency capabilities lost with the retired
 * `@anweat/dsh-browser`, driven against the calling session's own Neko
 * container (Phase 6 of the concurrency plan):
 *
 *  - browser_live_open    (was browser_open, 240 calls) one-shot open + read
 *  - browser_live_script  (was browser_script_run_builtin, 53) builtin read-only extraction
 *  - browser_live_recipe  (was browser_recipe_run, 34) declarative replay
 *  - browser_live_status  (was browser_status, 26) session/container facts
 *  - browser_live_fetch   (was web_fetch_pro, 989) render a URL in the session's
 *                         Neko and return its readable text
 *
 * Division of labor (models should not guess): the `mcp__playwright-mcp__browser_*`
 * tools own interactive, stateful control of the live browser; the
 * `browser_live_*` tools are one-shot page-level operations that always target
 * the session's visible tab (fetch always uses a throwaway tab).
 */

import fs from 'node:fs'
import path from 'node:path'
import playwrightCore from 'playwright-core'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CONTAINER_DOWNLOADS, dshHome, downloadsDir, sessionShort } from './service.js'
import { log, warn } from './log.js'
import { builtinScripts, scriptCatalog, scriptSha256 } from './scripts.js'
import { runRecipe, validateRecipeSteps, MAX_STEPS } from './recipes.js'
import { copyFileIntoWorkspace, exportArtifact } from './sharing/export.js'
import { RevisionConflictError } from './sharing/auth-store.js'
import { safeExportName } from './sharing/artifact-store.js'
import { selectCapture } from './sharing/capture.js'

const COMPLIANCE_NOTICE = 'Runs inside the session live-view browser; use it according to the target site rules.'

const BLANK_URL = /^(about:blank|chrome:\/\/|edge:\/\/|data:)/i

const WAIT_UNTIL = new Set(['load', 'domcontentloaded', 'networkidle', 'commit'])

/** RC.2 tool outputs must be lossless JSON; omit optional undefined object fields. */
function stripUndefined(value) {
  if (Array.isArray(value)) {
    return Array.from(value, (item) => item === undefined ? null : stripUndefined(item))
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, stripUndefined(item)]))
  }
  return value
}

/** Keep optional JS result fields absent rather than returning non-JSON `undefined`. */
function defineLiveTool(options) {
  const execute = options.execute
  return defineTool({
    ...options,
    async execute(...args) {
      return stripUndefined(await execute(...args))
    },
  })
}

function sessionId(exec) {
  const value = exec?.agent?.session?.id
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('browser_live_* tools require a live session (no session id on the calling agent)')
  }
  return value
}

/** The session's "visible tab": last non-blank page, else the last page. */
function pickMainPage(context) {
  const pages = context.pages()
  if (pages.length === 0) return null
  for (const page of [...pages].reverse()) {
    if (!BLANK_URL.test(page.url())) return page
  }
  return pages[pages.length - 1]
}

/**
 * The page a tool should act on: an explicit tab index when the caller named one,
 * otherwise the session's visible tab.
 *
 * The heuristic is wrong whenever a session keeps several tabs open (it picks the
 * newest non-blank one), so `tab` is the escape hatch — and `browser_live_status`
 * lists the indices to choose from.
 *
 * @param {import('playwright-core').BrowserContext} context - the session's context.
 * @param {number | undefined} tab - zero-based index into `context.pages()`.
 * @returns {import('playwright-core').Page | null} the page, or null when none is open.
 */
export function pickPage(context, tab) {
  if (tab === undefined || tab === null) return pickMainPage(context)
  const pages = context.pages()
  if (!Number.isInteger(tab) || tab < 0 || tab >= pages.length) {
    throw new Error(`tab ${String(tab)} does not exist; this session has ${pages.length} tab(s) — call browser_live_status for the list`)
  }
  return pages[tab]
}

/** Every open tab as `{index, url, title?, blank}` for `browser_live_status`. */
async function describeTabs(context) {
  const tabs = []
  for (const [index, page] of context.pages().entries()) {
    tabs.push({
      index,
      url: page.url(),
      title: await page.title().catch(() => undefined),
      blank: BLANK_URL.test(page.url()),
    })
  }
  return tabs
}

/**
 * Settle a freshly navigated page.
 *
 * `waitUntil: 'load'` alone loses single-page apps, so callers can name a
 * selector, a visible text, or a quiet network — the three waits that actually
 * mean "the content is here".
 *
 * @param {import('playwright-core').Page} page - the navigated page.
 * @param {{ waitMs?: number, waitFor?: { selector?: string, text?: string, networkIdle?: boolean, timeoutMs?: number } }} args
 * @returns {Promise<void>} rejects when the wait itself times out.
 */
export async function settle(page, args) {
  if (Number.isFinite(args.waitMs)) await page.waitForTimeout(Math.min(args.waitMs, 15_000))
  const wait = args.waitFor
  if (wait === undefined || wait === null || typeof wait !== 'object') return
  const timeout = Number.isFinite(wait.timeoutMs)
    ? Math.min(Math.max(wait.timeoutMs, 100), 60_000)
    : 30_000
  if (typeof wait.selector === 'string' && wait.selector.length > 0) {
    await page.waitForSelector(wait.selector, { state: 'visible', timeout })
  }
  if (typeof wait.text === 'string' && wait.text.length > 0) {
    await page.waitForFunction((text) => (document.body?.innerText || '').includes(text), wait.text, { timeout })
  }
  if (wait.networkIdle === true) await page.waitForLoadState('networkidle', { timeout })
}

/** Goto options honouring a caller-supplied `waitUntil`. */
export function gotoOptions(args) {
  return {
    waitUntil: typeof args.waitUntil === 'string' && WAIT_UNTIL.has(args.waitUntil) ? args.waitUntil : 'load',
    timeout: 45_000,
  }
}

const TAB_PARAM = { type: 'number', description: 'Zero-based tab index (browser_live_status lists them); default is the session\'s visible tab.' }

const WAIT_FOR_PARAM = {
  type: 'object',
  additionalProperties: false,
  description: 'Extra wait after navigation, for pages whose content arrives late.',
  properties: {
    selector: { type: 'string', description: 'Wait until this CSS selector is visible.' },
    text: { type: 'string', description: 'Wait until this text appears in the body.' },
    networkIdle: { type: 'boolean', description: 'Wait until the network has been quiet for 500ms.' },
    timeoutMs: { type: 'number', description: 'Budget for these waits (default 30000, max 60000).' },
  },
}

const WAIT_UNTIL_PARAM = {
  type: 'string',
  enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
  description: 'Navigation milestone to wait for (default load).',
}

/**
 * Run one operation against the session's browser.
 *
 * The optional `prepare`/`targetUrl` inputs are the sharing seam: a restore has
 * to happen before the operation's first request, and a blank browser has no
 * page to read an origin from, so the URL this call is about to open is the
 * target. `prepare:false` is for `state save`, which captures the *current*
 * login and must never overwrite it with the stored revision first.
 */
async function withSession(browserLive, exec, run, { prepare = true, targetUrl = null, targetOrigin = null } = {}) {
  const id = sessionId(exec)
  // The lease spans ensure() and the whole operation, so the pool can never
  // reclaim this slot (TTL sweep or LRU eviction) while a tool is using it.
  const releaseLease = browserLive.lease(id)
  try {
    const entry = await browserLive.ensure(id)
    const browser = await playwrightCore.chromium.connectOverCDP(`http://127.0.0.1:${entry.cdpPort}`, { noDefaults: true })
    let prepared = null
    try {
      const context = browser.contexts()[0]
      if (!context) throw new Error('session browser has no default context yet; open a page first')
      // Cross-session sharing: restore the bound login before the operation
      // runs. Absent when sharing is off (the service holds no coordinator).
      const sharing = browserLive.sharing
      if (prepare && sharing !== null && sharing !== undefined) {
        prepared = await sharing.coordinator.prepare({ agent: exec?.agent, sessionId: id, context, entry, targetUrl, targetOrigin })
        if (prepared.restored !== true && prepared.reason !== 'no-binding-for-origin'
          && prepared.reason !== 'no-bindings-configured' && prepared.reason !== 'no-target-origin'
          && prepared.reason !== 'already-restored' && prepared.reason !== 'credentials-withheld') {
          warn('shared login for session', id, 'was not restored:', prepared.reason)
        }
      }
      return await run(context, entry, id)
    } finally {
      if (prepared?.restored === true && browserLive.sharing !== null && browserLive.sharing !== undefined) {
        await browserLive.sharing.coordinator.finish({ context: browser.contexts()[0], sessionId: id }).catch(() => undefined)
      }
      // Publish what this operation produced (screenshots, finished downloads)
      // without holding the tool call open on the hash/commit work.
      if (browserLive.sharing !== null && browserLive.sharing !== undefined) {
        void browserLive.sharing.collect?.({ sessionId: id, entry }).catch((error) => warn('artifact collect failed:', error.message))
      }
      // Detaches this client only: the Neko browser, its tabs, and the live view
      // are untouched (contexts/pages created here are cleaned up by close()).
      await browser.close().catch(() => undefined)
    }
  } finally {
    releaseLease()
  }
}

/**
 * Publish one screenshot the native path just wrote, so the response can name
 * its `artifactId` (and say why publication failed instead of hiding it).
 * @param {object} browserLive - the pool (holds the sharing runtime).
 * @param {object} entry - the session's map entry.
 * @param {string} id - session id.
 * @param {string} filePath - the screenshot on the host.
 * @returns {Promise<object>} `{ artifactId?, published, reason? }`.
 */
async function publishScreenshot(browserLive, entry, id, filePath) {
  const sharing = browserLive.sharing
  if (sharing === null || sharing === undefined || typeof sharing.publishCaptured !== 'function') {
    return { published: false, reason: 'sharing-disabled' }
  }
  return sharing.publishCaptured({ sessionId: id, entry, filePath, kind: 'screenshot' })
}

/**
 * `browser_live_state` against the shared login store (sharing enabled).
 *
 * The store is keyed by `scopeId + siteKey + accountKey`, so this tool must
 * decide the site *before* capturing: the visible tab names the origin, the
 * configured binding names the account, and only the binding's cookie domains
 * and SSO origins are stored. Capturing "every cookie of the context" under the
 * first page's key would silently mix sites and accounts.
 * @param {{ sharing: object, browserLive: object, args: object, exec: object }} input - tool call context.
 * @returns {Promise<object>} the tool result.
 */
async function executeSharedState({ sharing, browserLive, args, exec }) {
  const { scopeId } = sharing.scope.scopeFor(exec?.agent)
  const id = sessionId(exec)
  const requested = typeof args.name === 'string' && args.name.trim().length > 0 ? args.name.trim() : null

  if (args.action === 'list') {
    const states = await sharing.auth.list({ scopeId })
    return {
      action: 'list',
      path: `shared:${scopeId}`,
      cookies: 0,
      origins: 0,
      states: states.map((state) => ({
        name: `${state.siteKey} ${state.accountKey}`,
        siteKey: state.siteKey,
        accountKey: state.accountKey,
        savedAt: Number.isFinite(state.capturedAt) ? new Date(state.capturedAt).toISOString() : undefined,
        cookies: 0,
        origins: 0,
        revision: state.revision,
        epoch: state.epoch,
        revoked: state.revoked,
      })),
    }
  }

  if (args.action === 'forget') {
    if (requested === null) throw new Error('forget requires the account name')
    const states = await sharing.auth.list({ scopeId })
    const matches = states.filter((state) => state.accountKey === requested)
    if (matches.length === 0) throw new Error(`no shared account named "${requested}"`)
    const results = []
    for (const state of matches) {
      // An already-revoked account needs no second tombstone: bumping the epoch
      // again would only make acknowledgements harder. Still clear live copies.
      if (state.revoked === true) {
        const cleared = await clearRestoredInstances({ sharing, browserLive, siteKey: state.siteKey, accountKey: requested })
        results.push({ siteKey: state.siteKey, epoch: state.epoch, revision: state.revision, alreadyRevoked: true, cleared })
        continue
      }
      let revoked
      try {
        revoked = await sharing.auth.revoke({ scopeId, siteKey: state.siteKey, accountKey: requested, expectedRevision: state.revision })
      } catch (error) {
        if (error instanceof RevisionConflictError) {
          throw new Error(`forget conflict for ${state.siteKey} ${requested}: the store moved to revision ${error.current?.revision ?? 'none'} (epoch ${error.current?.epoch ?? 0}); list and retry`)
        }
        throw error
      }
      const cleared = await clearRestoredInstances({ sharing, browserLive, siteKey: state.siteKey, accountKey: requested })
      results.push({ siteKey: state.siteKey, epoch: revoked.epoch, revision: revoked.revision, cleared })
    }
    return {
      action: 'forget',
      name: requested,
      path: `shared:${scopeId}`,
      cookies: 0,
      origins: 0,
      appliedOrigins: results.map((item) => item.siteKey),
      revisions: results,
    }
  }

  if (args.action === 'save') {
    const captured = await withSession(browserLive, exec, async (context) => {
      const page = pickPage(context, args.tab)
      if (!page) throw new Error('save needs an open http(s) page: nothing to capture')
      let origin
      try {
        origin = new URL(page.url()).origin
      } catch {
        throw new Error(`save needs an open http(s) page: ${page.url()} is not one`)
      }
      if (!origin.startsWith('http://') && !origin.startsWith('https://')) {
        throw new Error(`save needs an open http(s) page: ${page.url()} is not one`)
      }
      const binding = typeof sharing.bindings?.forOrigin === 'function' ? sharing.bindings.forOrigin(origin) : null
      if (binding === null) {
        throw new Error(`origin ${origin} is not bound to an account; add a sharing.bindings entry before saving its login state`)
      }
      if (requested !== null && requested !== binding.accountKey) {
        throw new Error(`account conflict: ${origin} is bound to "${binding.accountKey}", not "${requested}"; use another origin or update the admin binding`)
      }
      const allowedOrigins = new Set([origin, ...(binding?.ssoOrigins ?? [])])
      const pages = []
      for (const open of context.pages()) {
        let pageOrigin
        try {
          pageOrigin = new URL(open.url()).origin
        } catch {
          continue
        }
        // Read localStorage only for allowed origins; disallowed ones are still
        // listed so the caller sees exactly what the site policy skipped.
        const items = allowedOrigins.has(pageOrigin)
          ? await open.evaluate(() => Object.entries(window.localStorage).map(([name, value]) => ({ name, value }))).catch(() => [])
          : []
        pages.push({ origin: pageOrigin, localStorage: items })
      }
      const plan = selectCapture({
        cookies: await context.cookies(),
        pages,
        binding,
        origin,
        requestedAccount: requested,
      })
      return {
        origin,
        siteKey: binding?.siteKey ?? origin,
        account: plan.accountKey,
        cookies: plan.cookies,
        origins: plan.origins,
        droppedCookieDomains: plan.droppedCookieDomains,
        skippedOrigins: plan.skippedOrigins,
      }
    }, { prepare: false })
    let summary
    try {
      summary = await sharing.auth.publish({
        scopeId,
        siteKey: captured.siteKey,
        accountKey: captured.account,
        sourceSessionId: id,
        state: { cookies: captured.cookies, origins: captured.origins },
        expectedRevision: typeof args.expectedRevision === 'string' ? args.expectedRevision : null,
        expectedEpoch: Number.isSafeInteger(args.expectedEpoch) ? args.expectedEpoch : null,
      })
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        throw new Error(`revision conflict: current revision for ${captured.siteKey} ${captured.account} is ${error.current?.revision ?? 'none'} (epoch ${error.current?.epoch ?? 0}); re-read with action "list" and retry with that expectedRevision`)
      }
      throw error
    }
    return {
      action: 'save',
      name: captured.account,
      path: `shared:${captured.siteKey}`,
      savedAt: new Date(summary.capturedAt).toISOString(),
      url: captured.origin,
      cookies: captured.cookies.length,
      origins: captured.origins.length,
      siteKey: captured.siteKey,
      accountKey: captured.account,
      revision: summary.revision,
      epoch: summary.epoch,
      skippedOrigins: captured.skippedOrigins,
      droppedCookieDomains: captured.droppedCookieDomains,
    }
  }

  // load: explicit refresh of this browser instance from the stored revision.
  if (requested === null) throw new Error('load requires the account name')
  const outcome = await withSession(browserLive, exec, async (context, entry, sessionIdValue) => sharing.coordinator.prepare({
    agent: exec?.agent,
    sessionId: sessionIdValue,
    context,
    entry,
    force: true,
    accountKey: requested,
  }), { prepare: false })
  if (outcome.restored !== true) {
    throw new Error(`cannot restore "${requested}" in this browser: ${outcome.reason ?? 'unknown reason'}`)
  }
  return {
    action: 'load',
    name: requested,
    path: `shared:${outcome.siteKey}`,
    url: outcome.siteKey,
    cookies: 0,
    origins: 0,
    appliedOrigins: [outcome.siteKey],
    skippedOrigins: outcome.skippedOrigins ?? [],
    siteKey: outcome.siteKey,
    accountKey: outcome.accountKey,
    revision: outcome.revision,
    epoch: outcome.epoch,
  }
}

/**
 * Clear the state every live session imported from one shared account, after a
 * revocation. The repository tombstone is not enough: a browser that already
 * holds the cookies would keep browsing as the revoked account.
 * @param {{ sharing: object, browserLive: object, siteKey: string, accountKey: string }} input
 * @returns {Promise<object[]>} per-session outcomes.
 */
async function clearRestoredInstances({ sharing, browserLive, siteKey, accountKey }) {
  const results = []
  for (const record of sharing.coordinator.status().sessions) {
    if (record.siteKey !== siteKey || record.accountKey !== accountKey) continue
    const entry = browserLive.entryFor(record.sessionId)
    try {
      const outcome = await sharing.coordinator.clearRestored({
        sessionId: record.sessionId,
        entry,
        attach: (endpoint) => playwrightCore.chromium.connectOverCDP(endpoint, { noDefaults: true }),
      })
      results.push({ sessionId: record.sessionId, ...outcome })
    } catch (error) {
      results.push({ sessionId: record.sessionId, cleared: false, reason: error.message })
    }
  }
  return results
}

/** artifactIds already published for one session output directory (best effort). */
function readArtifactIds(browserLive, entry, kind) {
  if (browserLive.sharing === null || browserLive.sharing === undefined || entry === null || entry === undefined) return {}
  try {
    const indexFile = path.join(dshHome(), 'data', 'browser-live', entry.short, `.artifacts-${kind}.json`)
    const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    const result = {}
    for (const [name, value] of Object.entries(parsed?.entries ?? {})) {
      if (typeof value?.artifactId === 'string') result[name] = value.artifactId
    }
    return result
  } catch {
    return {}
  }
}

function screenshotDir(short) {
  const dir = path.join(dshHome(), 'data', 'browser-live', short)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function captureChannels(page, capture, navigate) {
  const channels = Array.isArray(capture) ? capture : []
  const wantConsole = channels.includes('console')
  const wantNetwork = channels.includes('network')
  const consoleMessages = []
  const networkRequests = []
  const onConsole = wantConsole
    ? (message) => {
        if (consoleMessages.length < 100) {
          consoleMessages.push(`${message.type()}: ${message.text()}`.slice(0, 500))
        }
      }
    : null
  const onResponse = wantNetwork
    ? (response) => {
        if (networkRequests.length < 100) {
          const status = response.status()
          if (status >= 400 || channels.length > 0) {
            networkRequests.push({ status, url: response.url().slice(0, 500) })
          }
        }
      }
    : null
  if (onConsole) page.on('console', onConsole)
  if (onResponse) page.on('response', onResponse)
  try {
    await navigate()
    if (onConsole || onResponse) await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => undefined)
  } finally {
    if (onConsole) page.off('console', onConsole)
    if (onResponse) page.off('response', onResponse)
  }
  return {
    ...(wantConsole && consoleMessages.length > 0 ? { console: consoleMessages } : {}),
    ...(wantNetwork && networkRequests.length > 0 ? { network: networkRequests } : {}),
  }
}

const STATE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', required: true },
    title: { type: 'string' },
    text: { type: 'string', required: true },
    screenshotPath: { type: 'string' },
  },
}

function renderState(_args, value) {
  const parts = []
  if (value.title) parts.push(`Title: ${value.title}`)
  parts.push(value.url)
  parts.push(value.text)
  if (value.screenshotPath) parts.push(`Screenshot: ${value.screenshotPath}`)
  return [{ type: 'text', text: parts.join('\n\n') }]
}

/**
 * Register the eight `browser_live_*` tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {import('./service.js').BrowserLiveService} browserLive - the pool.
 * @param {{ storageStateDir?: string }} [options] - login-state store location.
 */
export function registerLiveTools(ctx, browserLive, options = {}) {
  const statesDir = typeof options.storageStateDir === 'string' && options.storageStateDir.trim().length > 0
    ? path.resolve(options.storageStateDir.trim())
    : path.join(dshHome(), 'data', 'browser-live', 'states')

  /** One stored login state, sanitized to a flat file name. */
  const statePath = (name) => path.join(statesDir, `${name}.json`)

  const stateName = (value) => {
    const name = String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80)
    if (name === '') throw new Error('state name is required (or save from an open page to derive one from its host)')
    return name
  }

  const readState = (name) => {
    const file = statePath(name)
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(`cannot read browser state "${name}" (${file}): ${error.message}`)
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.cookies)) {
      throw new Error(`browser state "${name}" is not a Playwright storage-state file`)
    }
    return { file, parsed }
  }

  ctx.tools.register(defineLiveTool({
    name: 'browser_live_open',
    description: 'Open a URL in this session\'s live-view browser tab and return the rendered title, readable text, and a screenshot path. The tab stays visible in the user\'s browser-live panel. Optional bounded capture records console messages and failed/4xx/5xx requests, and waitFor settles pages whose content arrives after load. ' + COMPLIANCE_NOTICE,
    parameters: {
      url: { type: 'string', required: true, description: 'The HTTP(S) URL to open.' },
      tab: TAB_PARAM,
      waitUntil: WAIT_UNTIL_PARAM,
      waitMs: { type: 'number', description: 'Extra settle time in ms after load.' },
      waitFor: WAIT_FOR_PARAM,
      capture: { type: 'array', items: { type: 'string', enum: ['console', 'network'] }, description: 'Optional capture channels for this navigation.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string' },
          text: { type: 'string', required: true },
          screenshotPath: { type: 'string' },
          artifact: { type: 'object', additionalProperties: true, properties: { artifactId: { type: 'string' }, published: { type: 'boolean' }, reason: { type: 'string' } } },
          console: { type: 'array', items: { type: 'string' } },
          network: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { status: { type: 'number' }, url: { type: 'string' } } } },
        },
      },
      render: renderState,
    },
    timeoutMs: 90_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return withSession(browserLive, exec, async (context, entry, id) => {
        let url
        try {
          url = new URL(args.url).href
        } catch {
          throw new Error(`invalid URL: ${args.url}`)
        }
        const page = pickPage(context, args.tab) ?? await context.newPage()
        const captured = await captureChannels(page, args.capture, async () => {
          await page.goto(url, gotoOptions(args))
          await settle(page, args)
        })
        const screenshotPath = path.join(screenshotDir(entry.short), `open-${stamp()}.png`)
        const shot = await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 15_000 }).then(() => true).catch((error) => {
          warn('screenshot failed:', error.message)
          return false
        })
        const artifact = shot ? await publishScreenshot(browserLive, entry, id, screenshotPath) : { published: false, reason: 'screenshot-failed' }
        return {
          url: page.url(),
          title: await page.title().catch(() => undefined),
          text: (await page.evaluate(() => document.body?.innerText || '')).slice(0, 50_000),
          screenshotPath,
          artifact,
          ...captured,
        }
      }, { targetUrl: args.url })
    },
  }))

  ctx.tools.register(defineLiveTool({
    name: 'browser_live_script',
    description: 'Run a builtin read-only extraction script (article-clean, links, jsonld, forms) in this session\'s live-view browser tab and return its JSON result. Use browser_live_script_catalog to list scripts. ' + COMPLIANCE_NOTICE,
    parameters: {
      name: { type: 'string', required: true, description: 'Builtin script name.' },
      url: { type: 'string', description: 'Optional URL to navigate to before running; omitted runs against the current tab.' },
      tab: TAB_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          name: { type: 'string', required: true },
          sha256: { type: 'string', required: true },
          resultJson: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Script: ${value.name} (${value.sha256.slice(0, 12)})`,
          `URL: ${value.url}`,
          value.resultJson + (value.truncated ? '\n(result truncated)' : ''),
        ].join('\n'),
      }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const script = builtinScripts[args.name]
      if (!script) throw new Error(`unknown script ${args.name}; call browser_live_script_catalog for the list`)
      return withSession(browserLive, exec, async (context, entry) => {
        const page = pickPage(context, args.tab)
        if (!page) throw new Error('the session browser has no open tab; call browser_live_open first')
        if (args.url !== undefined) {
          let href
          try {
            href = new URL(args.url).href
          } catch {
            throw new Error(`invalid URL: ${args.url}`)
          }
          await page.goto(href, { waitUntil: 'load', timeout: 45_000 })
        }
        const raw = await page.evaluate(script.run)
        const json = JSON.stringify(raw)
        return {
          url: page.url(),
          name: args.name,
          sha256: scriptSha256(args.name),
          resultJson: json.slice(0, 100_000),
          truncated: json.length > 100_000,
        }
      }, { targetUrl: args.url })
    },
  }))

  ctx.tools.register(defineLiveTool({
    name: 'browser_live_script_catalog',
    description: 'List the builtin read-only browser_live_script scripts with their pinned SHA-256 hashes.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scripts: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: { name: { type: 'string' }, description: { type: 'string' }, sha256: { type: 'string' }, capabilities: { type: 'array', items: { type: 'string' } } } } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.scripts.map((s) => `${s.name} (${s.sha256.slice(0, 12)}): ${s.description}`).join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      return { scripts: scriptCatalog() }
    },
  }))

  ctx.tools.register(defineLiveTool({
    name: 'browser_live_recipe',
    description: `Replay a declared browser workflow (up to ${MAX_STEPS} steps of wait/click/fill/type/press/select/check/hover/scroll/extract/assert/screenshot) in this session's live-view browser tab. Steps run in order and stop at the first failure. Each step type takes its own fields: click/fill/type/select/check/hover require a CSS "selector"; click never locates by "text". ` + COMPLIANCE_NOTICE,
    parameters: {
      steps: {
        type: 'array',
        required: true,
        description: `At most ${MAX_STEPS} step objects. Fields per type: click/hover = selector; fill/type/select = selector + value; check = selector (+ checked); press = key (+ selector); wait = selector (visible) or waitMs; scroll = deltaY (+ selector to hover first); extract = mode (+ selector); assert = selector and/or text; screenshot = selector optional (element shot). "text" is a page-text matcher for wait/assert only.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', required: true, enum: ['wait', 'click', 'fill', 'type', 'press', 'select', 'check', 'hover', 'scroll', 'extract', 'assert', 'screenshot'] },
            condition: { type: 'string', enum: ['selector', 'text', 'load', 'time'], description: 'wait: "time" waits waitMs instead of a selector; assert: "text" waits for visibility before matching.' },
            selector: { type: 'string', description: 'CSS selector for the target element. Required by click/fill/type/select/check/hover; optional elsewhere. Clicking by visible text is not supported here.' },
            value: { type: 'string', description: 'fill/type/select only: the text to enter or the option to select.' },
            text: { type: 'string', description: 'wait/assert only: page-text matcher. Ignored by click/fill/type.' },
            key: { type: 'string', description: 'press only: the key to press (for example "Enter").' },
            attribute: { type: 'string', description: 'extract only: attribute name (with mode "attribute"), also used as the extract key.' },
            mode: { type: 'string', enum: ['text', 'html', 'links', 'attribute'], description: 'extract only: what to pull from the page or element (default "text").' },
            limit: { type: 'number', description: 'extract only: max items for links/attribute modes (default 200).' },
            timeoutMs: { type: 'number', description: 'Per-step timeout, capped at 60000.' },
            waitMs: { type: 'number', description: 'wait only: milliseconds to pause (default 1000).' },
            deltaY: { type: 'number', description: 'scroll only: vertical wheel delta in pixels (default 600).' },
            checked: { type: 'boolean', description: 'check only: false unchecks.' },
          },
        },
      },
      tab: TAB_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string' },
          steps: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: { step: { type: 'number' }, type: { type: 'string' } } } },
          extracts: { type: 'object', additionalProperties: true, properties: {} },
          screenshots: { type: 'array', items: { type: 'string' } },
          screenshotArtifacts: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { path: { type: 'string' }, artifactId: { type: 'string' }, published: { type: 'boolean' }, reason: { type: 'string' } } } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `URL: ${value.url}`,
          value.title ? `Title: ${value.title}` : undefined,
          `Steps: ${JSON.stringify(value.steps)}`,
          Object.keys(value.extracts).length > 0 ? `Extracts: ${JSON.stringify(value.extracts)}` : undefined,
          value.screenshots.length > 0 ? `Screenshots: ${value.screenshots.join(', ')}` : undefined,
        ].filter(Boolean).join('\n'),
      }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      // Contract check first: a malformed step must fail the call before the
      // session's browser is acquired, not half-way through a replay.
      validateRecipeSteps(args.steps)
      return withSession(browserLive, exec, async (context, entry, id) => {
        const page = pickPage(context, args.tab)
        if (!page) throw new Error('the session browser has no open tab; call browser_live_open first')
        const result = await runRecipe(page, args.steps, {
          screenshotDir: screenshotDir(entry.short),
          screenshotName: `recipe-${stamp()}`,
        })
        const screenshotArtifacts = []
        for (const file of result.screenshots) {
          const outcome = await publishScreenshot(browserLive, entry, id, file)
          screenshotArtifacts.push({ path: file, ...outcome })
        }
        return {
          url: page.url(),
          title: await page.title().catch(() => undefined),
          steps: result.steps,
          extracts: result.extracts,
          screenshots: result.screenshots,
          screenshotArtifacts,
        }
      })
    },
  }))

  ctx.tools.register(defineLiveTool({
    name: 'browser_live_status',
    description: 'Report this session\'s live-view browser facts without starting anything: container, CDP endpoint, viewer path, readiness, last use, the open tabs (only when the browser is already running), and where downloads land. A status call never allocates a slot, restores credentials, or refreshes the idle timer.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ready: { type: 'boolean', required: true },
          container: { type: 'string' },
          cdpEndpoint: { type: 'string' },
          viewerPath: { type: 'string' },
          slot: { type: 'number' },
          lastUsed: { type: 'string' },
          currentUrl: { type: 'string' },
          downloadsDir: { type: 'string', required: true },
          note: { type: 'string' },
          sharing: { type: 'object', additionalProperties: true, properties: { enabled: { type: 'boolean' }, revision: { type: 'string' }, epoch: { type: 'number' }, accountKey: { type: 'string' }, lastCollect: { type: 'object', additionalProperties: true, properties: { at: { type: 'number' }, published: { type: 'number' }, failed: { type: 'number' } } } } },
          tabs: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: { index: { type: 'number' }, url: { type: 'string' }, title: { type: 'string' }, blank: { type: 'boolean' } } } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.ready
            ? `ready=${value.ready} container=${value.container} cdp=${value.cdpEndpoint} viewer=${value.viewerPath} slot=${value.slot}`
            : `ready=false${value.container ? ` container=${value.container}` : ''}${value.note ? ` — ${value.note}` : ''}`,
          `downloads: ${value.downloadsDir}`,
          value.tabs.length > 0
            ? `tabs:\n${value.tabs.map((tab) => `  [${tab.index}] ${tab.blank ? '(blank)' : tab.url}${tab.title ? ` — ${tab.title}` : ''}`).join('\n')}`
            : 'tabs: none open',
        ].join('\n'),
      }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const id = sessionId(exec)
      // No ensure()/lease()/prepare(): status must not create a slot, import a
      // login, or bump `lastUsed` (which would keep an abandoned browser alive).
      const entry = browserLive.entryFor(id)
      const dir = downloadsDir(entry?.short ?? sessionShort(id))
      const sharing = browserLive.sharing
      const restore = sharing?.coordinator?.restoredFor?.(id) ?? null
      const lastCollect = sharing?.lastCollect?.get?.(id) ?? null
      const sharingInfo = sharing === null || sharing === undefined
        ? { enabled: false }
        : {
            enabled: true,
            ...(restore === null ? {} : { revision: restore.revision, epoch: restore.epoch, accountKey: restore.accountKey }),
            ...(lastCollect === null ? {} : { lastCollect }),
          }
      if (entry === null) {
        return {
          ready: false,
          downloadsDir: dir,
          tabs: [],
          sharing: sharingInfo,
          note: 'no browser slot for this session yet; the first browser operation creates one',
        }
      }
      let ready = false
      try {
        ready = (await browserLive.sessionStatus(id)).ready === true
      } catch (error) {
        warn('status: readiness probe failed:', error.message)
      }
      let tabs = []
      if (ready) {
        // The container is already running: reading its tab list adds no browser
        // process and no credential restore.
        let browser = null
        try {
          browser = await playwrightCore.chromium.connectOverCDP(`http://127.0.0.1:${entry.cdpPort}`, { noDefaults: true })
          const context = browser.contexts()[0]
          if (context) tabs = await describeTabs(context)
        } catch (error) {
          warn('status: cannot list tabs:', error.message)
        } finally {
          await browser?.close().catch(() => undefined)
        }
      }
      const current = tabs.find((tab) => !tab.blank)
      return {
        ready,
        container: entry.container,
        cdpEndpoint: `http://127.0.0.1:${entry.cdpPort}`,
        viewerPath: `${entry.publicPath}/`,
        slot: entry.slot,
        lastUsed: new Date(entry.lastUsed).toISOString(),
        ...(current !== undefined ? { currentUrl: current.url } : {}),
        downloadsDir: dir,
        tabs,
        sharing: sharingInfo,
        ...(ready ? {} : { note: 'the browser is not running; status did not start it' }),
      }
    },
  }))

  ctx.tools.register(defineLiveTool({
    name: 'browser_live_fetch',
    description: 'Fetch a URL by rendering it in a throwaway tab of this session\'s live-view browser and returning the readable text (JavaScript executed, cookies/geo from the session browser). Use for read-only page capture; it does not touch the session\'s main tab. ' + COMPLIANCE_NOTICE,
    parameters: {
      url: { type: 'string', required: true, description: 'The HTTP(S) URL to fetch.' },
      waitUntil: WAIT_UNTIL_PARAM,
      waitMs: { type: 'number', description: 'Extra settle time in ms after load.' },
      waitFor: WAIT_FOR_PARAM,
      screenshot: { type: 'boolean', description: 'Also save a screenshot and return its path.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string' },
          text: { type: 'string', required: true },
          screenshotPath: { type: 'string' },
          artifact: { type: 'object', additionalProperties: true, properties: { artifactId: { type: 'string' }, published: { type: 'boolean' }, reason: { type: 'string' } } },
        },
      },
      render: renderState,
    },
    timeoutMs: 90_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return withSession(browserLive, exec, async (context, entry, id) => {
        let href
        try {
          href = new URL(args.url).href
        } catch {
          throw new Error(`invalid URL: ${args.url}`)
        }
        const page = await context.newPage()
        try {
          await page.goto(href, gotoOptions(args))
          await settle(page, args)
          const value = {
            url: page.url(),
            title: await page.title().catch(() => undefined),
            text: (await page.evaluate(() => document.body?.innerText || '')).slice(0, 50_000),
          }
          if (args.screenshot === true) {
            const screenshotPath = path.join(screenshotDir(entry.short), `fetch-${stamp()}.png`)
            const ok = await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 15_000 }).then(() => true).catch((error) => {
              warn('screenshot failed:', error.message)
              return false
            })
            value.screenshotPath = screenshotPath
            value.artifact = ok ? await publishScreenshot(browserLive, entry, id, screenshotPath) : { published: false, reason: 'screenshot-failed' }
          }
          return value
        } finally {
          await page.close().catch(() => undefined)
        }
      }, { targetUrl: args.url })
    },
  }))


  ctx.tools.register(defineLiveTool({
    name: 'browser_live_artifact',
    description: 'List, inspect, or save a file this deployment published from a browser session (finished downloads, screenshots, PDFs) into the shared artifact library. Listing and inspecting never start a browser. Saving copies into the calling session\'s workspace and refuses to overwrite. ' + COMPLIANCE_NOTICE,
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'info', 'save'], description: 'list (default page), info for one artifact, save to copy it into this session\'s workspace.' },
      artifactId: { type: 'string', description: 'Artifact id from list/info (required for info and save).' },
      kind: { type: 'string', enum: ['download', 'screenshot', 'pdf', 'other'], description: 'Optional filter for list.' },
      limit: { type: 'number', description: 'Page size for list (default 50, max 200).' },
      cursor: { type: 'string', description: 'Opaque cursor returned by the previous list page.' },
      toPath: { type: 'string', description: 'Destination for save, relative to the session working directory; defaults to downloads/<original name>.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          items: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { artifactId: { type: 'string' }, kind: { type: 'string' }, fileName: { type: 'string' }, size: { type: 'number' }, createdAt: { type: 'string' } } } },
          nextCursor: { type: 'string' },
          artifact: { type: 'object', additionalProperties: true, properties: { artifactId: { type: 'string' }, kind: { type: 'string' }, fileName: { type: 'string' }, size: { type: 'number' }, sha256: { type: 'string' }, createdAt: { type: 'string' }, sourceSessionId: { type: 'string' } } },
          savedPath: { type: 'string' },
          bytes: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.action === 'list' ? `artifacts: ${value.items?.length ?? 0}${value.nextCursor ? ' (more available)' : ''}` : undefined,
          ...(value.items ?? []).map((item) => `  ${item.artifactId}  ${item.kind}  ${item.fileName}  ${item.size}B  ${item.createdAt ?? ''}`),
          value.artifact ? `${value.artifact.artifactId}  ${value.artifact.kind}  ${value.artifact.fileName}  ${value.artifact.size}B  sha256=${value.artifact.sha256}` : undefined,
          value.savedPath ? `saved ${value.bytes}B to ${value.savedPath}` : undefined,
        ].filter(Boolean).join('\n'),
      }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const sharing = browserLive.sharing
      if (sharing === undefined || sharing === null) {
        throw new Error('cross-session sharing is disabled; no shared artifacts are available')
      }
      const { scopeId } = sharing.scope.scopeFor(exec?.agent)
      if (args.action === 'list') {
        const page = await sharing.store.list({
          scopeId,
          kind: typeof args.kind === 'string' ? args.kind : null,
          limit: Number.isFinite(args.limit) ? Math.min(Math.max(Math.floor(args.limit), 1), 200) : 50,
          cursor: typeof args.cursor === 'string' ? args.cursor : null,
        })
        return { action: 'list', items: page.items, nextCursor: page.nextCursor ?? undefined }
      }
      const artifactId = typeof args.artifactId === 'string' ? args.artifactId.trim() : ''
      if (artifactId === '') throw new Error(`${args.action} requires an artifactId; call browser_live_artifact with action "list" first`)
      const record = await sharing.store.info({ scopeId, artifactId })
      if (record === null) throw new Error(`no artifact ${artifactId} in this scope`)
      if (args.action === 'info') {
        return {
          action: 'info',
          artifact: {
            artifactId: record.artifactId,
            kind: record.kind,
            fileName: record.fileName,
            size: record.size,
            sha256: record.sha256,
            createdAt: new Date(record.createdAt).toISOString(),
            sourceSessionId: record.sourceSessionId,
          },
        }
      }
      const cwd = exec?.agent?.session?.header?.cwd
      if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('save requires a session working directory')
      const target = typeof args.toPath === 'string' && args.toPath.length > 0
        ? path.resolve(cwd, args.toPath)
        : path.resolve(cwd, 'downloads', safeExportName(record.displayName ?? record.fileName ?? artifactId))
      const written = await exportArtifact({
        store: sharing.store,
        fileSystem: ctx.get('fs'),
        ctx,
        exec,
        scopeId,
        artifactId,
        targetPath: target,
        cwd,
      })
      log('exported artifact', artifactId, 'to', written.path)
      return { action: 'save', artifact: { artifactId, kind: record.kind, fileName: record.fileName, size: record.size, sha256: record.sha256, createdAt: new Date(record.createdAt).toISOString() }, savedPath: written.path, bytes: written.bytes }
    },
  }))

  ctx.tools.register(defineLiveTool({
    name: 'browser_live_download',
    description: `List (default) or save the files this session's live-view browser has downloaded. Chromium writes downloads to ${CONTAINER_DOWNLOADS} inside its container, which is bound to a host directory, so a download is reachable at all — "list" reports that directory and its files, "save" copies one file into the session workspace. Files appear only after the download finishes.`,
    parameters: {
      action: { type: 'string', enum: ['list', 'save'], description: 'list (default) reports the directory and its files; save copies one file out.' },
      name: { type: 'string', description: 'File name exactly as listed (required for save).' },
      toPath: { type: 'string', description: 'Destination path for save; default is <session cwd>/downloads/<name>.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dir: { type: 'string', required: true },
          mounted: { type: 'boolean', required: true },
          collected: { type: 'boolean', required: true },
          note: { type: 'string', required: true },
          files: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: { name: { type: 'string' }, size: { type: 'number' }, modified: { type: 'string' }, artifactId: { type: 'string' } } } },
          savedPath: { type: 'string' },
          artifactId: { type: 'string' },
          size: { type: 'number' },
          collection: { type: 'object', additionalProperties: true, properties: { at: { type: 'number' }, published: { type: 'number' }, skipped: { type: 'number' }, failed: { type: 'number' } } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `directory: ${value.dir}`,
          value.note,
          value.files.length === 0
            ? 'no downloaded files yet'
            : value.files.map((file) => `  ${file.name}  ${file.size} bytes  ${file.modified}`).join('\n'),
          value.savedPath ? `saved: ${value.savedPath} (${value.size} bytes)` : undefined,
        ].filter(Boolean).join('\n'),
      }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const id = sessionId(exec)
      const listing = await browserLive.listDownloads(id)
      // Say which of the three situations the caller is in: the container writes
      // into this directory (mounted), a container exists without the mount (files
      // collected on demand), or there is no container for this session yet.
      const note = listing.mounted
        ? 'the container writes downloads straight into this directory'
        : listing.collected
          ? 'this container predates the download mount; its files were collected with docker cp'
          : browserLive.entryFor(id) === null
            ? 'this session has no browser container yet; open a page first'
            : 'this container predates the download mount; downloads will appear here once it is recreated'
      const entry = browserLive.entryFor(id)
      const published = readArtifactIds(browserLive, entry, 'downloads')
      const collected = browserLive.sharing?.lastCollect?.get(id)
      const result = {
        ...listing,
        files: listing.files.map((file) => (published[file.name] === undefined ? file : { ...file, artifactId: published[file.name] })),
        note,
        ...(collected === undefined ? {} : { collection: { at: collected.at, published: collected.published, skipped: collected.skipped, failed: collected.failed } }),
      }
      if (args.action !== 'save') return result
      const name = typeof args.name === 'string' ? args.name : ''
      if (name === '' || path.basename(name) !== name) {
        throw new Error('name must be a plain file name from the listing (no path separators)')
      }
      const source = path.join(listing.dir, name)
      let stat
      try {
        stat = fs.statSync(source)
      } catch {
        throw new Error(`no downloaded file named "${name}"; call browser_live_download with action "list" first`)
      }
      const cwd = exec?.agent?.session?.header?.cwd
      if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('save requires a session working directory')
      const target = typeof args.toPath === 'string' && args.toPath.length > 0
        ? path.resolve(cwd, args.toPath)
        : path.resolve(cwd, 'downloads', name)
      // Same authorization seam as the shared-library export: resolve, contain,
      // write-intent, sandbox policy, O_EXCL. No bare copyFileSync.
      const written = await copyFileIntoWorkspace({
        sourcePath: source,
        targetPath: target,
        cwd,
        fileSystem: ctx.get('fs'),
        ctx,
        exec,
      })
      log('saved download', name, 'to', written.path)
      return {
        ...result,
        savedPath: written.path,
        size: written.bytes,
        ...(published[name] === undefined ? {} : { artifactId: published[name] }),
      }
    },
  }))

  ctx.tools.register(defineLiveTool({
    name: 'browser_live_state',
    description: 'Save, restore, list, or delete this session\'s browser login state (cookies plus per-origin localStorage) in a store shared by every session, so a later session can pick up an authenticated browser instead of logging in again. The file is a Playwright storage-state document, so it also works with the MCP storage tools. "load" always restores cookies; localStorage is applied only for origins that are open in this session.',
    parameters: {
      action: { type: 'string', required: true, enum: ['save', 'load', 'list', 'forget'], description: 'save captures the current browser; load restores a stored state; list/forget manage the store.' },
      name: { type: 'string', description: 'State name; default for save is the current page\'s host. Required for load and forget.' },
      expectedRevision: { type: 'string', description: 'Optimistic guard for save against the shared store: the revision the capture was based on (omit for the first publish).' },
      expectedEpoch: { type: 'number', description: 'Explicit acknowledgement of the current revocation epoch when re-publishing an account that was revoked on purpose.' },
      tab: TAB_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          name: { type: 'string' },
          path: { type: 'string', required: true },
          savedAt: { type: 'string' },
          url: { type: 'string' },
          cookies: { type: 'number', required: true },
          origins: { type: 'number', required: true },
          appliedOrigins: { type: 'array', items: { type: 'string' } },
          skippedOrigins: { type: 'array', items: { type: 'string' } },
          droppedCookieDomains: { type: 'array', items: { type: 'string' } },
          siteKey: { type: 'string' },
          accountKey: { type: 'string' },
          revision: { type: 'string' },
          epoch: { type: 'number' },
          revisions: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { siteKey: { type: 'string' }, epoch: { type: 'number' }, revision: { type: 'string' }, cleared: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { sessionId: { type: 'string' }, cleared: { type: 'boolean' }, reason: { type: 'string' } } } } } } },
          states: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { name: { type: 'string' }, siteKey: { type: 'string' }, accountKey: { type: 'string' }, savedAt: { type: 'string' }, url: { type: 'string' }, cookies: { type: 'number' }, origins: { type: 'number' }, revision: { type: 'string' }, epoch: { type: 'number' }, revoked: { type: 'boolean' } } } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `${value.action}${value.name ? ' ' + value.name : ''} → ${value.path}`,
          value.url ? `captured from ${value.url} at ${value.savedAt}` : undefined,
          `cookies: ${value.cookies}, origins: ${value.origins}`,
          value.revision ? `revision: ${value.revision} (epoch ${value.epoch ?? 0})` : undefined,
          value.revisions?.length ? value.revisions.map((item) => `  revoked ${item.siteKey}: epoch ${item.epoch}` + (item.cleared?.length ? `; live instances: ${item.cleared.map((entry) => `${entry.sessionId}=${entry.cleared ? 'cleared' : entry.reason ?? 'not-cleared'}`).join(', ')}` : '')).join('\n') : undefined,
          value.droppedCookieDomains?.length ? `cookie domains not in the site policy (not stored): ${value.droppedCookieDomains.join(', ')}` : undefined,
          value.appliedOrigins?.length ? `localStorage applied: ${value.appliedOrigins.join(', ')}` : undefined,
          value.skippedOrigins?.length ? `localStorage skipped (origin not open): ${value.skippedOrigins.join(', ')}` : undefined,
          value.states?.length ? value.states.map((state) => `  ${state.name}  ${state.savedAt ?? '?'}  cookies=${state.cookies ?? '?'} origins=${state.origins ?? '?'}`).join('\n') : undefined,
        ].filter(Boolean).join('\n'),
      }],
    },
    timeoutMs: 90_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      // With cross-session sharing on, the login store is the versioned one:
      // save publishes a revision, load refreshes this browser from it, list is
      // metadata only, forget revokes the account.
      if (browserLive.sharing !== null && browserLive.sharing !== undefined) {
        return executeSharedState({ sharing: browserLive.sharing, browserLive, args, exec })
      }
      if (args.action === 'list') {
        let names = []
        try {
          names = fs.readdirSync(statesDir).filter((file) => file.endsWith('.json')).sort()
        } catch {
          // store not created yet: an empty list is the honest answer
        }
        const states = names.map((file) => {
          try {
            const parsed = JSON.parse(fs.readFileSync(path.join(statesDir, file), 'utf8'))
            return {
              name: file.replace(/\.json$/, ''),
              savedAt: parsed.savedAt,
              url: parsed.url,
              cookies: Array.isArray(parsed.cookies) ? parsed.cookies.length : 0,
              origins: Array.isArray(parsed.origins) ? parsed.origins.length : 0,
            }
          } catch {
            return { name: file.replace(/\.json$/, '') }
          }
        })
        return { action: 'list', path: statesDir, cookies: 0, origins: 0, states }
      }

      if (args.action === 'forget') {
        const name = stateName(args.name)
        const file = statePath(name)
        if (!fs.existsSync(file)) throw new Error(`no stored browser state named "${name}"`)
        fs.rmSync(file)
        log('forgot browser state', name)
        return { action: 'forget', name, path: file, cookies: 0, origins: 0 }
      }

      if (args.action === 'load') {
        const name = stateName(args.name)
        const { file, parsed } = readState(name)
        const result = await withSession(browserLive, exec, async (context) => {
          await context.addCookies(parsed.cookies)
          const applied = []
          const skipped = []
          const pages = context.pages()
          for (const origin of Array.isArray(parsed.origins) ? parsed.origins : []) {
            const target = pages.find((page) => {
              try {
                return new URL(page.url()).origin === origin?.origin
              } catch {
                return false
              }
            })
            if (target === undefined) {
              skipped.push(String(origin?.origin ?? '?'))
              continue
            }
            await target.evaluate((items) => {
              for (const item of items) localStorage.setItem(item.name, item.value)
            }, Array.isArray(origin?.localStorage) ? origin.localStorage : [])
            applied.push(origin.origin)
          }
          return { applied, skipped }
        })
        return {
          action: 'load',
          name,
          path: file,
          savedAt: parsed.savedAt,
          url: parsed.url,
          cookies: parsed.cookies.length,
          origins: Array.isArray(parsed.origins) ? parsed.origins.length : 0,
          appliedOrigins: result.applied,
          skippedOrigins: result.skipped,
        }
      }

      // save
      const captured = await withSession(browserLive, exec, async (context) => {
        const page = pickPage(context, args.tab)
        if (!page) throw new Error('the session browser has no open tab; call browser_live_open first')
        const cookies = await context.cookies()
        const origins = []
        const seen = new Set()
        for (const open of context.pages()) {
          if (BLANK_URL.test(open.url())) continue
          let origin
          try {
            origin = new URL(open.url()).origin
          } catch {
            continue
          }
          if (seen.has(origin)) continue
          seen.add(origin)
          const items = await open.evaluate(() => Object.fromEntries(Object.entries(localStorage)))
          origins.push({ origin, localStorage: Object.entries(items).map(([name, value]) => ({ name, value })) })
        }
        return { url: page.url(), cookies, origins }
      })
      const fallbackName = (() => {
        try {
          return new URL(captured.url).host
        } catch {
          return ''
        }
      })()
      const name = stateName(args.name ?? fallbackName)
      const savedAt = new Date().toISOString()
      const file = statePath(name)
      fs.mkdirSync(statesDir, { recursive: true })
      fs.writeFileSync(file, `${JSON.stringify({ savedAt, url: captured.url, cookies: captured.cookies, origins: captured.origins }, null, 2)}\n`, { mode: 0o600 })
      log('saved browser state', name, '(' + captured.cookies.length + ' cookies,', captured.origins.length + ' origins)')
      return {
        action: 'save',
        name,
        path: file,
        savedAt,
        url: captured.url,
        cookies: captured.cookies.length,
        origins: captured.origins.length,
      }
    },
  }))

  log('registered browser_live_* tools (open/script/script_catalog/recipe/status/fetch/download/state)')
}
