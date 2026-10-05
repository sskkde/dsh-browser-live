/**
 * dsh-browser-live — per-session browser-use provider.
 *
 * Replaces the official `browser-use-playwright-mcp` attach row (which is
 * `exclusive: true` with one hard-coded CDP endpoint, so only one live session
 * can ever hold Neko). This provider mirrors that package's use of the
 * experimental browser-use runtime (`SessionResources` + `@deepseek-ai/dsh-mcp-client`
 * + `createScope`) with three deliberate differences:
 *
 *  1. `exclusive: false` — every live session owns its own attachment.
 *  2. Per-session `--cdp-endpoint` — resolved from the `browserLive` service
 *     for `agent.session.id`, so each session drives its own Neko container.
 *  3. Lazy containers — the MCP server process (cheap, registers the tools) is
 *     spawned when the agent is created; the Neko container (expensive) is
 *     started by the `browserLive.ensure()` call that precedes the first
 *     tool's execution. `@playwright/mcp` connects to the CDP endpoint only
 *     when a tool actually runs, so a not-yet-started container costs nothing.
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
  let resources

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
          throw new Error(`${SERVER_NAME}: agent has no session id; cannot allocate a browser container`)
        }
        // Cheap: reserves the slot and pins the endpoints. The container itself
        // starts on the first tool call (see the tools/execute hook below).
        const entry = browserLive.allocate(sessionId)
        const endpoint = `http://127.0.0.1:${entry.cdpPort}`
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
            args: [cli, '--browser', 'chromium', '--cdp-endpoint', endpoint],
            env,
            ...agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd },
            ...options.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: options.toolCallTimeoutMs },
            failOnStartupError: true,
            reconnect: { enabled: false },
          }))
          signal.throwIfAborted()
          return {
            value: scope,
            close() {
              clients.delete(agent)
              return scope.dispose()
            },
          }
        } catch (error) {
          await (cancellation ?? scope.dispose())
          throw error
        } finally {
          signal.removeEventListener('abort', cancel)
        }
      },
    })
    yield async () => {
      await resources.dispose()
      clients.clear()
    }
  }, `${SERVER_NAME}.sessions`)

  // Acquisition at agent creation spawns only the cheap MCP process; every
  // live session ends up "ready" because the pool is non-exclusive.
  ctx.on('agent/created', async ({ agent, signal }) => {
    try {
      await resources.get(agent, signal)
      clients.set(agent, { status: 'ready' })
    } catch (error) {
      clients.set(agent, { status: 'failed' })
      warn(`browser provider unavailable for session ${agent.session?.id ?? '?'}:`, error.message)
    }
  }, { prepend: true })

  ctx.on('tools/execute', async (exec, next) => {
    const ownResource = resourceTools.has(exec.name)
      && typeof exec.arguments === 'object' && exec.arguments !== null
      && exec.arguments.server === SERVER_NAME
    if (!exec.name.startsWith(toolPrefix) && !ownResource) return next()
    const agent = exec.agent
    if (agent === undefined || clients.get(agent)?.status !== 'ready') {
      throw new Error(`${SERVER_NAME}: browser tools are not available in this session`)
    }
    // Lazy container start: the MCP server only dials the CDP endpoint while a
    // tool executes, so bring the container up here, before dispatching.
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
