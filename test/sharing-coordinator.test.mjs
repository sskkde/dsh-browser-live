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
import vm from 'node:vm'
import { RESTORE_MARKER_COOKIE, createCoordinator, createOriginBindings, siteKeyForOrigin } from '../lib/sharing/coordinator.js'
import { createScopeResolver } from '../lib/sharing/scope.js'

const agent = (id) => ({ session: { id } })
const entry = (over = {}) => ({ container: 'neko-abc', generation: 1, ...over })

function fakeContext({ url = 'https://example.test/app', cookies = [] } = {}) {
  const jar = cookies.map((cookie) => ({ ...cookie }))
  const cleared = []
  const scripts = []
  const evaluated = []
  const state = { url }
  return {
    setUrl(next) { state.url = next },
    pages: () => [{ url: () => state.url, evaluate: async (fn, arg) => { evaluated.push({ fn: String(fn), arg }); return undefined } }],
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
    snapshot: () => ({ jar, cleared, scripts, evaluated }),
  }
}

function fakeAuth(records) {
  const table = new Map(Object.entries(records))
  const epochs = new Map()
  return {
    async current({ siteKey, accountKey }) { return table.get(`${siteKey}|${accountKey}`) ?? null },
    async epochOf({ siteKey, accountKey }) {
      const key = `${siteKey}|${accountKey}`
      return Math.max(table.get(key)?.revokedEpoch ?? 0, epochs.get(key) ?? 0)
    },
    set(record, value) { table.set(record, value) },
    setEpoch(record, value) { epochs.set(record, value) },
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
  // The page is already open at the bound origin, so the snapshot is seeded
  // directly and no one-shot marker is needed.
  assert.equal(jar.some((cookie) => cookie.name === RESTORE_MARKER_COOKIE), false)
  assert.equal(context.snapshot().evaluated.some((item) => item.arg?.pref === 'dark'), true)
  assert.equal(scripts.length, 1)
  assert.match(scripts[0].content, /__dsh_restore_marker/)
})

test('repeating for the same instance and revision does no work', async () => {
  const coordinator = build()
  const context = fakeContext()
  await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  await coordinator.finish({ context, sessionId: 's1' })
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
  const bindings = { forOrigin: () => ({ siteKey: 'https://example.test', accountKey: account, cookieDomains: ['other.example.test'], ssoOrigins: [] }) }
  const coordinator = build({ auth, bindings })
  const context = fakeContext()
  await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  account = 'home'
  const outcome = await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry(), force: true })
  assert.equal(outcome.restored, true)
  const domains = context.snapshot().cleared.map((filter) => filter.domain)
  assert.equal(domains.includes('example.test'), true, 'the previous account domain is cleared')
  assert.equal(domains.includes('other.example.test'), true, 'the new account domain is cleared')
})

test('switching accounts removes the localStorage keys the previous restore seeded', async () => {
  const auth = fakeAuth({
    'https://example.test|work': record(),
    'https://example.test|home': record({
      revision: 'r2',
      state: {
        cookies: [{ name: 'sid', value: 'ACCOUNT_B', domain: 'example.test', path: '/' }],
        origins: [{ origin: 'https://example.test', localStorage: [{ name: 'theme', value: 'light' }] }],
      },
    }),
  })
  let account = 'work'
  const bindings = { forOrigin: () => ({ siteKey: 'https://example.test', accountKey: account, cookieDomains: [], ssoOrigins: [] }), forAccount: () => null }
  const coordinator = build({ auth, bindings })
  const context = fakeContext()
  await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  account = 'home'
  const switched = await coordinator.prepare({
    agent: agent('s1'),
    sessionId: 's1',
    context,
    entry: entry(),
    force: true,
    accountKey: 'home',
  })
  assert.equal(switched.restored, true)
  const evaluated = context.snapshot().evaluated
  assert.equal(evaluated.some((item) => Array.isArray(item.arg) && item.arg.includes('pref')), true, 'the previous seed is removed')
  const newestScript = context.snapshot().scripts.at(-1).content
  assert.match(newestScript, /theme/)
  assert.match(newestScript, /"remove":\{"https:\/\/example\.test":\["pref"\]\}/)
})

