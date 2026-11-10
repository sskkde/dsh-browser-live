/**
 * dsh-browser-live — provider admission-gate tests.
 *
 * The gate used to refuse every `mcp__playwright-mcp__*` call unless the
 * session was registered `ready`, which turned one lost spawn or one provider
 * reload into a session that could never use its browser again. It now retries
 * acquisition, backs off after a failure, and still refuses a call that comes
 * from a stale agent.
 *
 * Run with `node --test "test/**\/*.test.mjs"`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RETRY_AFTER_FAILURE_MS, admissionDecision, admitBrowserTool } from '../lib/provider.js'

test('a ready registration needs no work', () => {
  assert.deepEqual(admissionDecision({ status: 'ready' }, 1_000), { action: 'ready' })
})

test('an unregistered session retries instead of being refused', () => {
  assert.deepEqual(admissionDecision(undefined, 1_000), { action: 'retry' })
  assert.deepEqual(admissionDecision(null, 1_000), { action: 'retry' })
  assert.deepEqual(admissionDecision({}, 1_000), { action: 'retry' })
})

test('a recent failure backs off and reports the remaining wait', () => {
  const now = 1_000_000
  const decision = admissionDecision({ status: 'failed', error: 'spawn ENOENT', at: now - 5_000 }, now)
  assert.equal(decision.action, 'backoff')
  assert.equal(decision.waitMs, RETRY_AFTER_FAILURE_MS - 5_000)
})

test('a failure at the backoff boundary retries', () => {
  const now = 1_000_000
  assert.deepEqual(admissionDecision({ status: 'failed', at: now - RETRY_AFTER_FAILURE_MS }, now), { action: 'retry' })
  assert.deepEqual(admissionDecision({ status: 'failed', at: now - RETRY_AFTER_FAILURE_MS - 1 }, now), { action: 'retry' })
})

test('a failure recorded without a timestamp retries immediately', () => {
  assert.deepEqual(admissionDecision({ status: 'failed' }, 1_000), { action: 'retry' })
})

/** A fake activation source that records how often it was asked for a server. */
function fakeResources({ available = true, fail } = {}) {
  const calls = []
  return {
    calls,
    available: () => available,
    get: async (agent, signal) => {
      calls.push({ agent, signal })
      if (fail !== undefined) throw fail
      return { ok: true }
    },
  }
}

test('a ready registration proceeds without acquiring anything', async () => {
  const agent = { session: { id: 's1' } }
  const clients = new Map([[agent, { status: 'ready' }]])
  const resources = fakeResources()
  await admitBrowserTool(agent, undefined, { clients, resources, disposing: false })
  assert.equal(resources.calls.length, 0)
})

test('an unregistered session re-acquires its server and then proceeds', async () => {
  const agent = { session: { id: 's1' } }
  const signal = new AbortController().signal
  const clients = new Map()
  const resources = fakeResources()
  await admitBrowserTool(agent, signal, { clients, resources, disposing: false })
  assert.equal(resources.calls.length, 1)
  assert.equal(resources.calls[0].agent, agent)
  assert.equal(resources.calls[0].signal, signal)
  assert.deepEqual(clients.get(agent), { status: 'ready' })
})

test('a failed re-acquisition surfaces the underlying reason instead of a generic refusal', async () => {
  const agent = { session: { id: 's1' } }
  const clients = new Map()
  const resources = fakeResources({ fail: new Error('spawn playwright-mcp ENOENT') })
  await assert.rejects(
    () => admitBrowserTool(agent, undefined, { clients, resources, disposing: false }),
    /cannot start this session's browser server: spawn playwright-mcp ENOENT/,
  )
  const state = clients.get(agent)
  assert.equal(state.status, 'failed')
  assert.equal(state.error, 'spawn playwright-mcp ENOENT')
  assert.ok(Number.isFinite(state.at))
})

test('a recent failure backs off without spawning again, and says why', async () => {
  const agent = { session: { id: 's1' } }
  const clients = new Map([[agent, { status: 'failed', error: 'spawn ENOENT', at: Date.now() }]])
  const resources = fakeResources()
  await assert.rejects(
    () => admitBrowserTool(agent, undefined, { clients, resources, disposing: false }),
    /failed to start \(spawn ENOENT\); next retry in \d+s/,
  )
  assert.equal(resources.calls.length, 0)
})

test('a cancelled call rethrows its own abort and leaves the registration alone', async () => {
  const agent = { session: { id: 's1' } }
  const controller = new AbortController()
  controller.abort(new Error('cancelled by the user'))
  const clients = new Map()
  const resources = fakeResources({ fail: new Error('cancelled by the user') })
  await assert.rejects(
    () => admitBrowserTool(agent, controller.signal, { clients, resources, disposing: false }),
    /cancelled by the user/,
  )
  assert.equal(clients.size, 0)
})

test('a stale agent is named instead of spawning a second server', async () => {
  const agent = { session: { id: 's1' } }
  const clients = new Map()
  const resources = fakeResources({ available: false })
  await assert.rejects(
    () => admitBrowserTool(agent, undefined, { clients, resources, disposing: false }),
    /stale agent for session s1/,
  )
  assert.equal(resources.calls.length, 0)
})

test('a disposing provider and a missing agent are refused precisely', async () => {
  const agent = { session: { id: 's1' } }
  await assert.rejects(
    () => admitBrowserTool(agent, undefined, { clients: new Map(), resources: undefined, disposing: false }),
    /browser provider is shutting down/,
  )
  await assert.rejects(
    () => admitBrowserTool(undefined, undefined, { clients: new Map(), resources: fakeResources(), disposing: false }),
    /require a live session/,
  )
})
