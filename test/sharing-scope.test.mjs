/**
 * dsh-browser-live — scope resolver tests.
 *
 * Run with `node --test test/sharing-scope.test.mjs`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SCOPE_ID, ScopeDeniedError, createScopeResolver } from '../lib/sharing/scope.js'

const agent = (id) => ({ session: { id } })

test('disabled sharing resolves nobody', () => {
  const resolver = createScopeResolver({ enabled: false })
  assert.equal(resolver.isMember('s-1'), false)
  assert.throws(() => resolver.scopeFor(agent('s-1')), ScopeDeniedError)
})

test('all-sessions mode admits a top-level session and a subagent alike', () => {
  const resolver = createScopeResolver({ enabled: true })
  assert.deepEqual(resolver.scopeFor(agent('session-a')), { scopeId: DEFAULT_SCOPE_ID, member: true, allowCredentials: true })
  assert.deepEqual(resolver.scopeFor({ ...agent('sub-1'), session: { id: 'sub-1', parent: 'session-a' } }), {
    scopeId: DEFAULT_SCOPE_ID,
    member: true,
    allowCredentials: true,
  })
})

test('an explicit member list narrows the group without changing call sites', () => {
  const resolver = createScopeResolver({ enabled: true, members: ['session-a'] })
  assert.equal(resolver.isMember('session-a'), true)
  assert.equal(resolver.isMember('session-b'), false)
  assert.throws(() => resolver.scopeFor(agent('session-b')), /not in the trusted group/)
})

test('scope comes from the live agent, not from anything the caller can pass', () => {
  const resolver = createScopeResolver({ enabled: true })
  // An agent object cannot smuggle a scope: only its session id is consulted.
  const call = resolver.scopeFor({ session: { id: 's-1' }, scopeId: 'other', user: 'admin' })
  assert.equal(call.scopeId, DEFAULT_SCOPE_ID)
})

test('anonymous callers and missing session ids are refused with a reason', () => {
  const resolver = createScopeResolver({ enabled: true })
  assert.throws(() => resolver.scopeFor(undefined), /not a live session/)
  assert.throws(() => resolver.scopeFor({ session: {} }), /not a live session/)
  assert.throws(() => resolver.scopeFor(agent('')), ScopeDeniedError)
})

test('credentials can be withheld from the whole scope', () => {
  const resolver = createScopeResolver({ enabled: true, allowCredentials: false })
  assert.deepEqual(resolver.scopeFor(agent('s-1')), { scopeId: DEFAULT_SCOPE_ID, member: true, allowCredentials: false })
})

test('describe reports the operator-visible configuration', () => {
  assert.deepEqual(createScopeResolver({ enabled: true }).describe(), {
    enabled: true,
    scopeId: DEFAULT_SCOPE_ID,
    allowCredentials: true,
    members: 'all-sessions',
  })
})
