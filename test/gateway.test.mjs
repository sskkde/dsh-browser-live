/**
 * dsh-browser-live — gateway tests.
 *
 * The gateway is exercised as a real child process: `node lib/gateway/server.js
 * -- <fake inner>`, driven over stdio exactly as `@deepseek-ai/dsh-mcp-client`
 * drives it. The fake inner (test/fixtures/fake-inner.mjs) needs no browser.
 *
 * Run with `node --test test/`.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  CAP_GROUPS,
  GROUPS,
  GROUP_NAMES,
  META_TOOLS,
  RESIDENT_TOOLS,
  groupOf,
} from '../lib/gateway/catalog.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const GATEWAY = join(REPO, 'lib', 'gateway', 'server.js')
const FAKE_INNER = join(HERE, 'fixtures', 'fake-inner.mjs')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'browser-live-gateway-'))
}

/** One gateway process plus the JSON-RPC plumbing a test needs. */
class GatewayProcess {
  constructor(child) {
    this.child = child
    this.messages = []
    this.protocolErrors = []
    this.stderr = ''
    this.closed = false
    this.nextId = 1
    this.waiters = new Set()
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      const text = line.trim()
      if (text.length === 0) return
      let message
      try {
        message = JSON.parse(text)
      } catch {
        this.protocolErrors.push(text)
        return
      }
      this.messages.push(message)
      this.flush()
    })
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => {
      this.stderr += `${line}\n`
      this.flush()
    })
    child.on('exit', () => {
      this.closed = true
      this.flush()
    })
  }

  flush() {
    for (const waiter of [...this.waiters]) waiter()
  }

  /** Resolve once `predicate()` returns a truthy value. */
  waitFor(predicate, label, timeoutMs = 6_000) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.waiters.delete(check)
        clearTimeout(timer)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(
          `timed out waiting for ${label}\n--- gateway stderr ---\n${this.stderr}\n--- messages ---\n${JSON.stringify(this.messages).slice(0, 2_000)}`,
        ))
      }, timeoutMs)
      const check = () => {
        let value
        try {
          value = predicate()
        } catch {
          return
        }
        if (value !== undefined && value !== null && value !== false) {
          cleanup()
          resolve(value)
        }
      }
      this.waiters.add(check)
      check()
    })
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  notify(method, params) {
    this.send({ method, params })
  }

  /** Send a request and resolve with its result; rejects on a JSON-RPC error. */
  call(method, params, id = this.nextId++) {
    const response = this.waitFor(
      () => this.messages.find((message) => message.id === id && (message.result !== undefined || message.error !== undefined)),
      `${method} response`,
    )
    this.send({ id, method, params })
    return response.then((message) => {
      if (message.error !== undefined) throw new Error(`${method}: ${JSON.stringify(message.error)}`)
      return message.result
    })
  }

  listChangedCount() {
    return this.messages.filter((message) => message.method === 'notifications/tools/list_changed').length
  }

  async stop() {
    if (this.closed) return
    const exited = new Promise((resolve) => this.child.once('exit', resolve))
    try {
      this.child.stdin.end()
      this.child.kill('SIGTERM')
    } catch {
      // already gone
    }
    await Promise.race([exited, sleep(3_000)])
    if (!this.closed) {
      this.child.kill('SIGKILL')
      await Promise.race([exited, sleep(1_000)])
    }
  }
}

function startGateway({ inner = FAKE_INNER, innerArgs = [], env = {} } = {}) {
  // The gateway runs the inner command with process.execPath itself, so the
  // inner is given as a script path, exactly like provider.js wires it.
  const child = spawn(process.execPath, [GATEWAY, '--', inner, ...innerArgs], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return new GatewayProcess(child)
}

/** Initialize a gateway the way dsh-mcp-client does. */
async function readyGateway(options = {}) {
  const gateway = startGateway(options)
  const result = await gateway.call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'gateway-test', version: '0.0.0' },
  })
  gateway.notify('notifications/initialized')
  return { gateway, initialize: result }
}

/** Poll tools/list until the expected number of tools is visible. */
async function waitForVisible(gateway, expected, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    const result = await gateway.call('tools/list', {})
    last = result.tools.map((tool) => tool.name)
    if (last.length === expected) return result
    await sleep(25)
  }
  throw new Error(`expected ${expected} visible tools, last saw ${last?.length}\n--- gateway stderr ---\n${gateway.stderr}`)
}