test('switching accounts keeps cleanup for a prior origin that is not open', async () => {
  const auth = fakeAuth({
    'https://example.test|work': record(),
    'https://home.test|home': record({
      revision: 'r2',
      state: {
        cookies: [{ name: 'sid', value: 'ACCOUNT_B', domain: 'home.test', path: '/' }],
        origins: [{ origin: 'https://home.test', localStorage: [{ name: 'theme', value: 'light' }] }],
      },
    }),
  })
  const bindings = createOriginBindings([
    { origin: 'https://example.test', accountKey: 'work' },
    { origin: 'https://home.test', accountKey: 'home' },
  ])
  const coordinator = build({ auth, bindings })
  const context = fakeContext({ url: 'https://other.test/app' })
  await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry(), targetUrl: 'https://example.test/' })
  const switched = await coordinator.prepare({
    agent: agent('s1'),
    sessionId: 's1',
    context,
    entry: entry(),
    force: true,
    accountKey: 'home',
    targetUrl: 'https://home.test/',
  })
  assert.equal(switched.restored, true)
  const state = coordinator.restoredFor('s1')
  assert.deepEqual(state.pendingCleanupKeys, { 'https://example.test': ['pref'] })
  const script = context.snapshot().scripts.at(-1).content
  assert.match(script, /"remove":\{"https:\/\/example\.test":\["pref"\]\}/)
  const markerDomains = context.snapshot().jar.filter((cookie) => cookie.name === RESTORE_MARKER_COOKIE).map((cookie) => cookie.domain).sort()
  assert.deepEqual(markerDomains, ['example.test', 'home.test'])
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

test('a later publish by another session does not switch this live instance', async () => {
  const auth = fakeAuth({ 'https://example.test|work': record() })
  const coordinator = build({ auth })
  const context = fakeContext()
  await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  auth.set('https://example.test|work', record({
    revision: 'r2',
    epoch: 2,
    state: {
      cookies: [{ name: 'sid', value: 'ACCOUNT_B', domain: 'example.test', path: '/' }],
      origins: [{ origin: 'https://example.test', localStorage: [{ name: 'pref', value: 'light' }] }],
    },
  }))
  const again = await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  assert.equal(again.reason, 'already-restored')
  assert.equal(again.revision, 'r1', 'the instance keeps the revision it imported')
  assert.equal(context.snapshot().jar.some((cookie) => cookie.value === 'ACCOUNT_B'), false)
  assert.equal(context.snapshot().scripts.length, 1, 'no second init script was added')
})

test('a revocation that happened out of band clears the imported state on the next call', async () => {
  const auth = fakeAuth({ 'https://example.test|work': record() })
  const coordinator = build({ auth })
  const context = fakeContext()
  await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  auth.set('https://example.test|work', null)
  auth.setEpoch('https://example.test|work', 5)
  const outcome = await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  assert.equal(outcome.reason, 'revoked')
  assert.equal(context.snapshot().jar.length, 0, 'the imported cookies are gone')
  assert.equal(coordinator.restoredFor('s1'), null)
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

test('a blank browser restores against the target URL of the operation', async () => {
  const coordinator = build()
  const context = fakeContext({ url: 'about:blank' })
  const outcome = await coordinator.prepare({
    agent: agent('s1'),
    sessionId: 's1',
    context,
    entry: entry(),
    targetUrl: 'https://example.test/login?next=/app',
  })
  assert.equal(outcome.restored, true)
  assert.equal(context.snapshot().jar.find((cookie) => cookie.name === RESTORE_MARKER_COOKIE).domain, 'example.test')
  assert.equal(context.snapshot().scripts.length, 1)
})

test('a blank browser without a target has no origin to restore', async () => {
  const coordinator = build()
  const outcome = await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context: fakeContext({ url: 'about:blank' }), entry: entry() })
  assert.equal(outcome.restored, false)
  assert.equal(outcome.reason, 'no-target-origin')
})

