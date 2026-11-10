/**
 * dsh-browser-live — sharing policy tests (P0 G-2).
 *
 * The gateway indirection is the one path where the tool the model names is not
 * the tool that runs: `browser_gateway_call` carries the real name in
 * `arguments.tool`. These tests pin that the policy classifies the *inner* tool,
 * refuses nesting, and treats credential tools as a separate grant.
 *
 * Run with `node --test test/sharing-policy.test.mjs`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CREDENTIAL_TOOL_NAMES,
  SharingDeniedError,
  authorizeCall,
  classifyToolCall,
} from '../lib/sharing/policy.js'

test('a native tool is classified as native', () => {
  const call = classifyToolCall('browser_live_open', { url: 'https://example.test' })
  assert.equal(call.kind, 'native')
  assert.equal(call.innerTool, 'browser_live_open')
  assert.equal(call.credential, false)
  assert.equal(call.malformed, null)
})

test('a direct MCP tool is classified by its inner name', () => {
  const call = classifyToolCall('mcp__playwright-mcp__browser_cookie_list', { domain: 'example.test' })
  assert.equal(call.kind, 'mcp')
  assert.equal(call.innerTool, 'browser_cookie_list')
  assert.equal(call.credential, true)
})

test('gateway_call is classified by the tool it wraps, not by its own name', () => {
  const call = classifyToolCall('mcp__playwright-mcp__browser_gateway_call', {
    tool: 'browser_cookie_list',
    arguments: { domain: 'example.test' },
  })
  assert.equal(call.kind, 'gateway')
  assert.equal(call.innerTool, 'browser_cookie_list')
  assert.deepEqual(call.innerArgs, { domain: 'example.test' })
  assert.equal(call.credential, true)
})

test('gateway_call without a tool name is malformed and refused', () => {
  const call = classifyToolCall('mcp__playwright-mcp__browser_gateway_call', {})
  assert.equal(call.malformed !== null, true)
  assert.throws(() => authorizeCall(call, { member: true, allowCredentials: true }), SharingDeniedError)
})

test('gateway_call cannot nest a gateway meta tool', () => {
  for (const inner of ['browser_gateway_call', 'browser_gateway_enable', 'browser_gateway_groups']) {
    const call = classifyToolCall('mcp__playwright-mcp__browser_gateway_call', { tool: inner, arguments: {} })
    assert.match(call.malformed ?? '', /cannot nest the gateway meta tool/)
    assert.throws(() => authorizeCall(call, { member: true, allowCredentials: true }), /cannot nest/)
  }
})

test('a non-member is refused on every browser path, whatever the tool', () => {
  for (const [name, args] of [
    ['browser_live_open', { url: 'https://example.test' }],
    ['mcp__playwright-mcp__browser_navigate', { url: 'https://example.test' }],
    ['mcp__playwright-mcp__browser_gateway_call', { tool: 'browser_navigate', arguments: { url: 'https://example.test' } }],
  ]) {
    assert.throws(() => authorizeCall(classifyToolCall(name, args), { member: false }), /not in a trusted sharing scope/)
  }
})

test('a member without the credential grant can browse but not read cookies', () => {
  const browse = classifyToolCall('browser_live_open', { url: 'https://example.test' })
  assert.deepEqual(authorizeCall(browse, { member: true }), { allowed: true })
  const cookies = classifyToolCall('mcp__playwright-mcp__browser_gateway_call', { tool: 'browser_cookie_list', arguments: {} })
  assert.throws(() => authorizeCall(cookies, { member: true }), /credential access is not granted/)
  assert.deepEqual(authorizeCall(cookies, { member: true, allowCredentials: true }), { allowed: true })
})

test('the credential set covers the login-state tool and every storage tool', () => {
  for (const name of ['browser_live_state', 'browser_cookie_list', 'browser_localstorage_get', 'browser_sessionstorage_set', 'browser_storage_state']) {
    assert.equal(CREDENTIAL_TOOL_NAMES.has(name), true, `${name} should be privileged`)
  }
})

test('unrelated tools are left alone', () => {
  const call = classifyToolCall('bash', { command: 'ls' })
  assert.equal(call.kind, 'other')
  assert.deepEqual(authorizeCall(call, { member: false }), { allowed: true })
})

test('the denial never echoes credentials from the arguments', () => {
  const call = classifyToolCall('mcp__playwright-mcp__browser_cookie_set', {
    cookie: { name: 'sessionid', value: 'SUPER_SECRET_VALUE' },
  })
  try {
    authorizeCall(call, { member: true })
    assert.fail('expected a denial')
  } catch (error) {
    assert.equal(String(error.message).includes('SUPER_SECRET_VALUE'), false)
  }
})
