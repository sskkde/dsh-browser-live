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
import { dshHome } from './service.js'
import { log, warn } from './log.js'
import { builtinScripts, scriptCatalog, scriptSha256 } from './scripts.js'
import { runRecipe, MAX_STEPS } from './recipes.js'

const COMPLIANCE_NOTICE = 'Runs inside the session live-view browser; use it according to the target site rules.'

const BLANK_URL = /^(about:blank|chrome:\/\/|edge:\/\/|data:)/i

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
 * Register the five `browser_live_*` tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {import('./service.js').BrowserLiveService} browserLive - the pool.
 */
export function registerLiveTools(ctx, browserLive) {
  ctx.tools.register(defineTool({
    name: 'browser_live_open',
    description: 'Open a URL in this session\'s live-view browser tab and return the rendered title, readable text, and a screenshot path. The tab stays visible in the user\'s browser-live panel. Optional bounded capture records console messages and failed/4xx/5xx requests. ' + COMPLIANCE_NOTICE,
    parameters: {
      url: { type: 'string', required: true, description: 'The HTTP(S) URL to open.' },
      waitMs: { type: 'number', description: 'Extra settle time in ms after load.' },
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
        const page = pickMainPage(context) ?? await context.newPage()
        const captured = await captureChannels(page, args.capture, async () => {
          await page.goto(url, { waitUntil: 'load', timeout: 45_000 })
          if (Number.isFinite(args.waitMs)) await page.waitForTimeout(Math.min(args.waitMs, 15_000))
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
        const page = pickMainPage(context)
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
        const page = pickMainPage(context)
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
    description: 'Report this session\'s live-view browser facts: container, CDP endpoint, viewer path, readiness, and last use.',
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
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `ready=${value.ready} container=${value.container} cdp=${value.cdpEndpoint} viewer=${value.viewerPath} slot=${value.slot}`,
      }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const id = sessionId(exec)
      const entry = await browserLive.ensure(id)
      return {
        ready: true,
        container: entry.container,
        cdpEndpoint: `http://127.0.0.1:${entry.cdpPort}`,
        viewerPath: `${entry.publicPath}/`,
        slot: entry.slot,
        lastUsed: new Date(entry.lastUsed).toISOString(),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_live_fetch',
    description: 'Fetch a URL by rendering it in a throwaway tab of this session\'s live-view browser and returning the readable text (JavaScript executed, cookies/geo from the session browser). Use for read-only page capture; it does not touch the session\'s main tab. ' + COMPLIANCE_NOTICE,
    parameters: {
      url: { type: 'string', required: true, description: 'The HTTP(S) URL to fetch.' },
      waitMs: { type: 'number', description: 'Extra settle time in ms after load.' },
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
          await page.goto(href, { waitUntil: 'load', timeout: 45_000 })
          if (Number.isFinite(args.waitMs)) await page.waitForTimeout(Math.min(args.waitMs, 15_000))
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

  log('registered browser_live_* tools (open/script/script_catalog/recipe/status/fetch)')
}
