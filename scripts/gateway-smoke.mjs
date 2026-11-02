#!/usr/bin/env node
/**
 * dsh-browser-live — gateway smoke test against a *real* `@playwright/mcp`.
 *
 * Spawns lib/gateway/server.js with the packaged Playwright MCP CLI in
 * `--browser chrome --headless` mode (an isolated browser started by that
 * server — never the session's CDP endpoint, never the Neko container), then
 * checks the surface a live session would see:
 *
 *   1. initial tools/list: 13 tools (3 meta + 10 resident);
 *   2. enable every group and check the visible count after each step;
 *   3. browser_navigate to a data: URL, browser_snapshot, and a screenshot with
 *      a real image content block;
 *   4. cancel an in-flight browser_wait_for and confirm no response is delivered.
 *
 * If no Chrome/Chromium binary is available the script prints SKIP and exits 0.
 * Everything runs from a throwaway working directory, so no browser profile or
 * output lands in the repo or in ~/.dsh.
 *
 * Usage: node scripts/gateway-smoke.mjs
 */

import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAP_GROUPS, GROUPS, GROUP_NAMES, META_TOOLS, RESIDENT_TOOLS } from '../lib/gateway/catalog.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const GATEWAY = join(REPO, 'lib', 'gateway', 'server.js')
const INNER = join(REPO, 'node_modules', '@playwright', 'mcp', 'cli.js')
const CHROME_CANDIDATES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']

