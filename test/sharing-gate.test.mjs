/**
 * dsh-browser-live — sharing gate tests.
 *
 * The gate is the single listener in front of every browser tool path. These
 * tests pin that it runs before the tool body, that it needs a live agent (not
 * caller-supplied scope), and that a disabled deployment fails closed.
 *
 * Run with `node --test test/sharing-gate.test.mjs`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createSharingGate } from '../lib/sharing/gate.js'
import { createScopeResolver } from '../lib/sharing/scope.js'

const agent = (id) => ({ session: { id } })
const exec = (name, args, who = agent('s-1')) => ({ name, arguments: args, agent: who })

test('a disabled deployment refuses every browser tool call', async () => {
  const gate = createSharingGate({ resolver: createScopeResolver({ enabled: false }) })
  let ran = false
  await assert.rejects(
    () => gate(exec('browser_live_open', { url: 'https://example.test' }), async () => { ran = true }),
    /sharing scope denied/,
  )
  assert.equal(ran, false, 'the tool body must not run')
})

test('an enabled deployment lets a member through and runs the body', async () => {
  const gate = createSharingGate({ resolver: createScopeResolver({ enabled: true }) })
  const result = await gate(exec('browser_live_open', { url: 'https://example.test' }), async () => 'ran')
  assert.equal(result, 'ran')
})

test('non-browser tools are never classified or gated', async () => {
  const gate = createSharingGate({ resolver: createScopeResolver({ enabled: false }) })
  const result = await gate(exec('bash', { command: 'ls' }), async () => 'ran')
  assert.equal(result, 'ran')
})

test('the caller cannot pass its own scope through arguments', async () => {
  const gate = createSharingGate({ resolver: createScopeResolver({ enabled: true, members: ['s-1'] }) })
  await assert.rejects(
    () => gate(exec('browser_live_open', { url: 'https://x.test', scopeId: 'other' }, agent('s-2')), async () => 'ran'),
    /not in the trusted group/,
  )
})

test('a call without a live agent is refused before the body', async () => {
  const gate = createSharingGate({ resolver: createScopeResolver({ enabled: true }) })
  await assert.rejects(() => gate(exec('browser_live_status', {}, null), async () => 'ran'), /not a live session/)
})

test('the gateway path is judged by the inner tool, not by its wrapper name', async () => {
  const resolver = createScopeResolver({ enabled: true, allowCredentials: false })
  const gate = createSharingGate({ resolver })
  const navigate = exec('mcp__playwright-mcp__browser_gateway_call', { tool: 'browser_navigate', arguments: { url: 'https://x.test' } })
  assert.equal(await gate(navigate, async () => 'ran'), 'ran')
  const cookies = exec('mcp__playwright-mcp__browser_gateway_call', { tool: 'browser_cookie_list', arguments: {} })
  await assert.rejects(() => gate(cookies, async () => 'leaked'), /credential access is not granted/)
})

test('nested gateway meta tools are refused even for a fully granted member', async () => {
  const gate = createSharingGate({ resolver: createScopeResolver({ enabled: true, allowCredentials: true }) })
  for (const inner of ['browser_gateway_call', 'browser_gateway_enable', 'browser_gateway_groups']) {
    await assert.rejects(
      () => gate(exec('mcp__playwright-mcp__browser_gateway_call', { tool: inner, arguments: {} }), async () => 'ran'),
      /cannot nest/,
    )
  }
})

test('the gate refuses a malformed registration instead of failing open', async () => {
  assert.throws(() => createSharingGate({}), /requires a scope resolver/)
})
