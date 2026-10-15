/**
 * dsh-browser-live — plugin entry (server half).
 *
 * Composes four pieces behind one bundle row:
 *
 *  1. `browserLive` service (lib/service.js) — the per-session Neko container
 *     pool: bounded slots, per-session CDP endpoints and viewer paths, lazy
 *     allocation, LRU eviction, idle-TTL sweeping, persisted session map, host
 *     adoption on restart.
 *  2. Host HTTP routes on the DSH web server — `/browser-live/session`
 *     (per-session viewer resolution for the sidebar panel) and
 *     `/browser-live/status` (diagnostics).
 *  3. The per-session browser provider (lib/provider.js) — one Playwright MCP
 *     attachment per live session against that session's own container,
 *     replacing the official exclusive attach row (disabled in the bundle
 *     patch).
 *  4. The `browser_live_*` host tools (lib/tools.js) — one-shot open / script /
 *     recipe / status / fetch over the session's own browser.
 *
 * Everything is best-effort at boot: provisioning runs on a delay, never
 * throws into the harness, and logs with the `[browser-live]` prefix.
 */

import Schema from '@deepseek-ai/schemastery'
import { BrowserLiveService } from './service.js'
import { applyProvider } from './provider.js'
import { registerLiveTools } from './tools.js'
import { log, warn } from './log.js'

/** Cordis identity for the provisioning + provider plugin. */
export const name = 'browser-live'

/** Services owned by the browser-use stack this plugin composes with. */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt']

/** Pool size, provider tool-call budget, idle TTL, and host provisioning switch. */
export const Config = Schema.object({
  maxSessions: Schema.number().min(1).max(8).default(3).description('Maximum concurrent live browser sessions (LRU-evicted beyond this).'),
  toolCallTimeoutMs: Schema.number().min(5_000).default(60_000).description('Cooperative budget for each provider browser tool call.'),
  idleTtlHours: Schema.number().min(0).default(4).description('Release a session\'s browser slot after this many idle hours; 0 disables the idle sweeper.'),
  provision: Schema.boolean().default(true).description('Run host provisioning (container adoption, nginx blocks) at activation.'),
})

/**
 * Activate the service, routes, provider, and tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - root plugin context.
 * @param {{ maxSessions?: number, toolCallTimeoutMs?: number, idleTtlHours?: number, provision?: boolean }} config
 */
export function apply(ctx, config = {}) {
  const browserLive = new BrowserLiveService(ctx, {
    maxSessions: config.maxSessions,
    idleTtlMs: (config.idleTtlHours ?? 4) * 3_600_000,
  })
  log('service up (maxSessions=' + browserLive.maxSessions + ', idle ttl ' + Math.round(browserLive.idleTtlMs / 3_600_000) + 'h)')

  if (browserLive.idleTtlMs > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        void browserLive.sweepIdle().catch((error) => warn('idle sweep failed:', error.message))
      }, browserLive.sweepIntervalMs)
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'browser-live: idle sweeper')
    log('idle sweeper armed (every ' + Math.round(browserLive.sweepIntervalMs / 60_000) + ' min)')
  }

  if (config.provision !== false) {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        // Delayed so the web app's webServer service exists when the routes
        // register; adoption runs on the same tick.
        registerRoutes(ctx, browserLive)
        void browserLive.adoptExisting().catch((error) => warn('host adoption failed:', error.message))
      }, 5_000)
      return () => clearTimeout(timer)
    }, 'browser-live: host adoption')
  } else {
    registerRoutes(ctx, browserLive)
  }

  try {
    applyProvider(ctx, browserLive, { toolCallTimeoutMs: config.toolCallTimeoutMs })
  } catch (error) {
    warn('per-session browser provider not mounted:', error.message)
  }

  try {
    registerLiveTools(ctx, browserLive)
  } catch (error) {
    warn('browser_live_* tools not registered:', error.message)
  }
}

/**
 * Same-origin JSON routes for the client half. The web server is optional
 * (soft-resolved): without it the panel falls back to the legacy viewer path.
 */
function registerRoutes(ctx, browserLive) {
  ctx.effect(() => {
    const webServer = ctx.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') {
      warn('webServer service unavailable; /browser-live routes not registered')
      return
    }
    const disposeSession = webServer.register({
      kind: 'exact',
      path: '/browser-live/session',
      async handler(req, res) {
        try {
          const session = new URL(req.url, 'http://localhost').searchParams.get('session')
          const body = session
            ? await browserLive.sessionStatus(session)
            : { ready: false, viewerPath: null }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        } catch (error) {
          warn('session route failed:', error.message)
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ready: false, viewerPath: null, error: 'session lookup failed' }))
        }
      },
    })
    const disposeStatus = webServer.register({
      kind: 'exact',
      path: '/browser-live/status',
      handler(_req, res) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(browserLive.status()))
      },
    })
    log('routes registered: /browser-live/session, /browser-live/status')
    return () => {
      disposeSession()
      disposeStatus()
    }
  }, 'browser-live: routes')
}
