#!/usr/bin/env node
/**
 * dsh-browser-live — gateway transport sweep over *every* advertised tool.
 *
 * The design's acceptance criterion (§8) is a transport-layer sweep: for all
 * tools the gateway advertises once every capability group is enabled, a
 * `tools/call` with empty arguments must come back as *something* the inner
 * `@playwright/mcp` produced (a result or an inner error) and never as a
 * gateway-level routing failure. Argument validation happens inside the inner
 * server, so an empty-argument error is a PASS; the only FAIL is a response
 * whose text starts with `browser-live gateway:` (plus JSON-RPC errors, and a
 * tool missing from the advertised list entirely).
 *
 * Runs exactly like gateway-smoke.mjs: its own headless Chrome, a throwaway
 * working directory, no session CDP endpoint, no state under ~/.dsh. Every
 * slow tool is capped at SWEEP_TIMEOUT_MS so the sweep stays bounded.
 *
 * Usage: node scripts/gateway-sweep.mjs
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
const SWEEP_TIMEOUT_MS = 3_000
const GATEWAY_ERROR_PREFIX = 'browser-live gateway:'
/**
 * The three meta tools are the gateway's own surface, so their empty-argument
 * validation is a *local* answer, not a routing failure: the two that need
 * arguments are expected to reject `{}` with the gateway's own message.
 */
const META_VALIDATION = {
  browser_gateway_groups: /^(?!browser-live gateway:)/,
  browser_gateway_enable: /requires a "group" string/,
  browser_gateway_call: /requires a "tool" string/,
}

