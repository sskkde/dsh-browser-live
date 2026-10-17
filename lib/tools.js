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
import { CONTAINER_DOWNLOADS, dshHome, downloadsDir } from './service.js'
import { log, warn } from './log.js'
import { builtinScripts, scriptCatalog, scriptSha256 } from './scripts.js'
import { runRecipe, MAX_STEPS } from './recipes.js'

const COMPLIANCE_NOTICE = 'Runs inside the session live-view browser; use it according to the target site rules.'

const BLANK_URL = /^(about:blank|chrome:\/\/|edge:\/\/|data:)/i

const WAIT_UNTIL = new Set(['load', 'domcontentloaded', 'networkidle', 'commit'])

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

/** Every open tab as `{index, url, title, blank}` for `browser_live_status`. */
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

async function withSession(browserLive, exec, run) {
  const id = sessionId(exec)
  const entry = await browserLive.ensure(id)
  const browser = await playwrightCore.chromium.connectOverCDP(`http://127.0.0.1:${entry.cdpPort}`)
  try {
    const context = browser.contexts()[0]
    if (!context) throw new Error('session browser has no default context yet; open a page first')
    return await run(context, entry, id)
  } finally {
    // Detaches this client only: the Neko browser, its tabs, and the live view
    // are untouched (contexts/pages created here are cleaned up by close()).
    await browser.close().catch(() => undefined)
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

  ctx.tools.register(defineTool({
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
        await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 15_000 }).catch((error) => warn('screenshot failed:', error.message))
        return {
          url: page.url(),
          title: await page.title().catch(() => undefined),
          text: (await page.evaluate(() => document.body?.innerText || '')).slice(0, 50_000),
          screenshotPath,
          ...captured,
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
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
      })
    },
  }))

  ctx.tools.register(defineTool({
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

  ctx.tools.register(defineTool({
    name: 'browser_live_recipe',
    description: `Replay a declared browser workflow (up to ${MAX_STEPS} steps of wait/click/fill/type/press/select/check/hover/scroll/extract/assert/screenshot) in this session's live-view browser tab. Steps run in order and stop at the first failure. ` + COMPLIANCE_NOTICE,
    parameters: {
      steps: {
        type: 'array',
        required: true,
        description: `At most ${MAX_STEPS} step objects.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', required: true, enum: ['wait', 'click', 'fill', 'type', 'press', 'select', 'check', 'hover', 'scroll', 'extract', 'assert', 'screenshot'] },
            condition: { type: 'string', enum: ['selector', 'text', 'load', 'time'] },
            selector: { type: 'string' },
            value: { type: 'string' },
            text: { type: 'string' },
            key: { type: 'string' },
            attribute: { type: 'string' },
            mode: { type: 'string', enum: ['text', 'html', 'links', 'attribute'] },
            limit: { type: 'number' },
            timeoutMs: { type: 'number' },
            waitMs: { type: 'number' },
            deltaY: { type: 'number' },
            checked: { type: 'boolean' },
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
      return withSession(browserLive, exec, async (context, entry, id) => {
        const page = pickPage(context, args.tab)
        if (!page) throw new Error('the session browser has no open tab; call browser_live_open first')
        const result = await runRecipe(page, args.steps, {
          screenshotDir: screenshotDir(entry.short),
          screenshotName: `recipe-${stamp()}`,
        })
        return {
          url: page.url(),
          title: await page.title().catch(() => undefined),
          steps: result.steps,
          extracts: result.extracts,
          screenshots: result.screenshots,
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_live_status',
    description: 'Report this session\'s live-view browser facts: container, CDP endpoint, viewer path, readiness, last use, the open tabs, and where downloads land.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ready: { type: 'boolean', required: true },
          container: { type: 'string', required: true },
          cdpEndpoint: { type: 'string', required: true },
          viewerPath: { type: 'string', required: true },
          slot: { type: 'number', required: true },
          lastUsed: { type: 'string', required: true },
          currentUrl: { type: 'string' },
          downloadsDir: { type: 'string', required: true },
          tabs: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: { index: { type: 'number' }, url: { type: 'string' }, title: { type: 'string' }, blank: { type: 'boolean' } } } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `ready=${value.ready} container=${value.container} cdp=${value.cdpEndpoint} viewer=${value.viewerPath} slot=${value.slot}`,
          `downloads: ${value.downloadsDir}`,
          value.tabs.length > 0
            ? `tabs:\n${value.tabs.map((tab) => `  [${tab.index}] ${tab.blank ? '(blank)' : tab.url}${tab.title ? ` — ${tab.title}` : ''}`).join('\n')}`
            : 'tabs: none open',
        ].join('\n'),
      }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const id = sessionId(exec)
      const entry = await browserLive.ensure(id)
      // A tab list is worth one extra attach; without a browser yet there is
      // nothing to list, so an attach failure must not fail the status report.
      let tabs = []
      try {
        tabs = await withSession(browserLive, exec, async (context) => describeTabs(context))
      } catch (error) {
        warn('status: cannot list tabs:', error.message)
      }
      return {
        ready: true,
        container: entry.container,
        cdpEndpoint: `http://127.0.0.1:${entry.cdpPort}`,
        viewerPath: `${entry.publicPath}/`,
        slot: entry.slot,
        lastUsed: new Date(entry.lastUsed).toISOString(),
        ...(tabs.find((tab) => !tab.blank) !== undefined ? { currentUrl: tabs.find((tab) => !tab.blank).url } : {}),
        downloadsDir: downloadsDir(entry.short),
        tabs,
      }
    },
  }))

  ctx.tools.register(defineTool({
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
            await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 15_000 }).catch((error) => warn('screenshot failed:', error.message))
            value.screenshotPath = screenshotPath
          }
          return value
        } finally {
          await page.close().catch(() => undefined)
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
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
          files: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: { name: { type: 'string' }, size: { type: 'number' }, modified: { type: 'string' } } } },
          savedPath: { type: 'string' },
          size: { type: 'number' },
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
      const result = { ...listing, note }
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
      const target = typeof args.toPath === 'string' && args.toPath.length > 0
        ? path.resolve(args.toPath)
        : path.resolve(cwd ?? listing.dir, 'downloads', name)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target)
      log('saved download', name, 'to', target)
      return { ...result, savedPath: target, size: stat.size }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_live_state',
    description: 'Save, restore, list, or delete this session\'s browser login state (cookies plus per-origin localStorage) in a store shared by every session, so a later session can pick up an authenticated browser instead of logging in again. The file is a Playwright storage-state document, so it also works with the MCP storage tools. "load" always restores cookies; localStorage is applied only for origins that are open in this session.',
    parameters: {
      action: { type: 'string', required: true, enum: ['save', 'load', 'list', 'forget'], description: 'save captures the current browser; load restores a stored state; list/forget manage the store.' },
      name: { type: 'string', description: 'State name; default for save is the current page\'s host. Required for load and forget.' },
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
          states: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { name: { type: 'string' }, savedAt: { type: 'string' }, url: { type: 'string' }, cookies: { type: 'number' }, origins: { type: 'number' } } } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `${value.action}${value.name ? ' ' + value.name : ''} → ${value.path}`,
          value.url ? `captured from ${value.url} at ${value.savedAt}` : undefined,
          `cookies: ${value.cookies}, origins: ${value.origins}`,
          value.appliedOrigins?.length ? `localStorage applied: ${value.appliedOrigins.join(', ')}` : undefined,
          value.skippedOrigins?.length ? `localStorage skipped (origin not open): ${value.skippedOrigins.join(', ')}` : undefined,
          value.states?.length ? value.states.map((state) => `  ${state.name}  ${state.savedAt ?? '?'}  cookies=${state.cookies ?? '?'} origins=${state.origins ?? '?'}`).join('\n') : undefined,
        ].filter(Boolean).join('\n'),
      }],
    },
    timeoutMs: 90_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
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
