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

import fs from 'node:fs'
import Schema from '@deepseek-ai/schemastery'
import { BrowserLiveService, dshHome, sessionShort } from './service.js'
import { applyProvider } from './provider.js'
import { registerLiveTools } from './tools.js'
import { installSharingGate } from './sharing/gate.js'
import { createScopeResolver } from './sharing/scope.js'
import { AuditLog } from './sharing/audit.js'
import { AuthStore } from './sharing/auth-store.js'
import { ArtifactStore } from './sharing/artifact-store.js'
import { collectSessionArtifacts, publishFileInDir } from './sharing/collector.js'
import { createCoordinator, createOriginBindings } from './sharing/coordinator.js'
import path from 'node:path'
import { log, warn } from './log.js'

/** Cordis identity for the provisioning + provider plugin. */
export const name = 'browser-live'

/** Services owned by the browser-use stack this plugin composes with. */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt']

/** Pool size, provider tool-call budget, idle TTL, host provisioning, and the P0/P1 knobs. */
export const Config = Schema.object({
  maxSessions: Schema.number().min(1).max(8).default(3).description('Maximum concurrent live browser sessions (LRU-evicted beyond this).'),
  toolCallTimeoutMs: Schema.number().min(5_000).default(60_000).description('Cooperative budget for each provider browser tool call.'),
  idleTtlHours: Schema.number().min(0).default(4).description('Release a session\'s browser slot after this many idle hours; 0 disables the idle sweeper.'),
  provision: Schema.boolean().default(true).description('Run host provisioning (container adoption, nginx blocks) at activation.'),
  mcpCaps: Schema.array(Schema.string()).default(['storage', 'network', 'pdf', 'testing']).description('Extra Playwright MCP capability groups (storage, network, pdf, testing, vision, devtools). Each one adds tools to every session\'s schema; use [] for the core set only. Ignored when toolGateway is on.'),
  toolGateway: Schema.boolean().default(false).description('Publish a small tool surface (10 resident tools + 3 browser_gateway_* tools) and disclose the other capability groups on demand; the Playwright MCP server is then always started with every group, so enabling one never restarts it.'),
  egressProxy: Schema.string().default('').description('Proxy every session browser sends through, e.g. http://10.0.0.1:3128 or socks5://10.0.0.1:1080. Empty means direct. Takes effect when a container is (re)created.'),
  storageStateDir: Schema.string().default('').description('Directory holding shared login states for browser_live_state; empty uses <DSH_HOME>/data/browser-live/states.'),
  sharing: Schema.object({
    enabled: Schema.boolean().default(false).description('Uniform access gate for cross-session sharing. Off by default: storage exists, nothing is shared or restored until this is on.'),
    scopeId: Schema.string().default('trusted-group').description('Name of the single trusted scope this deployment defines.'),
    allowCredentials: Schema.boolean().default(true).description('Whether scope members may read or write stored login state (cookies/storage), not just browse.'),
    members: Schema.array(Schema.string()).default([]).description('Explicit session ids in the trusted scope; empty means every live session and subagent (the current operator decision).'),
    quotaBytes: Schema.number().description('Hard cumulative cap for the shared artifact store. Unset (default) keeps the documented "never auto-delete, warn only" policy; when set, publishing stops at the cap and the source file is kept.'),
    artifactScanIntervalMs: Schema.number().min(0).default(60_000).description('How often to scan session output directories for late-finishing downloads/screenshots; 0 disables the timer (per-call collection still runs).'),
    bindings: Schema.array(Schema.object({
      origin: Schema.string().required().description('Exact origin the binding applies to, e.g. https://example.test.'),
      accountKey: Schema.string().required().description('Account alias inside that origin.'),
      siteKey: Schema.string().description('Site policy key; defaults to the origin.'),
      cookieDomains: Schema.array(Schema.string()).description('Extra cookie domains this account owns (parent-domain cookies, SSO cookie hosts). Without it only the exact origin host is stored/restored.'),
      ssoOrigins: Schema.array(Schema.string()).description('Extra origins whose localStorage belongs to this login.'),
    })).default([]).description('Origin → account bindings this deployment may restore. Empty means nothing is restored even when sharing is enabled.'),
  }).description('Cross-session login/artifact sharing. Storage and policy exist in P1; the gate only runs when enabled.'),
})