function payloadOf(result) {
  assert.equal(result.isError, undefined, 'expected a successful tool result')
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0].type, 'text')
  return JSON.parse(result.content[0].text)
}

test('catalog: 10 resident + 60 grouped + 3 meta tools, no overlap', () => {
  assert.equal(RESIDENT_TOOLS.length, 10)
  assert.equal(new Set(RESIDENT_TOOLS).size, 10)
  assert.equal(META_TOOLS.length, 3)
  assert.deepEqual(GROUP_NAMES, ['core', 'storage', 'network', 'testing', 'pdf', 'vision', 'devtools'])
  assert.deepEqual(
    Object.fromEntries(GROUP_NAMES.map((name) => [name, GROUPS[name].length])),
    { core: 14, storage: 17, network: 4, testing: 5, pdf: 1, vision: 6, devtools: 13 },
  )
  const grouped = GROUP_NAMES.flatMap((name) => GROUPS[name])
  assert.equal(grouped.length, 60)
  assert.equal(new Set(grouped).size, 60)
  const all = [...RESIDENT_TOOLS, ...grouped, ...META_TOOLS]
  assert.equal(new Set(all).size, 73)
  for (const name of RESIDENT_TOOLS) assert.equal(groupOf(name), null, `${name} must not belong to a group`)
  for (const name of META_TOOLS) assert.equal(groupOf(name), null, `${name} must not belong to a group`)
  assert.equal(groupOf('browser_cookie_list'), 'storage')
  assert.equal(groupOf('browser_mouse_move_xy'), 'vision')
  assert.equal(groupOf('browser_not_a_tool'), null)
  assert.deepEqual(CAP_GROUPS, ['storage', 'network', 'testing', 'pdf', 'vision', 'devtools'])
})

test('initialize is answered locally with the playwright-mcp identity', async (t) => {
  const { gateway, initialize } = await readyGateway()
  t.after(() => gateway.stop())
  assert.equal(initialize.protocolVersion, '2025-06-18')
  assert.equal(initialize.capabilities.tools.listChanged, true)
  assert.equal(initialize.serverInfo.name, 'playwright-mcp')
  assert.match(initialize.serverInfo.version, /^\d+\.\d+\.\d+/)
})

test('initial tools/list is 13: three meta tools first, then the resident ten', async (t) => {
  const { gateway } = await readyGateway()
  t.after(() => gateway.stop())
  const result = await waitForVisible(gateway, 13)
  assert.equal('nextCursor' in result, false)
  const names = result.tools.map((tool) => tool.name)
  assert.deepEqual(names.slice(0, 3), META_TOOLS)
  assert.deepEqual(names.slice(3), RESIDENT_TOOLS)
  for (const tool of result.tools) assert.equal(tool.inputSchema.type, 'object', `${tool.name} needs an object schema`)
})

test('enabling storage emits tools/list_changed and publishes 30 tools', async (t) => {
  const { gateway } = await readyGateway()
  t.after(() => gateway.stop())
  await waitForVisible(gateway, 13)
  const before = gateway.listChangedCount()
  const result = await gateway.call('tools/call', { name: 'browser_gateway_enable', arguments: { group: 'storage' } })
  const payload = payloadOf(result)
  assert.deepEqual(payload.enabled, ['storage'])
  assert.equal(payload.added.length, 17)
  assert.equal(payload.visible, 30)
  await gateway.waitFor(() => gateway.listChangedCount() > before, 'tools/list_changed')
  const listed = await waitForVisible(gateway, 30)
  const names = listed.tools.map((tool) => tool.name)
  assert.equal(new Set(names).size, 30)
  assert.deepEqual(names.slice(0, 3), META_TOOLS)
  for (const name of GROUPS.storage) assert.ok(names.includes(name), `${name} should be visible`)
  assert.ok(!names.includes('browser_close'), 'core tools stay hidden until core is enabled')
})

