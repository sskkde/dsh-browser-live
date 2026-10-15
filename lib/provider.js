/**
 * dsh-browser-live — per-session browser-use provider.
 *
 * Replaces the official `browser-use-playwright-mcp` attach row (which is
 * `exclusive: true` with one hard-coded CDP endpoint, so only one live session
 * can ever hold Neko). This provider mirrors that package's use of the
 * experimental browser-use runtime (`SessionResources` + `@deepseek-ai/dsh-mcp-client`
 * + `createScope`) with four deliberate differences:
 *
 *  1. `exclusive: false` — every live session owns its own attachment.
 *  2. Per-activation CDP proxy — the MCP server is spawned with a stable
 *     loopback endpoint owned by this plugin (`cdp-proxy.js`), which resolves
 *     the session's *current* Neko CDP port per connection. The endpoint
 *     therefore survives a slot change, and it exists before any slot does.
 *  3. Lazy slots and lazy containers — the MCP server process (cheap, registers
 *     the tools) is spawned when the agent is created, but neither the pool slot
 *     nor the Neko container is taken until a browser tool actually runs
 *     (`browserLive.ensure()` in the tools/execute hook below). An agent that
 *     never browses costs nothing, and creating a Session or a subagent can no
 *     longer evict a live one. `@playwright/mcp` connects to the CDP endpoint
 *     only when a tool runs, so a not-yet-started container costs nothing.
 *  4. Slot release on activation end — when the activation is disposed (a
 *     settled subagent, an unloaded owner) its slot goes back to the pool
 *     immediately instead of waiting for LRU eviction or the idle sweeper.
 *
 * Failure isolation: if a session's MCP server cannot spawn, that session
 * simply has no browser tools (the prompt section is dropped); other sessions
 * are unaffected.
 */

import { join, dirname } from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionResources } from '@deepseek-ai/dsh-experimental-browser-use-runtime'
import { createCdpProxy } from './cdp-proxy.js'
import { dshHome } from './service.js'
import { log, warn } from './log.js'

const SERVER_NAME = 'playwright-mcp'

/**
 * Mount one Playwright MCP server per live session, attached to that session's
 * own Neko container.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context with
 *   browserUse, agents, tools, and systemPrompt services available.
 * @param {import('./service.js').BrowserLiveService} browserLive - the pool.
 * @param {{ toolCallTimeoutMs?: number }} [options]
 */
