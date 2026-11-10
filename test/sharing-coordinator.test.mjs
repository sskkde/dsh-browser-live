/**
 * dsh-browser-live — coordinator tests.
 *
 * The coordinator is where a stored login becomes a browser's state. These
 * tests pin the rules the P0 probes established: clear before restore, seed
 * localStorage only through the one-shot epoch marker, never restore a revoked
 * account, and repeat the work only when the browser instance or revision
 * actually changed.
 *
 * Run with `node --test test/sharing-coordinator.test.mjs`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RESTORE_MARKER_COOKIE, createCoordinator, createOriginBindings, siteKeyForOrigin } from '../lib/sharing/coordinator.js'
import { createScopeResolver } from '../lib/sharing/scope.js'

const agent = (id) => ({ session: { id } })
const entry = (over = {}) => ({ container: 'neko-abc', generation: 1, ...over })

function fakeContext({ url = 'https://example.test/app', cookies = [] } = {}) {
  const jar = cookies.map((cookie) => ({ ...cookie }))
  const cleared = []
  const scripts = []
  return {
    pages: () => [{ url: () => url }],
    async cookies() { return jar.map((cookie) => ({ ...cookie })) },
    async addCookies(list) {
      for (const cookie of list) {
        const index = jar.findIndex((item) => item.name === cookie.name && item.domain === cookie.domain)
        if (index >= 0) jar[index] = { ...cookie }
        else jar.push({ ...cookie })
      }
    },
    async clearCookies(filter = {}) {
      cleared.push(filter)
      for (let index = jar.length - 1; index >= 0; index--) {
        const cookie = jar[index]
        const domain = String(cookie.domain ?? '').replace(/^\./, '')
        const matchesName = filter.name === undefined || cookie.name === filter.name
        const matchesDomain = filter.domain === undefined || domain === filter.domain
        if (matchesName && matchesDomain) jar.splice(index, 1)
      }
    },
    async addInitScript(script) { scripts.push(script) },
    snapshot: () => ({ jar, cleared, scripts }),
  }
}

function fakeAuth(records) {
  const table = new Map(Object.entries(records))
  return {
    async current({ siteKey, accountKey }) { return table.get(`${siteKey}|${accountKey}`) ?? null },
    async epochOf({ siteKey, accountKey }) { return (table.get(`${siteKey}|${accountKey}`)?.revokedEpoch ?? 0) },
  }
}

const record = (over = {}) => ({
  revision: 'r1',
  epoch: 1,
  state: {
    cookies: [
      { name: 'sid', value: 'ACCOUNT_A', domain: 'example.test', path: '/' },
      { name: 'profile', value: 'A', domain: '.example.test', path: '/' },
    ],
    origins: [{ origin: 'https://example.test', localStorage: [{ name: 'pref', value: 'dark' }] }],
  },
  ...over,
})

const build = (overrides = {}) => createCoordinator({
  scope: createScopeResolver({ enabled: true }),
  auth: fakeAuth({ 'https://example.test|work': record() }),
  bindings: createOriginBindings([{ origin: 'https://example.test', accountKey: 'work' }]),
  ...overrides,
})

test('no bindings configured means nothing is restored', async () => {
  const coordinator = build({ bindings: null })
  const context = fakeContext()
  const outcome = await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  assert.equal(outcome.restored, false)
  assert.equal(outcome.reason, 'no-bindings-configured')
})

test('an unbound origin is left alone', async () => {
  const coordinator = build()
  const context = fakeContext({ url: 'https://other.test/' })
  const outcome = await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  assert.equal(outcome.reason, 'no-binding-for-origin')
  assert.equal(context.snapshot().jar.length, 0)
})

test('a restore clears the host jar first, then writes cookies, marker and init script', async () => {
  const coordinator = build()
  const context = fakeContext({ cookies: [{ name: 'profile', value: 'OLD_ACCOUNT', domain: 'example.test' }] })
  const outcome = await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  assert.equal(outcome.restored, true)
  assert.equal(outcome.revision, 'r1')
  const { jar, cleared, scripts } = context.snapshot()
  assert.equal(cleared.some((filter) => filter.domain === 'example.test'), true)
  assert.equal(jar.some((cookie) => cookie.value === 'OLD_ACCOUNT'), false)
  assert.equal(jar.find((cookie) => cookie.name === 'sid').value, 'ACCOUNT_A')
  assert.equal(jar.find((cookie) => cookie.name === RESTORE_MARKER_COOKIE).value, '1')
  assert.equal(scripts.length, 1)
  assert.match(scripts[0].content, /__dsh_restore_marker/)
})

test('repeating for the same instance and revision does no work', async () => {
  const coordinator = build()
  const context = fakeContext()
  await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  const before = context.snapshot()
  const again = await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  assert.equal(again.reason, 'already-restored')
  const after = context.snapshot()
  // Only the one-shot marker is retired; no cookie domain is cleared again and
  // no revision is re-applied.
  const domainClears = after.cleared.filter((filter) => filter.domain !== undefined)
  assert.equal(domainClears.length, before.cleared.filter((filter) => filter.domain !== undefined).length)
  assert.equal(after.cleared.at(-1).name, RESTORE_MARKER_COOKIE)
  assert.deepEqual(after.jar.map((cookie) => cookie.name).sort(), before.jar.map((cookie) => cookie.name).sort())
})

test('a new browser generation restores again', async () => {
  const coordinator = build()
  const context = fakeContext()
  await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry({ generation: 1 }) })
  const outcome = await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry({ generation: 2 }) })
  assert.equal(outcome.restored, true)
})

test('switching accounts clears the domains the previous restore touched', async () => {
  const auth = fakeAuth({
    'https://example.test|work': record(),
    'https://example.test|home': record({
      revision: 'r2',
      state: {
        cookies: [{ name: 'sid', value: 'ACCOUNT_B', domain: 'other.example.test', path: '/' }],
        origins: [],
      },
    }),
  })
  let account = 'work'
  const bindings = { forOrigin: () => ({ siteKey: 'https://example.test', accountKey: account }) }
  const coordinator = build({ auth, bindings })
  const context = fakeContext()
  await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  account = 'home'
  const outcome = await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  assert.equal(outcome.restored, true)
  const domains = context.snapshot().cleared.map((filter) => filter.domain)
  assert.equal(domains.includes('example.test'), true, 'the previous account domain is cleared')
  assert.equal(domains.includes('other.example.test'), true, 'the new account domain is cleared')
})

test('a revoked account is refused before any cookie is written', async () => {
  const revoked = { ...record({ epoch: 1 }), revokedEpoch: 3 }
  const coordinator = build({ auth: fakeAuth({ 'https://example.test|work': revoked }) })
  const context = fakeContext()
  const outcome = await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  assert.equal(outcome.restored, false)
  assert.equal(outcome.reason, 'revoked')
  assert.equal(context.snapshot().jar.length, 0)
})

test('a scope without the credential grant restores nothing', async () => {
  const coordinator = build({ scope: createScopeResolver({ enabled: true, allowCredentials: false }) })
  const context = fakeContext()
  const outcome = await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  assert.equal(outcome.reason, 'credentials-withheld')
})

test('a session outside the scope cannot restore', async () => {
  const coordinator = build({ scope: createScopeResolver({ enabled: true, members: ['other'] }) })
  await assert.rejects(
    () => coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context: fakeContext(), entry: entry() }),
    /not in the trusted group/,
  )
})

test('finish clears the one-shot marker', async () => {
  const coordinator = build()
  const context = fakeContext()
  await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  await coordinator.finish({ context })
  const cleared = context.snapshot().cleared.at(-1)
  assert.equal(cleared.name, RESTORE_MARKER_COOKIE)
})

test('the site key is the exact origin', () => {
  assert.equal(siteKeyForOrigin('https://example.test:8443/a/b?q=1'), 'https://example.test:8443')
  assert.equal(siteKeyForOrigin('not a url'), null)
})

test('force re-applies the current revision for an explicit refresh', async () => {
  const coordinator = build()
  const context = fakeContext()
  await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  const forced = await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry(), force: true })
  assert.equal(forced.restored, true)
  assert.equal(forced.revision, 'r1')
})
