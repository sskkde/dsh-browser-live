#!/usr/bin/env node
/**
 * dsh-browser-live — MCP progressive-disclosure gateway.
 *
 * Sits between `@deepseek-ai/dsh-mcp-client` and one `@playwright/mcp` process.
 * It is both an MCP **server** (newline-delimited JSON-RPC 2.0 on stdio, the
 * surface the model sees) and an MCP **client** to the inner server.
 *
 * Why it exists: the inner always starts with all six capability groups so a
 * later `enable` never restarts the browser, but publishing all 70 schemas
 * costs context in every session. The gateway publishes:
 *
 *   - 3 `browser_gateway_*` meta tools, always;
 *   - the 10 resident tools, while the inner is ready;
 *   - the tools of the capability groups the model enabled, on demand.
 *
 * `initialize` and `ping` are answered locally, so the client handshake never
 * depends on the inner being up. `tools/call` is forwarded with an id map, and
 * `notifications/cancelled` is translated back to the inner id.
 *
 * Usage: node lib/gateway/server.js -- <innerCli> [innerArgs...]
 *
 * stdout carries JSON-RPC lines only; every log line goes to stderr with the
 * `[browser-live-gateway]` prefix.
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { CAP_GROUPS, GROUPS, GROUP_NAMES, META_TOOLS, RESIDENT_TOOLS, groupOf } from './catalog.js'

const PREFIX = '[browser-live-gateway]'
const PROTOCOL_VERSION = '2025-06-18'
const INNER_CLIENT_NAME = 'dsh-browser-live-gateway'
/** Backoff for an inner that died or could not start (three attempts, then stay degraded). */
const RESPAWN_DELAYS_MS = [500, 2_000, 8_000]
const SHUTDOWN_GRACE_MS = 2_000
const MAX_LIST_PAGES = 50
const SUGGESTION_MAX_DISTANCE = 3

const CANCELLED = Symbol('cancelled')

const PACKAGE_VERSION = readPackageVersion()

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function log(...args) {
  const text = args.map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : String(arg))).join(' ')
  process.stderr.write(`${PREFIX} ${text}\n`)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** JSON-RPC ids may be numbers or strings; the gateway keys maps on both. */
function idKey(id) {
  return `${typeof id}:${String(id)}`
}

// --------------------------------------------------------------- meta tools

const META_DEFINITIONS = {
  browser_gateway_groups: {
    name: 'browser_gateway_groups',
    description:
      'Show the browser tool gateway state: server status, the number of visible browser tools, '
      + 'which capability groups are enabled, the resident tools currently available, and any inner '
      + 'tool the catalog does not know. Call this first when a browser_* tool is missing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  browser_gateway_enable: {
    name: 'browser_gateway_enable',
    description:
      'Make a capability group\'s browser tools visible in this session. Groups are off by default '
      + 'to keep the tool list small; enabling is idempotent, session-scoped, and does not restart the '
      + 'browser. Call browser_gateway_groups for the group table.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', enum: [...GROUP_NAMES], description: 'Capability group to publish.' },
      },
      required: ['group'],
      additionalProperties: false,
    },
  },
  browser_gateway_call: {
    name: 'browser_gateway_call',
    description:
      'Call any Playwright browser tool by name, even when it is not currently visible. Use it for a '
      + 'one-off call to a group you have not enabled (for example browser_pdf_save); the tool result is '
      + 'returned unchanged, including image content blocks and isError.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Exact browser tool name, e.g. browser_cookie_list.' },
        arguments: { type: 'object', additionalProperties: true, description: 'Arguments for that tool.' },
      },
      required: ['tool'],
      additionalProperties: false,
    },
  },
}

const META_TOOL_SET = new Set(META_TOOLS)

// ------------------------------------------------------------------- state

/** Everything after the first standalone `--` is the inner command. */
const argv = process.argv.slice(2)
const separator = argv.indexOf('--')
const innerArgs = separator === -1 ? [] : argv.slice(separator + 1)