export function applyProvider(ctx, browserLive, options = {}) {
  const toolPrefix = `mcp__${SERVER_NAME}__`
  const resourceTools = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])
  const clients = new Map()
  // agent → the pool entry this activation owns. Identity-guarded so an older
  // activation can never release a slot a newer one has already re-allocated.
  const ownedEntries = new Map()
  let resources
  let disposing = false

  const cli = resolvePlaywrightMcpCli()
  const env = Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => key.toUpperCase().startsWith('PLAYWRIGHT_MCP_'))
      .map((key) => [key, '']),
  )

  ctx.effect(function* () {
    yield ctx.browserUse.register(BrowserUseProviderName(SERVER_NAME))
    resources = new SessionResources(ctx, {
      label: SERVER_NAME,
      exclusive: false,
      async open(agent, signal) {
        const sessionId = agent.session?.id
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw new Error(`${SERVER_NAME}: agent has no session id; cannot attach a browser`)
        }
        // No slot and no container here: the activation only gets a stable CDP
        // endpoint (its own loopback proxy). The slot is allocated by the first
        // browser tool call, so an agent that never browses never costs one.
        const proxy = await createCdpProxy(
          () => browserLive.entryFor(sessionId)?.cdpPort ?? null,
          { onError: (error) => log('cdp proxy:', error.message) },
        )
        const scope = createScope(ctx, agent)
        let cancellation
        const cancel = () => { cancellation = scope.dispose() }
        signal.addEventListener('abort', cancel, { once: true })
        try {
          signal.throwIfAborted()
          scope.ctx.on('tools/execute', async (exec, next) => {
            if (!exec.name.startsWith(toolPrefix)) return next()
            if (exec.agent !== agent) {
              if (ctx.tools.get(exec.name, exec.agent) !== ctx.tools.get(exec.name, agent)) return next()
              throw new Error(`${SERVER_NAME}: browser tool belongs to another Session`)
            }
            return next()
          })
          await scope.ctx.plugin(McpClient, McpClient.Config({
            transport: 'stdio',
            serverName: SERVER_NAME,
            command: process.execPath,
            args: [cli, '--browser', 'chromium', '--cdp-endpoint', proxy.endpoint],
            env,
            ...agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd },
            ...options.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: options.toolCallTimeoutMs },
            failOnStartupError: true,
            reconnect: { enabled: false },
          }))
          signal.throwIfAborted()
          return {
            value: scope,
            async close() {
              clients.delete(agent)
              const owned = ownedEntries.get(agent)
              ownedEntries.delete(agent)
              // Hand the slot back now instead of leaving it for LRU/TTL. A
              // provider unload is the exception: the pool is meant to survive
              // it and be adopted by the next boot, so the containers stay.
              if (!disposing) {
                try {
                  if (owned !== undefined && owned !== null && browserLive.entryFor(sessionId) === owned) {
                    browserLive.release(sessionId)
                  }
                } catch (error) {
                  warn('slot release on activation end failed:', error.message)
                }
              }
              await proxy.close()
              return scope.dispose()
            },
          }
        } catch (error) {
          await proxy.close().catch(() => undefined)
          await (cancellation ?? scope.dispose())
          throw error
        } finally {
          signal.removeEventListener('abort', cancel)
        }
      },
    })
    yield async () => {
      // Unload, not activation end: keep the containers so the next boot can
      // adopt them (see the `disposing` guard in close()).
      disposing = true
      await resources.dispose()
      clients.clear()
      ownedEntries.clear()
    }
  }, `${SERVER_NAME}.sessions`)

  // Acquisition at agent creation spawns only the cheap MCP process and its
  // proxy: no pool slot, no container. Every live session ends up "ready"
  // because the pool is non-exclusive.
  ctx.on('agent/created', async ({ agent, signal }) => {
    try {
      await resources.get(agent, signal)
      clients.set(agent, { status: 'ready' })
    } catch (error) {
      clients.set(agent, { status: 'failed' })
      warn(`browser provider unavailable for session ${agent.session?.id ?? '?'}:`, error.message)
    }
  }, { prepend: true })

  // The pool announces every allocation, whichever path made it: the MCP hook
  // below, this plugin's own `browser_live_*` tools (which call `ensure()`
  // inside their own execution), or a future tool. Recording it here is what
  // lets an activation's end hand exactly its own entry back.
  ctx.on('browserLive/allocated', ({ sessionId, entry }) => {
    if (typeof sessionId !== 'string' || entry === undefined || entry === null) return
    const owner = ctx.agents?.get(sessionId)
    if (owner !== undefined && owner !== null) ownedEntries.set(owner, entry)
  })

  ctx.on('tools/execute', async (exec, next) => {
    const ownResource = resourceTools.has(exec.name)
      && typeof exec.arguments === 'object' && exec.arguments !== null
      && exec.arguments.server === SERVER_NAME
    if (!exec.name.startsWith(toolPrefix) && !ownResource) return next()
    const agent = exec.agent
    if (agent === undefined || clients.get(agent)?.status !== 'ready') {
      throw new Error(`${SERVER_NAME}: browser tools are not available in this session`)
    }
    // Lazy slot and container: this is the first browser use, so reserve the
    // slot and bring the container up before the MCP server dials the proxy.
    // The allocation event records the entry for activation-end release.
    await browserLive.ensure(agent.session.id)
    return resources.run(agent, exec.signal, async (_scope, combined) => {
      const original = exec.signal
      exec.signal = combined
      try {
        return await next()
      } finally {
        exec.signal = original
      }
    })
  })

  // A failed spawn must not leave a dangling browser prompt section behind.
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const assembly = await next()
    if (agent === undefined || clients.get(agent)?.status === 'ready') return assembly
    return { ...assembly, sections: assembly.sections.filter((section) => section.name !== `mcp:${SERVER_NAME}`) }
  })

  log('per-session browser provider mounted (server "' + SERVER_NAME + '", pool max ' + browserLive.maxSessions + ')')
}

/** Resolve the pinned @playwright/mcp CLI with a profile-layout fallback. */
function resolvePlaywrightMcpCli() {
  try {
    const pkgUrl = import.meta.resolve('@playwright/mcp/package.json')
    return join(dirname(fileURLToPath(pkgUrl)), 'cli.js')
  } catch (error) {
    warn('cannot resolve @playwright/mcp via import.meta.resolve:', error?.message ?? String(error))
  }
  // Linked installs resolve the package through the harness loader; if that
  // ever fails, fall back to the standard profile node_modules location.
  const fallback = join(dshHome(), 'profiles', 'web', 'node_modules', '@playwright', 'mcp', 'cli.js')
  if (fs.existsSync(fallback)) return fallback
  throw new Error('@playwright/mcp cli.js not found; install dsh-browser-live into a profile that carries it')
}