test('an explicit load leaves the marker for the next navigation', async () => {
  const coordinator = build()
  const context = fakeContext({ url: 'about:blank' })
  const targetUrl = 'https://example.test/login'
  await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry(), force: true, targetUrl })
  const marker = context.snapshot().jar.find((cookie) => cookie.name === RESTORE_MARKER_COOKIE)
  assert.equal(marker.value, '1:r1', 'the marker identifies the revision, not only the epoch')
  const clearedBefore = context.snapshot().cleared.length
  const again = await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry(), targetUrl })
  assert.equal(again.reason, 'already-restored')
  assert.equal(context.snapshot().cleared.length, clearedBefore, 'the pending marker is not retired before the navigation')
})

test('the init script expires the marker after seeding (logout cannot be refilled)', async () => {
  const coordinator = build()
  const context = fakeContext()
  await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  const script = context.snapshot().scripts[0].content
  assert.match(script, /max-age=0/)
  assert.match(script, /payload\.marker/)
  assert.match(script, /setItem\(key, entry\[key\]\)/)
})

test('restore drops cookies and origins outside the binding policy', async () => {
  const auth = fakeAuth({
    'https://example.test|work': record({
      state: {
        cookies: [
          { name: 'sid', value: 'A', domain: 'example.test', path: '/' },
          { name: 'foreign', value: 'B', domain: 'evil.test', path: '/' },
        ],
        origins: [
          { origin: 'https://example.test', localStorage: [{ name: 'pref', value: 'dark' }] },
          { origin: 'https://evil.test', localStorage: [{ name: 'token', value: 'SECRET' }] },
        ],
      },
    }),
  })
  const coordinator = build({ auth })
  const context = fakeContext()
  await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  const { jar, scripts } = context.snapshot()
  assert.equal(jar.some((cookie) => cookie.domain === 'evil.test'), false)
  assert.equal(scripts[0].content.includes('evil.test'), false)
  assert.equal(scripts[0].content.includes('SECRET'), false)
})

test('clearRestored removes cookies, seeded localStorage keys and the marker', async () => {
  const coordinator = build()
  const context = fakeContext()
  await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry() })
  const outcome = await coordinator.clearRestored({
    sessionId: 's1',
    entry: entry(),
    attach: async () => ({ contexts: () => [context], close: async () => undefined }),
  })
  assert.equal(outcome.cleared, true)
  const snapshot = context.snapshot()
  assert.equal(snapshot.jar.length, 0)
  assert.equal(snapshot.cleared.some((filter) => filter.name === RESTORE_MARKER_COOKIE), true)
  const removals = snapshot.evaluated.filter((item) => Array.isArray(item.arg))
  assert.equal(removals.length, 1)
  assert.deepEqual(removals[0].arg, ['pref'])
  assert.equal(coordinator.restoredFor('s1'), null)
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


test('an explicit account must be the admin-bound account for that origin', async () => {
  const coordinator = build()
  const context = fakeContext()
  const outcome = await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry(), force: true, accountKey: 'home' })
  assert.equal(outcome.restored, false)
  assert.equal(outcome.reason, 'account-not-bound')
  assert.equal(context.snapshot().jar.length, 0)
})

test('a pending SSO origin gets its own host-scoped marker', async () => {
  const auth = fakeAuth({
    'https://example.test|work': record({
      state: {
        cookies: [{ name: 'sid', value: 'A', domain: 'example.test', path: '/' }],
        origins: [
          { origin: 'https://example.test', localStorage: [{ name: 'pref', value: 'dark' }] },
          { origin: 'https://sso.example.test', localStorage: [{ name: 'sso', value: '1' }] },
        ],
      },
    }),
  })
  const bindings = { forOrigin: () => ({ siteKey: 'https://example.test', accountKey: 'work', cookieDomains: [], ssoOrigins: ['https://sso.example.test'] }), forAccount: () => null }
  const coordinator = build({ auth, bindings })
  const context = fakeContext({ url: 'about:blank' })
  await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry(), targetUrl: 'https://example.test/login' })
  const domains = context.snapshot().jar.filter((cookie) => cookie.name === RESTORE_MARKER_COOKIE).map((cookie) => cookie.domain).sort()
  assert.deepEqual(domains, ['example.test', 'sso.example.test'])
})