/** 'starting' while the inner handshake runs, 'ready' when the catalog is cached. */
let status = 'starting'
/** name → tool definition, exactly as the inner published it (paginated). */
let innerTools = new Map()
/** Capability groups the model enabled in this session. */
const enabledGroups = new Set()

let innerChild = null
let respawnAttempt = 0
let respawnTimer = null
let refreshingCatalog = false
let clientInitialized = false
let shuttingDown = false

/** All in-flight inner requests, keyed by the gateway's numeric inner id. */
const pendingInner = new Map()
/** client request id key → inner id, for cancellation translation. */
const innerIdByClient = new Map()
let nextInnerId = 1

// -------------------------------------------------------------- client I/O

function sendToClient(message) {
  if (shuttingDown) return
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  } catch (error) {
    log('cannot write to the client:', error.message)
    shutdown('client pipe closed', 1)
  }
}

function sendResult(id, result) {
  sendToClient({ jsonrpc: '2.0', id, result })
}

function sendError(id, code, message) {
  sendToClient({ jsonrpc: '2.0', id, error: { code, message } })
}

/** `tools/list_changed` is only ever emitted after the client's `initialized`. */
function emitListChanged() {
  if (!clientInitialized || shuttingDown) return
  sendToClient({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
}

function writeToInner(child, message) {
  if (child === null || child.gone) return false
  try {
    child.stdin.write(`${JSON.stringify(message)}\n`)
    return true
  } catch (error) {
    log('cannot write to the inner server:', error.message)
    return false
  }
}

// ------------------------------------------------------------ tool surface

function textResult(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  return { content: [{ type: 'text', text }] }
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

/**
 * The tools the client currently sees: the three meta tools first, then the
 * resident tools present in the inner catalog, then every enabled group.
 * While the inner is not ready only the meta tools are visible.
 */
function visibleTools() {
  const tools = META_TOOLS.map((name) => META_DEFINITIONS[name])
  if (status !== 'ready') return tools
  const seen = new Set(META_TOOLS)
  const push = (name) => {
    if (seen.has(name) || !innerTools.has(name)) return
    seen.add(name)
    tools.push(innerTools.get(name))
  }
  for (const name of RESIDENT_TOOLS) push(name)
  for (const group of GROUP_NAMES) {
    if (!enabledGroups.has(group)) continue
    for (const name of GROUPS[group]) push(name)
  }
  return tools
}

function groupsPayload() {
  const ready = status === 'ready'
  const enabled = GROUP_NAMES.filter((group) => enabledGroups.has(group))
  return {
    status,
    visible: visibleTools().length,
    resident: ready ? RESIDENT_TOOLS.filter((name) => innerTools.has(name)) : [],
    enabled,
    groups: GROUP_NAMES.map((group) => ({
      name: group,
      count: GROUPS[group].length,
      enabled: enabledGroups.has(group),
      available: GROUPS[group].every((name) => innerTools.has(name)),
    })),
    unmapped: [...innerTools.keys()].filter((name) => groupOf(name) === null && !RESIDENT_TOOLS.includes(name)),
  }
}

function unavailableMessage() {
  return `browser-live gateway: the inner Playwright MCP server is ${status}, so browser tools are `
    + 'unavailable right now. Call browser_gateway_groups to check status, then retry the call.'
}

function editDistance(a, b) {
  const cols = b.length + 1
  let previous = new Array(cols)
  let current = new Array(cols)
  for (let column = 0; column < cols; column += 1) previous[column] = column
  for (let row = 1; row <= a.length; row += 1) {
    current[0] = row
    for (let column = 1; column < cols; column += 1) {
      const substitution = previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1)
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, substitution)
    }
    const swap = previous
    previous = current
    current = swap
  }
  return previous[cols - 1]
}

/** Closest known tool name, when one is close enough to be a useful hint. */
function suggestToolName(name) {
  const haystack = [...innerTools.keys(), ...META_TOOLS]
  let best = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of haystack) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase())
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best !== null && bestDistance <= SUGGESTION_MAX_DISTANCE ? best : null
}