test('enabling storage then core reaches 44 tools', async (t) => {
  const { gateway } = await readyGateway()
  t.after(() => gateway.stop())
  await waitForVisible(gateway, 13)
  await gateway.call('tools/call', { name: 'browser_gateway_enable', arguments: { group: 'storage' } })
  await waitForVisible(gateway, 30)
  const result = await gateway.call('tools/call', { name: 'browser_gateway_enable', arguments: { group: 'core' } })
  const payload = payloadOf(result)
  assert.deepEqual(payload.enabled, ['core', 'storage'])
  assert.equal(payload.added.length, 14)
  assert.equal(payload.visible, 44)
  const listed = await waitForVisible(gateway, 44)
  assert.equal(new Set(listed.tools.map((tool) => tool.name)).size, 44)
})

test('an unknown group is rejected with the valid names and changes nothing', async (t) => {
  const { gateway } = await readyGateway()
  t.after(() => gateway.stop())
  await waitForVisible(gateway, 13)
  const before = gateway.listChangedCount()
  const result = await gateway.call('tools/call', { name: 'browser_gateway_enable', arguments: { group: 'bogus' } })
  assert.equal(result.isError, true)
  const text = result.content[0].text
  for (const name of GROUP_NAMES) assert.ok(text.includes(name), `error should mention ${name}`)
  await sleep(150)
  assert.equal(gateway.listChangedCount(), before, 'a rejected enable must not notify')
  await waitForVisible(gateway, 13)
})

test('enabling a group twice is idempotent', async (t) => {
  const { gateway } = await readyGateway()
  t.after(() => gateway.stop())
  await waitForVisible(gateway, 13)
  await gateway.call('tools/call', { name: 'browser_gateway_enable', arguments: { group: 'storage' } })
  await waitForVisible(gateway, 30)
  const before = gateway.listChangedCount()
  const second = payloadOf(await gateway.call('tools/call', { name: 'browser_gateway_enable', arguments: { group: 'storage' } }))
  assert.deepEqual(second.enabled, ['storage'])
  assert.deepEqual(second.added, [])
  assert.equal(second.visible, 30)
  await sleep(150)
  assert.equal(gateway.listChangedCount(), before, 'a repeated enable must not notify')
})

test('browser_gateway_call reaches a tool that is not visible', async (t) => {
  const { gateway } = await readyGateway()
  t.after(() => gateway.stop())
  await waitForVisible(gateway, 13)
  const result = await gateway.call('tools/call', {
    name: 'browser_gateway_call',
    arguments: { tool: 'browser_cookie_list', arguments: { domain: 'example.com' } },
  })
  const forwarded = result
  assert.equal(forwarded.isError, undefined)
  assert.equal(forwarded.structuredContent.tool, 'browser_cookie_list')
  assert.deepEqual(forwarded.structuredContent.arguments, { domain: 'example.com' })
  assert.match(forwarded.content[0].text, /tool=browser_cookie_list/)
  await waitForVisible(gateway, 13)
})

test('a resident tool is forwarded verbatim, image blocks included', async (t) => {
  const { gateway } = await readyGateway()
  t.after(() => gateway.stop())
  await waitForVisible(gateway, 13)
  const screenshot = await gateway.call('tools/call', {
    name: 'browser_take_screenshot',
    arguments: { filename: 'shot.png' },
  })
  assert.equal(screenshot.isError, undefined)
  assert.equal(screenshot.structuredContent.tool, 'browser_take_screenshot')
  assert.equal(screenshot.content.length, 2)
  assert.equal(screenshot.content[1].type, 'image')
  assert.equal(screenshot.content[1].mimeType, 'image/png')
  assert.ok(screenshot.content[1].data.length > 0)
  const navigate = await gateway.call('tools/call', {
    name: 'browser_navigate',
    arguments: { url: 'data:text/html,<p>hi</p>' },
  })
  assert.equal(navigate.structuredContent.tool, 'browser_navigate')
  assert.match(navigate.content[0].text, /data:text\/html/)
})