test('revocation reports localStorage it could not clear and keeps the journal record', async () => {
  const coordinator = build()
  const prepared = fakeContext()
  await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context: prepared, entry: entry() })
  // The only tab has navigated to another origin since the restore.
  const navigated = fakeContext({ url: 'https://other.test/' })
  const outcome = await coordinator.clearRestored({
    sessionId: 's1',
    entry: entry(),
    attach: async () => ({ contexts: () => [navigated], close: async () => undefined }),
  })
  assert.equal(outcome.cleared, false)
  assert.equal(outcome.reason, 'localstorage-origin-not-open')
  assert.deepEqual(outcome.pendingOrigins, ['https://example.test'])
  assert.notEqual(coordinator.restoredFor('s1'), null, 'the record is kept for a later retry')
  assert.deepEqual(coordinator.restoredFor('s1').pendingCleanup, ['https://example.test'])
})

test('a restoring entry is not treated as gone', async () => {
  const coordinator = build()
  await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context: fakeContext(), entry: entry() })
  const outcome = await coordinator.clearRestored({
    sessionId: 's1',
    entry: entry({ state: 'deleting' }),
    attach: async () => { throw new Error('must not attach') },
  })
  assert.equal(outcome.cleared, false)
  assert.equal(outcome.reason, 'browser-reclaiming')
  assert.notEqual(coordinator.restoredFor('s1'), null)
})

test('the init script seeds once per marker, overwrites values, and cannot refill after logout', async () => {
  const coordinator = build()
  const context = fakeContext({ url: 'about:blank' })
  await coordinator.prepare({ agent: agent('s1'), sessionId: 's1', context, entry: entry(), targetUrl: 'https://example.test/login' })
  const script = context.snapshot().scripts[0].content
  const storage = new Map([['pref', 'stale']])
  const deleted = []
  let cookie = '__dsh_restore_marker=1:r1'
  const sandbox = {
    window: {
      location: { origin: 'https://example.test' },
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.delete(key),
      },
    },
    document: {},
  }
  Object.defineProperty(sandbox.document, 'cookie', {
    get: () => cookie,
    set: (value) => {
      if (value.startsWith('__dsh_restore_marker=')) {
        deleted.push(value)
        cookie = ''
      }
    },
  })
  vm.runInNewContext(script, sandbox)
  assert.equal(storage.get('pref'), 'dark', 'the snapshot overwrites a stale local value')
  assert.equal(deleted.length >= 1, true, 'the marker is consumed at the first load')
  assert.equal(cookie, '', 'the marker cookie is gone after seeding')
  // The user logs out (key gone) and navigates again: no snapshot is refilled.
  storage.delete('pref')
  vm.runInNewContext(script, sandbox)
  assert.equal(storage.has('pref'), false)
  // A newer revision with the same epoch must not be consumed by this old script.
  const other = fakeContext({ url: 'about:blank' })
  await build({ auth: fakeAuth({ 'https://example.test|work': record({ revision: 'r2' }) }) })
    .prepare({ agent: agent('s2'), sessionId: 's2', context: other, entry: entry(), targetUrl: 'https://example.test/login' })
  const newerScript = other.snapshot().scripts[0].content
  assert.notEqual(newerScript, script)
  assert.match(newerScript, /2:r2|1:r2/)
})

test('an explicit load resolves the bound origin on a blank browser', async () => {
  const coordinator = build()
  const context = fakeContext({ url: 'about:blank' })
  const outcome = await coordinator.prepare({
    agent: agent('s1'),
    sessionId: 's1',
    context,
    entry: entry(),
    force: true,
    accountKey: 'work',
  })
  assert.equal(outcome.restored, true)
  assert.equal(outcome.siteKey, 'https://example.test')
  assert.equal(context.snapshot().jar.find((cookie) => cookie.name === RESTORE_MARKER_COOKIE).domain, 'example.test')
})
