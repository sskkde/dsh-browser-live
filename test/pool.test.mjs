/**
 * dsh-browser-live — pool policy tests.
 *
 * These cover the pure half of the P1 pool change: version-1 map migration that
 * retires the shared legacy container, slot port blocks that never collide with
 * it, and the reclaim rules (LRU only, never a leased/busy/deleting slot).
 *
 * Run with `node --test test/pool.test.mjs`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BrowserLiveCapacityError,
  MAP_VERSION,
  POOL_PORTS,
  expiredSessions,
  migrateMap,
  pickEvictionCandidate,
  poolPorts,
} from '../lib/service.js'

const entry = (over = {}) => ({
  slot: 1,
  legacy: false,
  short: 'abcd1234',
  container: 'neko-abcd1234',
  volume: 'neko-profile-abcd1234',
  cdpPort: 9301,
  webPort: 8302,
  publicPath: '/browser/abcd1234',
  createdAt: 1,
  lastUsed: 1,
  ...over,
})

test('a version-1 legacy entry is retired, not adopted and not deleted', () => {
  const map = migrateMap({
    version: 1,
    sessions: {
      'session-legacy': entry({ slot: 0, legacy: true, container: 'neko', volume: 'neko-profile', cdpPort: 9222 }),
      'session-a': entry(),
    },
  }, 1_000)
  assert.equal(map.version, MAP_VERSION)
  assert.deepEqual(Object.keys(map.sessions), ['session-a'])
  assert.equal(map.retired.length, 1)
  assert.equal(map.retired[0].container, 'neko')
  assert.equal(map.retired[0].sessionId, 'session-legacy')
  assert.equal(map.retired[0].retiredAt, 1_000)
})

test('a legacy entry is recognised by container name even without the flag', () => {
  const map = migrateMap({ version: 1, sessions: { s: entry({ legacy: undefined, container: 'neko' }) } })
  assert.equal(Object.keys(map.sessions).length, 0)
  assert.equal(map.retired.length, 1)
})

test('pool entries gain a generation and an active state; deleting survives', () => {
  const map = migrateMap({
    version: 1,
    sessions: { a: entry(), b: entry({ state: 'deleting', lastError: 'docker rm failed' }) },
  })
  assert.equal(map.sessions.a.generation, 1)
  assert.equal(map.sessions.a.state, 'active')
  assert.equal(map.sessions.b.state, 'deleting')
  assert.equal(map.sessions.b.lastError, 'docker rm failed')
  assert.equal(map.sessions.a.migratedFrom, 1)
})

test('a version-2 map round-trips without losing retirees', () => {
  const first = migrateMap({ version: 1, sessions: { s: entry({ legacy: true }) } })
  const second = migrateMap({ ...first, sessions: { a: entry({ generation: 3 }) } })
  assert.equal(second.version, MAP_VERSION)
  assert.equal(second.sessions.a.generation, 3)
  assert.equal(second.retired.length, 1)
})

test('garbage maps migrate to an empty version-2 map', () => {
  for (const raw of [undefined, null, 42, 'x', { sessions: null }, { sessions: { a: null } }]) {
    const map = migrateMap(raw)
    assert.equal(map.version, MAP_VERSION)
    assert.deepEqual(map.sessions, {})
    assert.deepEqual(map.retired, [])
  }
})

test('slot ports never collide with the legacy container and are distinct per slot', () => {
  const legacy = new Set([9222, 8080, 52100, 52101])
  const seen = new Set()
  for (let slot = 0; slot < 8; slot++) {
    const ports = poolPorts(slot)
    for (const [name, value] of Object.entries(ports)) {
      assert.equal(legacy.has(value), false, `${name} for slot ${slot} collides with legacy (${value})`)
      assert.equal(seen.has(value), false, `${name} ${value} duplicated across slots`)
      seen.add(value)
    }
  }
  assert.ok(POOL_PORTS.cdp > 9222)
  assert.ok(POOL_PORTS.web > 8080)
})

test('eviction picks the least-recently-used idle session', () => {
  const sessions = {
    old: entry({ lastUsed: 10 }),
    newer: entry({ lastUsed: 30 }),
    mid: entry({ lastUsed: 20 }),
  }
  assert.equal(pickEvictionCandidate(sessions), 'old')
})

test('eviction never picks a busy, leased or deleting session', () => {
  const sessions = {
    busy: entry({ lastUsed: 1 }),
    leased: entry({ lastUsed: 2 }),
    deleting: entry({ lastUsed: 3, state: 'deleting' }),
    free: entry({ lastUsed: 4 }),
  }
  const picked = pickEvictionCandidate(sessions, { busy: new Set(['busy']), leased: new Set(['leased']) })
  assert.equal(picked, 'free')
  assert.equal(pickEvictionCandidate({ busy: entry(), leased: entry() }, {
    busy: new Set(['busy']),
    leased: new Set(['leased']),
  }), null)
})

test('capacity error names the pool size and the busy sessions', () => {
  const error = new BrowserLiveCapacityError(3, ['a', 'b', 'c'])
  assert.equal(error.name, 'BrowserLiveCapacityError')
  assert.equal(error.capacity, 3)
  assert.deepEqual(error.busy, ['a', 'b', 'c'])
  assert.match(error.message, /pool is full \(3 slots\)/)
})

test('the idle sweeper skips deleting entries and obeys the TTL switch', () => {
  const now = 10_000
  const sessions = {
    stale: entry({ lastUsed: 1_000 }),
    deleting: entry({ lastUsed: 1_000, state: 'deleting' }),
    fresh: entry({ lastUsed: 9_500 }),
  }
  assert.deepEqual(expiredSessions(sessions, now, 5_000), ['stale'])
  assert.deepEqual(expiredSessions(sessions, now, 0), [])
})