/**
 * Activate the service, routes, provider, and tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - root plugin context.
 * @param {object} config - resolved plugin config.
 * @param {{ applyProvider?: Function, registerLiveTools?: Function, createSharingRuntime?: Function }} [deps] - test seams (production passes none).
 */
export function apply(ctx, config = {}, deps = {}) {
  const providerFactory = deps.applyProvider ?? applyProvider
  const toolsFactory = deps.registerLiveTools ?? registerLiveTools
  const runtimeFactory = deps.createSharingRuntime ?? createSharingRuntime
  let sharingRuntime = null
  const browserLive = new BrowserLiveService(ctx, {
    maxSessions: config.maxSessions,
    idleTtlMs: (config.idleTtlHours ?? 4) * 3_600_000,
    egressProxy: config.egressProxy,
  })
  log('service up (maxSessions=' + browserLive.maxSessions + ', idle ttl ' + Math.round(browserLive.idleTtlMs / 3_600_000) + 'h'
    + ', egress ' + (browserLive.egressProxy === '' ? 'direct' : browserLive.egressProxy) + ')')

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

  // Cross-session sharing: one gate in front of every browser tool path. The
  // gate is only installed when sharing is enabled — a disabled deployment keeps
  // the pre-sharing behaviour instead of refusing every browser call. It runs
  // before the provider's admission hook (prepend), so a refusal can never be
  // bypassed by a later listener.
  //
  // The runtime is built BEFORE the provider and the tools: both read
  // `browserLive.sharing` (the coordinator for restores, the stores and `auth`
  // for the state/artifact tools), and the provider captures the coordinator at
  // mount time.
  const sharingOptions = config.sharing ?? {}
  const sharing = createScopeResolver({
    enabled: sharingOptions.enabled === true,
    scopeId: sharingOptions.scopeId,
    allowCredentials: sharingOptions.allowCredentials !== false,
    members: Array.isArray(sharingOptions.members) && sharingOptions.members.length > 0 ? sharingOptions.members : null,
  })
  const sharingState = sharing.describe()
  if (sharingState.enabled) {
    installSharingGate(ctx, { resolver: sharing })
    const scopeRoot = path.join(dshHome(), 'data', 'browser-live', 'shared', 'v1', 'scopes', sharingState.scopeId)
    sharingRuntime = runtimeFactory({
      ctx,
      browserLive,
      scope: sharing,
      sharingState,
      scopeRoot,
      options: sharingOptions,
      dshHomePath: dshHome(),
    })
    browserLive.sharing = sharingRuntime
    browserLive.beforeRelease = async (sessionId, entry) => {
      await sharingRuntime.collect({ sessionId, entry })
    }
    const interval = Number.isFinite(sharingOptions.artifactScanIntervalMs) ? sharingOptions.artifactScanIntervalMs : 60_000
    if (interval > 0) {
      ctx.effect(() => {
        const timer = setInterval(() => {
          void sharingRuntime.collectAll().catch((error) => warn('artifact sweep failed:', error.message))
        }, Math.max(5_000, interval))
        timer.unref?.()
        return () => clearInterval(timer)
      }, 'browser-live: artifact sweep')
      log('artifact sweep armed (every ' + Math.round(Math.max(5_000, interval) / 1000) + 's)')
    }
    log('sharing gate armed (scope "' + sharingState.scopeId + '", members '
      + (sharingState.members === 'all-sessions' ? 'all sessions and subagents' : sharingState.members.length + ' listed')
      + ', credentials ' + (sharingState.allowCredentials ? 'allowed' : 'withheld')
      + ', storage ' + scopeRoot + ')')
  } else {
    log('sharing gate disabled (sharing.enabled=false): nothing is shared or restored')
  }

  if (config.provision !== false) {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        // Delayed so the web app's webServer service exists when the routes
        // register; adoption runs on the same tick.
        registerRoutes(ctx, browserLive)
        void browserLive.adoptExisting()
          .then(() => sharingRuntime?.collectAll())
          .catch((error) => warn('host adoption failed:', error.message))
      }, 5_000)
      return () => clearTimeout(timer)
    }, 'browser-live: host adoption')
  } else {
    registerRoutes(ctx, browserLive)
  }

  try {
    providerFactory(ctx, browserLive, {
      toolCallTimeoutMs: config.toolCallTimeoutMs,
      mcpCaps: config.mcpCaps,
      toolGateway: config.toolGateway,
      coordinator: sharingRuntime?.coordinator,
    })
  } catch (error) {
    warn('per-session browser provider not mounted:', error.message)
  }

  try {
    toolsFactory(ctx, browserLive, {
      storageStateDir: config.storageStateDir,
      quotaBytes: sharingOptions.quotaBytes ?? null,
    })
  } catch (error) {
    warn('browser_live_* tools not registered:', error.message)
  }
}