function findChrome() {
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = spawnSync('which', [name], { encoding: 'utf8' })
    if (found.status === 0 && found.stdout.trim().length > 0) return found.stdout.trim()
  }
  return null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
      try {
        this.messages.push(JSON.parse(text))
      } catch {
        this.stderr += `[protocol] non-JSON stdout line: ${text.slice(0, 200)}\n`
      }
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

  send(message) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  call(method, params, timeoutMs = 60_000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check)
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${method} response\n${this.stderr.slice(-2_000)}`))
      }, timeoutMs)
      const check = () => {
        const message = this.messages.find((entry) => entry.id === id)
        if (message === undefined) return
        this.waiters.delete(check)
        clearTimeout(timer)
        if (message.error !== undefined) reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
        else resolve(message.result)
      }
      this.waiters.add(check)
      this.send({ id, method, params })
      check()
    })
  }
}

/** tools/call that resolves even when no response arrives inside the cap. */
function sweepCall(gateway, name) {
  const id = gateway.nextId++
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      gateway.waiters.delete(check)
      resolve({ kind: 'timeout' })
    }, SWEEP_TIMEOUT_MS)
    const check = () => {
      const message = gateway.messages.find((entry) => entry.id === id)
      if (message === undefined) return
      gateway.waiters.delete(check)
      clearTimeout(timer)
      if (message.error !== undefined) {
        resolve({ kind: 'rpc-error', text: JSON.stringify(message.error) })
        return
      }
      const result = message.result ?? {}
      const text = String(result.content?.[0]?.text ?? '')
      resolve({ kind: result.isError === true ? 'tool-error' : 'result', text })
    }
    gateway.waiters.add(check)
    gateway.send({ id, method: 'tools/call', params: { name, arguments: {} } })
    check()
  })
}

const chrome = findChrome()
if (chrome === null) {
  console.log('SKIP no Chrome/Chromium binary on PATH; the gateway sweep needs a local browser')
  process.exit(0)
}

const workDir = mkdtempSync(join(tmpdir(), 'browser-live-gateway-sweep-'))
const gateway = new Gateway(spawn(process.execPath, [
  GATEWAY, '--', INNER,
  '--browser', 'chrome', '--headless', '--isolated', '--no-sandbox',
  '--caps', CAP_GROUPS.join(','),
], {
  cwd: workDir,
  env: {
    ...process.env,
    XDG_CACHE_HOME: join(workDir, 'cache'),
    PLAYWRIGHT_BROWSERS_PATH: join(workDir, 'playwright-browsers'),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
}))

const counts = { result: 0, 'tool-error': 0, meta: 0, timeout: 0 }
const failures = []
const timeouts = []

try {
  await gateway.call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'gateway-sweep', version: '0.0.0' },
  })
  gateway.send({ method: 'notifications/initialized' })

  // Wait for the inner handshake (tools/list is pure registration; no browser).
  let listed = null
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    listed = await gateway.call('tools/list', {})
    if (listed.tools.length === META_TOOLS.length + RESIDENT_TOOLS.length) break
    await sleep(100)
  }

  for (const group of GROUP_NAMES) {
    const enabled = await gateway.call('tools/call', {
      name: 'browser_gateway_enable',
      arguments: { group },
    })
    if (enabled.isError === true) throw new Error(`enable ${group}: ${enabled.content[0].text}`)
  }

  listed = await gateway.call('tools/list', {})
  const advertised = listed.tools.map((tool) => tool.name)
  const expected = [
    ...META_TOOLS,
    ...RESIDENT_TOOLS,
    ...GROUP_NAMES.flatMap((group) => GROUPS[group]),
  ]
  for (const name of expected) {
    if (!advertised.includes(name)) failures.push(`${name}: not advertised after enabling every group`)
  }
  console.log(`advertised ${advertised.length} tools (expected ${expected.length})`)

  // `browser_close` is the only tool that removes the page every later call
  // depends on, so sweep it last.
  const sweepOrder = [...advertised.filter((name) => name !== 'browser_close'), 'browser_close']
  for (const name of sweepOrder) {
    const outcome = await sweepCall(gateway, name)
    if (outcome.kind === 'timeout') {
      counts.timeout += 1
      timeouts.push(name)
      console.log(`TIMEOUT ${name} (no response in ${SWEEP_TIMEOUT_MS}ms; inner call still pending)`)
      continue
    }
    if (outcome.kind === 'rpc-error') {
      failures.push(`${name}: JSON-RPC error ${outcome.text}`)
      console.log(`FAIL ${name}: JSON-RPC error ${outcome.text}`)
      continue
    }
    if (META_VALIDATION[name] !== undefined) {
      if (!META_VALIDATION[name].test(outcome.text)) {
        failures.push(`${name}: unexpected meta answer ${outcome.text}`)
        console.log(`FAIL ${name}: ${outcome.text}`)
        continue
      }
      counts.meta += 1
      console.log(`PASS ${name} (meta validation)`)
      continue
    }
    if (outcome.text.startsWith(GATEWAY_ERROR_PREFIX)) {
      failures.push(`${name}: ${outcome.text}`)
      console.log(`FAIL ${name}: ${outcome.text}`)
      continue
    }
    counts[outcome.kind] += 1
    console.log(`PASS ${name} (${outcome.kind})`)
  }
} catch (error) {
  failures.push(`sweep aborted: ${error.message}`)
  console.error(`FAIL ${error.message}`)
  console.error(gateway.stderr.slice(-4_000))
} finally {
  try {
    gateway.child.stdin.end()
    gateway.child.kill('SIGTERM')
  } catch {
    // already gone
  }
  await sleep(500)
  try {
    gateway.child.kill('SIGKILL')
  } catch {
    // already gone
  }
  rmSync(workDir, { recursive: true, force: true })
}

console.log(`summary: result ${counts.result}, tool-error ${counts["tool-error"]}, meta ${counts.meta}, timeout ${counts.timeout}, failures ${failures.length}`)
if (timeouts.length > 0) console.log(`timeouts: ${timeouts.join(', ')}`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`FAILURE ${failure}`)
  process.exitCode = 1
} else {
  console.log('SWEEP PASS')
}