function unknownToolResult(name) {
  const suggestion = suggestToolName(name)
  return errorResult(
    `browser-live gateway: unknown browser tool ${JSON.stringify(name)}.`
    + (suggestion === null ? '' : ` Did you mean ${JSON.stringify(suggestion)}?`)
    + ' Call browser_gateway_groups for the visible tools, or browser_gateway_enable to publish a '
    + 'capability group, then retry.',
  )
}

// --------------------------------------------------------------- meta logic

function enableGroup(input) {
  const group = input.group
  if (typeof group !== 'string' || group.length === 0) {
    return errorResult(
      `browser-live gateway: browser_gateway_enable requires a "group" string. Valid groups: ${GROUP_NAMES.join(', ')}.`,
    )
  }
  if (!GROUP_NAMES.includes(group)) {
    return errorResult(
      `browser-live gateway: unknown group ${JSON.stringify(group)}. Valid groups: ${GROUP_NAMES.join(', ')}. `
      + 'Call browser_gateway_groups to see what is already enabled.',
    )
  }
  const newlyEnabled = !enabledGroups.has(group)
  enabledGroups.add(group)
  const added = newlyEnabled && status === 'ready' ? GROUPS[group].filter((name) => innerTools.has(name)) : []
  const unavailable = newlyEnabled && status === 'ready'
    ? GROUPS[group].filter((name) => !innerTools.has(name))
    : []
  // State first, then the notification, then the result (design §4).
  if (newlyEnabled) emitListChanged()
  const payload = {
    enabled: GROUP_NAMES.filter((name) => enabledGroups.has(name)),
    added,
    visible: visibleTools().length,
  }
  if (unavailable.length > 0) payload.unavailable = unavailable
  return textResult(payload)
}

async function gatewayCall(input, requestId) {
  const tool = input.tool
  if (typeof tool !== 'string' || tool.length === 0) {
    return errorResult(
      'browser-live gateway: browser_gateway_call requires a "tool" string. Call browser_gateway_groups for the visible tools.',
    )
  }
  if (META_TOOL_SET.has(tool)) {
    return errorResult(
      `browser-live gateway: browser_gateway_call cannot call the gateway meta tool ${JSON.stringify(tool)}; call it directly.`,
    )
  }
  const callArguments = input.arguments === undefined ? {} : input.arguments
  if (!isPlainObject(callArguments)) {
    return errorResult('browser-live gateway: browser_gateway_call "arguments" must be a JSON object.')
  }
  if (status !== 'ready') return errorResult(unavailableMessage())
  if (!innerTools.has(tool)) return unknownToolResult(tool)
  try {
    const result = await requestInner('tools/call', { name: tool, arguments: callArguments }, requestId)
    if (result === CANCELLED) return CANCELLED
    return normalizeInnerResult(result)
  } catch (error) {
    return errorResult(`browser-live gateway: ${tool} failed: ${error.message}`)
  }
}

async function runMetaTool(name, input, requestId) {
  if (name === 'browser_gateway_groups') return textResult(groupsPayload())
  if (name === 'browser_gateway_enable') return enableGroup(input)
  return gatewayCall(input, requestId)
}

// ------------------------------------------------------------ tool calling

/** Inner results pass through verbatim; only a non-object result is wrapped. */
function normalizeInnerResult(result) {
  if (isPlainObject(result)) return result
  return textResult(JSON.stringify(result ?? null))
}

