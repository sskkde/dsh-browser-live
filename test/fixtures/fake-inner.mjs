#!/usr/bin/env node
/**
 * dsh-browser-live — fake inner MCP server for gateway tests.
 *
 * A stdio, newline-delimited JSON-RPC 2.0 server that plays the role of
 * `@playwright/mcp` without launching a browser. It publishes a catalog made of
 * the gateway's resident tools, the `core` group and the `storage` group, in two
 * paginated `tools/list` pages, and echoes every `tools/call` back as a text
 * block plus `structuredContent`.
 *
 * Modes (argv, after the script name):
 *   --extra-tool <name>   publish one additional tool the gateway catalog does
 *                         not know (it must stay hidden, and be reported as
 *                         `unmapped`).
 *   --crash-on-call       exit(1) on the first `tools/call`. A marker file
 *                         (FAKE_INNER_CRASH_MARKER) makes every later instance
 *                         exit at startup too, so a respawn cannot recover and
 *                         tests see a stable degraded gateway.
 *
 * Env:
 *   FAKE_INNER_LOG           append one JSON line per interesting event
 *                            (`call`, `cancelled`) to this file.
 *   FAKE_INNER_CRASH_MARKER  see --crash-on-call.
 *
 * Observations also go to stderr with the `[fake-inner]` prefix. stdout carries
 * JSON-RPC only.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { GROUPS, RESIDENT_TOOLS } from '../../lib/gateway/catalog.js'

const argv = process.argv.slice(2)
const extraTools = []
let crashOnCall = false
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--extra-tool' && index + 1 < argv.length) {
    extraTools.push(argv[index + 1])
    index += 1
    continue
  }
  if (arg === '--crash-on-call') crashOnCall = true
}

const logPath = process.env.FAKE_INNER_LOG ?? ''
const crashMarker = process.env.FAKE_INNER_CRASH_MARKER ?? ''

function record(entry) {
  const line = JSON.stringify(entry)
  if (logPath.length > 0) {
    try {
      appendFileSync(logPath, `${line}\n`)
    } catch {
      // best effort: the stderr line still carries the event
    }
  }
  process.stderr.write(`[fake-inner] ${line}\n`)
}

if (crashMarker.length > 0) {
  try {
    readFileSync(crashMarker)
    process.stderr.write('[fake-inner] crash marker present; refusing to start\n')
    process.exit(1)
  } catch {
    // no marker yet: normal start
  }
}

/** The tool catalog, in publication order. */
const TOOL_NAMES = [...RESIDENT_TOOLS, ...GROUPS.core, ...GROUPS.storage, ...extraTools]
const PAGE_SIZE = 20

function toolDefinition(name) {
  return {
    name,
    description: `Fake ${name} published by test/fixtures/fake-inner.mjs.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  }
}

function write(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  } catch {
    process.exit(0)
  }
}

function respond(id, result) {
  write({ jsonrpc: '2.0', id, result })
}

function handleCall(id, params) {
  const name = typeof params?.name === 'string' ? params.name : ''
  const args = params?.arguments !== null && typeof params?.arguments === 'object' ? params.arguments : {}
  record({ event: 'call', id, name, args })
  if (crashOnCall) {
    if (crashMarker.length > 0) {
      try {
        writeFileSync(crashMarker, `${Date.now()}\n`)
      } catch {
        // the exit itself is what the test relies on
      }
    }
    process.stderr.write('[fake-inner] crashing on tools/call\n')
    process.exit(1)
  }
  const delayMs = typeof args.delayMs === 'number' && args.delayMs > 0 ? args.delayMs : 0
  const reply = () => {
    const text = `tool=${name} args=${JSON.stringify(args)}`
    if (name === 'browser_take_screenshot') {
      respond(id, {
        content: [
          { type: 'text', text },
          {
            type: 'image',
            // 1x1 transparent PNG
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            mimeType: 'image/png',
          },
        ],
        structuredContent: { tool: name, arguments: args },
      })
      return
    }
    respond(id, { content: [{ type: 'text', text }], structuredContent: { tool: name, arguments: args } })
  }
  if (delayMs > 0) setTimeout(reply, delayMs)
  else reply()
}

function handle(message) {
  if (message === null || typeof message !== 'object') return
  const id = message.id
  switch (message.method) {
    case 'initialize':
      respond(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'fake-inner', version: '0.0.0' },
      })
      return
    case 'notifications/initialized':
      return
    case 'ping':
      respond(id, {})
      return
    case 'tools/list': {
      const offset = Number(message.params?.cursor ?? 0)
      const start = Number.isFinite(offset) && offset > 0 ? offset : 0
      const page = TOOL_NAMES.slice(start, start + PAGE_SIZE).map(toolDefinition)
      const next = start + PAGE_SIZE < TOOL_NAMES.length ? String(start + PAGE_SIZE) : undefined
      respond(id, next === undefined ? { tools: page } : { tools: page, nextCursor: next })
      return
    }
    case 'tools/call':
      handleCall(id, message.params)
      return
    case 'notifications/cancelled':
      record({ event: 'cancelled', params: message.params ?? {} })
      return
    default:
      if (id !== undefined && id !== null) {
        write({ jsonrpc: '2.0', id, error: { code: -32601, message: `fake-inner: ${message.method} is not supported` } })
      }
  }
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
reader.on('line', (line) => {
  const text = line.trim()
  if (text.length === 0) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    process.stderr.write(`[fake-inner] dropping malformed line: ${text.slice(0, 120)}\n`)
    return
  }
  handle(message)
})
reader.on('close', () => process.exit(0))