test('cancellation is translated to the inner request id and the call is dropped', async (t) => {
  const dir = tempDir()
  const logPath = join(dir, 'inner.log')
  const { gateway } = await readyGateway({ env: { FAKE_INNER_LOG: logPath } })
  t.after(async () => {
    await gateway.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  await waitForVisible(gateway, 13)
  gateway.send({
    id: 'cancel-me',
    method: 'tools/call',
    params: { name: 'browser_wait_for', arguments: { delayMs: 400 } },
  })
  const received = await gateway.waitFor(() => {
    if (!existsSync(logPath)) return false
    const events = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    return events.find((event) => event.event === 'call' && event.name === 'browser_wait_for' && event.id !== undefined)
  }, 'the inner to receive the call')
  assert.equal(typeof received.id, 'number', 'the inner sees the gateway id')
  gateway.notify('notifications/cancelled', { requestId: 'cancel-me', reason: 'test' })
  const cancelled = await gateway.waitFor(() => {
    const events = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    return events.find((event) => event.event === 'cancelled')
  }, 'the inner to receive the cancellation')
  assert.equal(cancelled.params.requestId, received.id, 'cancellation carries the inner id, not the client id')
  await sleep(800)
  assert.equal(
    gateway.messages.some((message) => message.id === 'cancel-me'),
    false,
    'a cancelled call must not produce a response',
  )
})

test('an inner crash degrades the gateway but keeps the meta tools', async (t) => {
  const dir = tempDir()
  const marker = join(dir, 'crashed')
  const gateway = startGateway({
    innerArgs: ['--crash-on-call'],
    env: { FAKE_INNER_CRASH_MARKER: marker },
  })
  t.after(async () => {
    await gateway.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  await gateway.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gateway-test', version: '0' } })
  gateway.notify('notifications/initialized')
  await waitForVisible(gateway, 13)
  const failed = await gateway.call('tools/call', { name: 'browser_navigate', arguments: { url: 'data:text/html,x' } })
  assert.equal(failed.isError, true)
  const listed = await waitForVisible(gateway, 3)
  assert.deepEqual(listed.tools.map((tool) => tool.name), META_TOOLS)
  const groups = payloadOf(await gateway.call('tools/call', { name: 'browser_gateway_groups', arguments: {} }))
  assert.equal(groups.status, 'degraded')
  assert.equal(groups.visible, 3)
  assert.deepEqual(groups.resident, [])
  const viaMeta = await gateway.call('tools/call', {
    name: 'browser_gateway_call',
    arguments: { tool: 'browser_navigate', arguments: { url: 'data:text/html,x' } },
  })
  assert.equal(viaMeta.isError, true)
  assert.equal(existsSync(marker), true, 'the fixture should have crashed')
})

test('an extra inner tool is hidden from tools/list and reported as unmapped', async (t) => {
  const { gateway } = await readyGateway({ innerArgs: ['--extra-tool', 'browser_mystery'] })
  t.after(() => gateway.stop())
  const listed = await waitForVisible(gateway, 13)
  assert.ok(!listed.tools.some((tool) => tool.name === 'browser_mystery'))
  const groups = payloadOf(await gateway.call('tools/call', { name: 'browser_gateway_groups', arguments: {} }))
  assert.deepEqual(groups.unmapped, ['browser_mystery'])
  const forwarded = await gateway.call('tools/call', {
    name: 'browser_gateway_call',
    arguments: { tool: 'browser_mystery' },
  })
  assert.equal(forwarded.isError, undefined)
  assert.equal(forwarded.structuredContent.tool, 'browser_mystery')
})

test('an unknown tool is an error with a did-you-mean suggestion', async (t) => {
  const { gateway } = await readyGateway()
  t.after(() => gateway.stop())
  await waitForVisible(gateway, 13)
  const result = await gateway.call('tools/call', { name: 'browser_navigat', arguments: {} })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /Did you mean "browser_navigate"/)
  const viaMeta = await gateway.call('tools/call', {
    name: 'browser_gateway_call',
    arguments: { tool: 'browser_nopethis' },
  })
  assert.equal(viaMeta.isError, true)
})

test('a spawnable failure still answers initialize and lists only the meta tools', async (t) => {
  const gateway = startGateway({ inner: join(HERE, 'fixtures', 'does-not-exist.mjs') })
  t.after(() => gateway.stop())
  const initialize = await gateway.call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'gateway-test', version: '0' },
  })
  assert.equal(initialize.serverInfo.name, 'playwright-mcp')
  gateway.notify('notifications/initialized')
  const listed = await waitForVisible(gateway, 3)
  assert.deepEqual(listed.tools.map((tool) => tool.name), META_TOOLS)
  const failed = await gateway.call('tools/call', { name: 'browser_navigate', arguments: { url: 'data:text/html,x' } })
  assert.equal(failed.isError, true)
  assert.match(failed.content[0].text, /inner Playwright MCP server is (starting|degraded)/)
})