async function handleToolsCall(params, requestId) {
  const name = isPlainObject(params) && typeof params.name === 'string' ? params.name : ''
  if (name.length === 0) return errorResult('browser-live gateway: tools/call without a tool name.')
  const input = isPlainObject(params.arguments) ? params.arguments : {}
  if (META_TOOL_SET.has(name)) return runMetaTool(name, input, requestId)
  if (status !== 'ready') return errorResult(unavailableMessage())
  if (!innerTools.has(name)) return unknownToolResult(name)
  try {
    const result = await requestInner('tools/call', { name, arguments: input }, requestId)
    if (result === CANCELLED) return CANCELLED
    return normalizeInnerResult(result)
  } catch (error) {
    return errorResult(`browser-live gateway: ${name} failed: ${error.message}`)
  }
}

/**
 * Send a request to the inner server and resolve with its raw result.
 * `mapTo` (the client request id) is what makes cancellation translatable.
 */
function requestInner(method, params, mapTo) {
  return new Promise((resolve, reject) => {
    const child = innerChild
    if (child === null || child.gone) {
      reject(new Error('the inner Playwright MCP server is not running'))
      return
    }
    const id = nextInnerId
    nextInnerId += 1
    const entry = { resolve, reject, clientId: mapTo, cancelled: false }
    if (mapTo !== undefined) innerIdByClient.set(idKey(mapTo), id)
    pendingInner.set(id, entry)
    if (!writeToInner(child, { jsonrpc: '2.0', id, method, params: params ?? {} })) {
      pendingInner.delete(id)
      if (mapTo !== undefined) innerIdByClient.delete(idKey(mapTo))
      reject(new Error('cannot write to the inner Playwright MCP server'))
    }
  })
}

function settleInner(message) {
  const entry = pendingInner.get(message.id)
  if (entry === undefined) {
    log('dropping an inner response for an unknown id:', String(message.id))
    return
  }
  pendingInner.delete(message.id)
  if (entry.clientId !== undefined) innerIdByClient.delete(idKey(entry.clientId))
  if (entry.cancelled) {
    entry.resolve(CANCELLED)
    return
  }
  if (message.error !== undefined) {
    const error = new Error(typeof message.error?.message === 'string' ? message.error.message : 'inner error')
    error.code = message.error?.code
    entry.reject(error)
    return
  }
  entry.resolve(message.result)
}

function failPendingInner(reason) {
  const entries = [...pendingInner.values()]
  pendingInner.clear()
  innerIdByClient.clear()
  for (const entry of entries) {
    if (entry.cancelled) {
      entry.resolve(CANCELLED)
      continue
    }
    entry.reject(new Error(reason))
  }
}

function handleCancellation(params) {
  if (!isPlainObject(params)) return
  const requestId = params.requestId
  if (requestId === undefined || requestId === null) return
  const key = idKey(requestId)
  const innerId = innerIdByClient.get(key)
  if (innerId === undefined) return
  const entry = pendingInner.get(innerId)
  if (entry === undefined) {
    innerIdByClient.delete(key)
    return
  }
  entry.cancelled = true
  const forwarded = { requestId: innerId }
  if (typeof params.reason === 'string' && params.reason.length > 0) forwarded.reason = params.reason
  writeToInner(innerChild, { jsonrpc: '2.0', method: 'notifications/cancelled', params: forwarded })
}

// ----------------------------------------------------------- client routing

function initializeResult() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: 'playwright-mcp', version: PACKAGE_VERSION },
  }
}

function handleClientNotification(method, params) {
  if (method === 'notifications/initialized') {
    clientInitialized = true
    return
  }
  if (method === 'notifications/cancelled') handleCancellation(params)
  // Progress/roots notifications from the client are not part of this contract.
}