function findChrome() {
  for (const name of CHROME_CANDIDATES) {
    const found = spawnSync('which', [name], { encoding: 'utf8' })
    if (found.status === 0 && found.stdout.trim().length > 0) return found.stdout.trim()
  }
  return null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class Gateway {
  constructor(child) {
    this.child = child
    this.messages = []
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
        this.stderr += `[protocol] non-JSON stdout line: ${text.slice(0, 200)}\n`
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

  waitFor(predicate, label, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.waiters.delete(check)
        clearTimeout(timer)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}\n${this.stderr}`))
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

  call(method, params, timeoutMs = 60_000) {
    const id = this.nextId++
    const response = this.waitFor(
      () => this.messages.find((message) => message.id === id && (message.result !== undefined || message.error !== undefined)),
      `${method} response`,
      timeoutMs,
    )
    this.send({ id, method, params })
    return response.then((message) => {
      if (message.error !== undefined) throw new Error(`${method}: ${JSON.stringify(message.error)}`)
      return message.result
    })
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
    await Promise.race([exited, sleep(5_000)])
    if (!this.closed) {
      this.child.kill('SIGKILL')
      await Promise.race([exited, sleep(1_000)])
    }
  }
}

function fail(message, gateway) {
  console.error(`FAIL ${message}`)
  if (gateway !== undefined) console.error(gateway.stderr.slice(-4_000))
  process.exitCode = 1
}

function toolNames(result) {
  return result.tools.map((tool) => tool.name)
}

function expectedVisible(enabled) {
  return META_TOOLS.length + RESIDENT_TOOLS.length
    + GROUP_NAMES.filter((group) => enabled.has(group)).reduce((total, group) => total + GROUPS[group].length, 0)
}

const chrome = findChrome()
if (chrome === null) {
  console.log('SKIP no Chrome/Chromium binary on PATH; the gateway smoke test needs a local browser')
  process.exit(0)
}

const workDir = mkdtempSync(join(tmpdir(), 'browser-live-gateway-smoke-'))
// Gateway mode always starts the inner server with every capability group
// (provider.js passes the same `--caps`), so group counts are verifiable while
// `--isolated` keeps this browser out of any persistent profile.
// `--no-sandbox` is for CI/containers without a usable Chrome sandbox; the
// browser is still isolated (`--isolated`) and launched by this inner server,
// never connected to the live session's CDP endpoint.
const gateway = new Gateway(spawn(process.execPath, [
  GATEWAY, '--', INNER,
  '--browser', 'chrome', '--headless', '--isolated', '--no-sandbox',
  '--caps', CAP_GROUPS.join(','),
], {
  cwd: workDir,
  // Playwright writes its browser registry under ~/.cache/ms-playwright (it
  // ignores PLAYWRIGHT_BROWSERS_PATH there); point the cache root at the
  // throwaway directory so the smoke never writes to the home dir.
  env: {
    ...process.env,
    XDG_CACHE_HOME: join(workDir, 'cache'),
    PLAYWRIGHT_BROWSERS_PATH: join(workDir, 'playwright-browsers'),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
}))
let passed = 0
let skipped = null
function pass(line) {
  passed += 1
  console.log(`PASS ${line}`)
}

class SkipError extends Error {}

// Chrome cannot start inside some sandboxes (no setuid sandbox, no user/PID
// namespaces). Everything up to the first real launch is still exercised; the
// launch failure is an environment limitation, not a gateway defect, so the
// browser phase is skipped instead of reported as a regression.
const LAUNCH_FAILURE = /Failed to launch|Zygote process|setuid sandbox|Operation not permitted|Cannot connect to Chrome|error while loading shared libraries|Missing X server/i

function isLaunchFailure(result) {
  if (result.isError !== true) return false
  return LAUNCH_FAILURE.test(String(result.content?.[0]?.text ?? ''))
}

try {
  const initialize = await gateway.call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'gateway-smoke', version: '0.0.0' },
  })
  if (initialize.serverInfo?.name !== 'playwright-mcp') throw new Error(`unexpected serverInfo ${JSON.stringify(initialize.serverInfo)}`)
  gateway.send({ method: 'notifications/initialized' })
  pass(`initialize (protocol ${initialize.protocolVersion}, ${initialize.serverInfo.name} ${initialize.serverInfo.version})`)

  // The inner handshake against a real @playwright/mcp is async; poll until it
  // is cached. No browser is launched yet: tools/list is pure registration.
  let listed = null
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    listed = await gateway.call('tools/list', {})
    if (listed.tools.length === 13) break
    await sleep(100)
  }
  const initial = toolNames(listed)
  if (initial.length !== 13) throw new Error(`expected 13 tools, got ${initial.length}: ${initial.join(', ')}`)
  if (initial.slice(0, 3).join(',') !== META_TOOLS.join(',')) throw new Error(`meta tools are not first: ${initial.slice(0, 3).join(', ')}`)
  if (initial.slice(3).join(',') !== RESIDENT_TOOLS.join(',')) throw new Error(`resident tools differ: ${initial.slice(3).join(', ')}`)
  pass(`initial tools/list: ${initial.length} (3 meta + 10 resident)`)

  const enabled = new Set()
  for (const group of GROUP_NAMES) {
    const result = await gateway.call('tools/call', { name: 'browser_gateway_enable', arguments: { group } })
    if (result.isError === true) throw new Error(`enable ${group}: ${result.content[0].text}`)
    const payload = JSON.parse(result.content[0].text)
    enabled.add(group)
    const expected = expectedVisible(enabled)
    const next = await gateway.call('tools/list', {})
    if (next.tools.length !== expected || payload.visible !== expected) {
      throw new Error(`after enabling ${group}: expected ${expected} tools, payload ${payload.visible}, list ${next.tools.length}`)
    }
    pass(`enable ${group}: +${payload.added.length} tools, ${next.tools.length} visible`)
  }

  // The whole Playwright surface must now be visible: 70 inner tools + 3 meta.
  const all = await gateway.call('tools/list', {})
  if (all.tools.length !== 70 + META_TOOLS.length) throw new Error(`expected 73 tools with every group, got ${all.tools.length}`)
  pass(`all six groups: ${all.tools.length} tools (70 inner + 3 meta)`)

  const url = 'data:text/html,<title>gateway-smoke</title><h1>browser-live gateway smoke</h1>'
  const navigated = await gateway.call('tools/call', { name: 'browser_navigate', arguments: { url } })
  if (isLaunchFailure(navigated)) {
    const text = String(navigated.content?.[0]?.text ?? '')
    const reason = text.split('\n').find((line) => LAUNCH_FAILURE.test(line)) ?? text.slice(0, 200)
    throw new SkipError(`Chrome cannot launch in this environment: ${reason.trim()}`)
  }
  if (navigated.isError === true) throw new Error(`navigate failed: ${navigated.content?.[0]?.text}`)
  pass('browser_navigate to a data: URL')

  const snapshot = await gateway.call('tools/call', { name: 'browser_snapshot', arguments: {} })
  if (snapshot.isError === true) throw new Error(`snapshot failed: ${snapshot.content?.[0]?.text}`)
  const snapshotText = JSON.stringify(snapshot.content ?? '')
  if (!snapshotText.includes('browser-live gateway smoke')) throw new Error('snapshot does not contain the page heading')
  pass('browser_snapshot returns the page content')

  const screenshot = await gateway.call('tools/call', { name: 'browser_take_screenshot', arguments: {} })
  const image = (screenshot.content ?? []).find((block) => block.type === 'image')
  if (screenshot.isError === true || image === undefined) throw new Error(`screenshot has no image block: ${JSON.stringify(screenshot.content?.[0] ?? null)}`)
  pass(`browser_take_screenshot returns an image block (${image.mimeType})`)

  // Cancellation: a wait_for with a long timeout is forwarded, then cancelled.
  // The gateway must translate the id (inner ids are numbers) and drop the late
  // response; the cancelled id must never appear on the client side.
  const cancelId = 'smoke-cancel'
  gateway.send({ id: cancelId, method: 'tools/call', params: { name: 'browser_wait_for', arguments: { time: 5 } } })
  await sleep(300)
  gateway.send({ method: 'notifications/cancelled', params: { requestId: cancelId, reason: 'smoke' } })
  await sleep(7_000)
  if (gateway.messages.some((message) => message.id === cancelId)) throw new Error('the cancelled call produced a response')
  pass('browser_wait_for cancellation is forwarded and the response is dropped')

  // The gateway must still serve calls after a cancellation.
  const after = await gateway.call('tools/call', { name: 'browser_snapshot', arguments: {} })
  if (after.isError === true) throw new Error('the gateway stopped serving after a cancellation')
  pass('the gateway still serves calls after a cancellation')
} catch (error) {
  if (error instanceof SkipError) {
    skipped = error.message
    console.log(`SKIP ${error.message}`)
  } else {
    fail(error.message, gateway)
  }
} finally {
  await gateway.stop()
  rmSync(workDir, { recursive: true, force: true })
}

if (skipped !== null) {
  console.log(`SKIP gateway smoke: ${passed} tool-surface checks passed; browser phase not exercised`)
} else if (process.exitCode === 1) {
  console.error(`gateway smoke failed after ${passed} checks`)
} else {
  console.log(`OK gateway smoke: ${passed} checks passed`)
}