/**
 * Build the sharing runtime and wire its stores/coordinator/collectors.
 *
 * Kept as an exported factory (rather than inline in `apply`) so assembly tests
 * can prove that `auth`, the coordinator and the collector are all present and
 * share one root, without starting Docker or a browser.
 * @param {{ ctx: object, browserLive: object, scope: object, sharingState: object, scopeRoot: string, options?: object, dshHomePath?: string }} input
 * @returns {object} runtime.
 */
export function createSharingRuntime({ ctx, browserLive, scope, sharingState, scopeRoot, options = {}, dshHomePath = dshHome() }) {
  const auth = new AuthStore({ root: path.join(scopeRoot, 'auth') })
  const store = new ArtifactStore({ root: path.join(scopeRoot, 'artifacts'), quotaBytes: normalizeQuota(options.quotaBytes) })
  const audit = new AuditLog({ root: path.join(scopeRoot, 'audit') })
  const bindings = createOriginBindings(Array.isArray(options.bindings) ? options.bindings : [])
  // Restore records survive a harness restart, so `forget` can still clear an
  // already-imported login from a live browser after a reload. No cookie value
  // is stored here — only revision, domains, origins and seeded key names.
  const journalPath = path.join(scopeRoot, 'coordinator.json')
  const journal = {
    load() {
      try {
        return JSON.parse(fs.readFileSync(journalPath, 'utf8'))
      } catch {
        return {}
      }
    },
    save(records) {
      fs.mkdirSync(scopeRoot, { recursive: true, mode: 0o700 })
      const tmp = `${journalPath}.tmp`
      fs.writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(tmp, journalPath)
    },
  }
  const coordinator = createCoordinator({ scope, auth, audit, bindings, journal })
  // One collect at a time per session: a burst of tool calls must not hash the
  // same download folder concurrently.
  const collecting = new Map()
  const lastCollect = new Map()

  const collect = async ({ sessionId, entry }) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return { skipped: 'no-session' }
    if (entry === null || entry === undefined) return { skipped: 'no-entry' }
    // One scan at a time per session. A second caller (a tool finishing while the
    // timer scans, or the pre-release terminal scan) waits for that scan instead
    // of returning "busy" and possibly missing the last file.
    const current = collecting.get(sessionId)
    if (current !== undefined) return current
    const task = (async () => {
      try {
        const baseDir = path.join(dshHomePath, 'data', 'browser-live', entry.short ?? sessionShort(sessionId))
        // The MCP server's output root derives from the session id, while the pool
        // entry normally uses the same short name; scan both so a short-name
        // collision cannot hide MCP screenshots.
        const mcpDirs = [path.join(baseDir, 'mcp')]
        const altDir = path.join(dshHomePath, 'data', 'browser-live', sessionShort(sessionId), 'mcp')
        if (!mcpDirs.includes(altDir)) mcpDirs.push(altDir)
        const outcome = await collectSessionArtifacts({
          store,
          scopeId: sharingState.scopeId,
          sessionId,
          baseDir,
          generation: entry.generation ?? null,
          mcpDir: mcpDirs,
        })
        const record = { at: Date.now(), published: outcome.published.length, skipped: outcome.skipped, failed: outcome.failed.length, failures: outcome.failed.slice(0, 5) }
        lastCollect.set(sessionId, record)
        if (outcome.failed.length > 0) {
          warn('artifact collect failed for session', sessionId, ':', outcome.failed.map((item) => `${item.name}: ${item.error}`).join('; '))
        }
        return outcome
      } catch (error) {
        lastCollect.set(sessionId, { at: Date.now(), published: 0, skipped: 0, failed: 1, failures: [{ name: null, error: error.message }] })
        warn('artifact collect crashed for session', sessionId + ':', error.message)
        return { skipped: 'error', error: error.message }
      }
    })()
    collecting.set(sessionId, task)
    try {
      return await task
    } finally {
      if (collecting.get(sessionId) === task) collecting.delete(sessionId)
    }
  }

  /** Every session directory that still needs collection, from the map or the markers. */
  const collectAll = async () => {
    const seen = new Set()
    const targets = []
    for (const item of browserLive.listEntries?.() ?? []) {
      if (typeof item?.sessionId !== 'string' || seen.has(item.sessionId)) continue
      seen.add(item.sessionId)
      targets.push({ sessionId: item.sessionId, entry: item.entry })
    }
    const root = path.join(dshHomePath, 'data', 'browser-live')
    let names = []
    try {
      names = fs.readdirSync(root)
    } catch {
      names = []
    }
    for (const name of names) {
      try {
        const marker = JSON.parse(fs.readFileSync(path.join(root, name, '.sharing-session.json'), 'utf8'))
        if (typeof marker?.sessionId !== 'string' || seen.has(marker.sessionId)) continue
        seen.add(marker.sessionId)
        targets.push({ sessionId: marker.sessionId, entry: { short: name, generation: marker.generation ?? null } })
      } catch {
        // no marker: not a managed session directory
      }
    }
    const results = []
    for (const target of targets) {
      results.push({ sessionId: target.sessionId, outcome: await collect(target) })
    }
    return results
  }

  const publishCaptured = async ({ sessionId, entry, filePath, kind }) => {
    if (typeof filePath !== 'string' || filePath.length === 0) return { published: false, reason: 'no-file' }
    const baseDir = path.join(dshHomePath, 'data', 'browser-live', entry?.short ?? sessionShort(sessionId))
    try {
      const record = await publishFileInDir({
        store,
        scopeId: sharingState.scopeId,
        sessionId,
        generation: entry?.generation ?? null,
        dir: path.dirname(filePath),
        filePath,
        kind,
        indexFile: path.join(baseDir, kind === 'screenshot' ? '.artifacts-screenshots.json' : kind === 'pdf' ? '.artifacts-mcp.json' : '.artifacts-downloads.json'),
      })
      return { published: true, artifactId: record.artifactId, size: record.size }
    } catch (error) {
      warn('artifact publish failed for', filePath + ':', error.message)
      return { published: false, reason: error.message }
    }
  }

  return {
    coordinator,
    scope,
    auth,
    store,
    audit,
    bindings,
    collect,
    collectAll,
    publishCaptured,
    lastCollect,
    scopeRoot,
    /** Diagnostics for the status route. */
    status: () => ({
      scopeId: sharingState.scopeId,
      scopeRoot,
      coordinator: coordinator.status(),
      collects: [...lastCollect].map(([sessionId, record]) => ({ sessionId, ...record })),
    }),
  }
}

function normalizeQuota(value) {
  if (value === undefined || value === null) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null
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
        res.end(JSON.stringify({
          ...browserLive.status(),
          ...(browserLive.sharing === null || browserLive.sharing === undefined ? { sharing: null } : { sharing: browserLive.sharing.status() }),
        }))
      },
    })
    log('routes registered: /browser-live/session, /browser-live/status')
    return () => {
      disposeSession()
      disposeStatus()
    }
  }, 'browser-live: routes')
}