async function handleClient(message) {
  if (!isPlainObject(message) || typeof message.method !== 'string') return
  const method = message.method
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== null && message.id !== undefined
  if (!hasId) {
    handleClientNotification(method, message.params)
    return
  }
  try {
    if (method === 'initialize') {
      sendResult(message.id, initializeResult())
      return
    }
    if (method === 'ping') {
      sendResult(message.id, {})
      return
    }
    if (method === 'tools/list') {
      sendResult(message.id, { tools: visibleTools() })
      return
    }
    if (method === 'tools/call') {
      const outcome = await handleToolsCall(message.params, message.id)
      // A cancelled call must not produce a response (MCP: cancellation means drop it).
      if (outcome !== CANCELLED) sendResult(message.id, outcome)
      return
    }
    // Everything else belongs to the inner server (resources/prompts/logging).
    const result = await requestInner(method, message.params)
    sendResult(message.id, result === undefined ? {} : result)
  } catch (error) {
    log('client request', method, 'failed:', error.message)
    sendError(message.id, -32000, error.message ?? String(error))
  }
}

// ---------------------------------------------------------- inner lifecycle

function isToolDefinition(tool) {
  return isPlainObject(tool) && typeof tool.name === 'string' && tool.name.length > 0
}

/** Follow `nextCursor` until the inner stops paginating. */
async function listInnerTools() {
  const tools = []
  let cursor
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = await requestInner('tools/list', cursor === undefined ? {} : { cursor })
    if (Array.isArray(result?.tools)) tools.push(...result.tools.filter(isToolDefinition))
    const next = result?.nextCursor
    if (typeof next !== 'string' || next.length === 0 || next === cursor) break
    cursor = next
  }
  return tools
}

function handleInnerLine(line, child) {
  const text = line.trim()
  if (text.length === 0) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    log('dropping a malformed line from the inner server:', text.slice(0, 160))
    return
  }
  if (innerChild !== child) return
  if (!isPlainObject(message)) return
  if (typeof message.method === 'string') {
    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      handleInnerRequest(message, child)
      return
    }
    handleInnerNotification(message)
    return
  }
  if (Object.prototype.hasOwnProperty.call(message, 'id')) settleInner(message)
}

/** Minimal server→client request support: enough that the inner never hangs. */
function handleInnerRequest(message, child) {
  if (message.method === 'ping') {
    writeToInner(child, { jsonrpc: '2.0', id: message.id, result: {} })
    return
  }
  if (message.method === 'roots/list') {
    writeToInner(child, { jsonrpc: '2.0', id: message.id, result: { roots: [] } })
    return
  }
  writeToInner(child, {
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: `the browser-live gateway does not support ${message.method}` },
  })
}

function handleInnerNotification(message) {
  if (message.method === 'notifications/tools/list_changed') {
    void refreshInnerTools()
    return
  }
  // Progress/logging notifications from the inner are not forwarded (see README).
}

async function refreshInnerTools() {
  if (refreshingCatalog || status !== 'ready') return
  refreshingCatalog = true
  const child = innerChild
  try {
    const tools = await listInnerTools()
    if (innerChild !== child || shuttingDown) return
    innerTools = new Map(tools.map((tool) => [tool.name, tool]))
    log('inner catalog refreshed:', innerTools.size, 'tools')
    emitListChanged()
  } catch (error) {
    log('inner catalog refresh failed:', error.message)
  } finally {
    refreshingCatalog = false
  }
}

async function handshake(child) {
  try {
    await requestInner('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: INNER_CLIENT_NAME, version: PACKAGE_VERSION },
    })
    if (innerChild !== child || shuttingDown) return
    writeToInner(child, { jsonrpc: '2.0', method: 'notifications/initialized' })
    const tools = await listInnerTools()
    if (innerChild !== child || shuttingDown) return
    innerTools = new Map(tools.map((tool) => [tool.name, tool]))
    status = 'ready'
    respawnAttempt = 0
    log('inner ready:', innerTools.size, 'tools cached')
    emitListChanged()
  } catch (error) {
    if (innerChild !== child || shuttingDown) return
    log('inner handshake failed:', error.message)
    try {
      child.kill('SIGTERM')
    } catch {
      // already gone
    }
    innerGone(child, `handshake failed: ${error.message}`)
  }
}

function scheduleRespawn() {
  if (shuttingDown || respawnTimer !== null) return
  if (respawnAttempt >= RESPAWN_DELAYS_MS.length) {
    log(`inner unavailable after ${RESPAWN_DELAYS_MS.length} respawn attempts; staying degraded`)
    return
  }
  const delay = RESPAWN_DELAYS_MS[respawnAttempt]
  respawnAttempt += 1
  log(`respawning inner in ${delay}ms (attempt ${respawnAttempt}/${RESPAWN_DELAYS_MS.length})`)
  respawnTimer = setTimeout(() => {
    respawnTimer = null
    spawnInner()
  }, delay)
  respawnTimer.unref?.()
}

function innerGone(child, reason) {
  if (child.gone) return
  child.gone = true
  if (innerChild === child) innerChild = null
  status = 'degraded'
  innerTools = new Map()
  failPendingInner(`the inner Playwright MCP server stopped (${reason})`)
  if (shuttingDown) return
  log('inner gone:', reason)
  emitListChanged()
  scheduleRespawn()
}

function spawnInner() {
  respawnTimer = null
  if (shuttingDown) return
  const [cli, ...rest] = innerArgs
  if (typeof cli !== 'string' || cli.length === 0) {
    status = 'degraded'
    log('no inner command given (expected `-- <playwright-mcp cli> [args]`); publishing meta tools only')
    emitListChanged()
    return
  }
  status = 'starting'
  const child = spawn(process.execPath, [cli, ...rest], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
  child.gone = false
  innerChild = child
  const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity })
  stdout.on('line', (line) => handleInnerLine(line, child))
  const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity })
  stderr.on('line', (line) => {
    if (line.trim().length > 0) log('inner:', line)
  })
  child.on('error', (error) => {
    log('inner spawn error:', error.message)
    innerGone(child, `spawn error: ${error.message}`)
  })
  child.on('exit', (code, signal) => {
    innerGone(child, `exit code ${code ?? 'null'}, signal ${signal ?? 'none'}`)
  })
  child.stdin.on('error', (error) => log('inner stdin error:', error.message))
  log('inner started:', [cli, ...rest].join(' '))
  void handshake(child)
}

// ---------------------------------------------------------------- shutdown

function shutdown(reason, code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down:', reason)
  if (respawnTimer !== null) {
    clearTimeout(respawnTimer)
    respawnTimer = null
  }
  const child = innerChild
  if (child === null || child.gone) {
    process.exit(code)
    return
  }
  const force = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // already exited
    }
    process.exit(code)
  }, SHUTDOWN_GRACE_MS)
  force.unref?.()
  child.once('exit', () => {
    clearTimeout(force)
    process.exit(code)
  })
  try {
    child.kill('SIGTERM')
  } catch {
    clearTimeout(force)
    process.exit(code)
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('uncaughtException', (error) => {
  log('uncaught exception:', error)
  shutdown('uncaught exception', 1)
})
process.on('unhandledRejection', (reason) => {
  log('unhandled rejection:', reason)
})
process.on('exit', () => {
  if (innerChild !== null && !innerChild.gone) {
    try {
      innerChild.kill('SIGTERM')
    } catch {
      // already exited
    }
  }
})

const clientReader = createInterface({ input: process.stdin, crlfDelay: Infinity })
clientReader.on('line', (line) => {
  const text = line.trim()
  if (text.length === 0) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    log('dropping a malformed line from the client:', text.slice(0, 160))
    return
  }
  void handleClient(message)
})
clientReader.on('close', () => shutdown('client stdin closed'))
process.stdin.on('error', (error) => {
  log('client stdin error:', error.message)
  shutdown('client stdin error', 1)
})
process.stdout.on('error', (error) => {
  log('client stdout error:', error.message)
  shutdown('client stdout error', 1)
})

log(`gateway ${PACKAGE_VERSION} starting (protocol ${PROTOCOL_VERSION}, caps ${CAP_GROUPS.join(',')})`)
spawnInner()
