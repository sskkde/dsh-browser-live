/**
 * dsh-browser-live — assembly and wiring tests (no Docker, no browser).
 *
 * The P3 defects were assembly defects: the runtime existed but was not wired
 * into the service/tools/provider. These tests mount the real plugin entry with
 * an injected provider/tools factory and the real sharing runtime, then call the
 * registered `browser_live_state` tool against a real AuthStore.
 *
 * Run with `node --test test/sharing-assembly.test.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply, createSharingRuntime } from '../lib/index.js'
import { registerLiveTools } from '../lib/tools.js'
import { targetUrlForCall, sessionMcpOutputDir } from '../lib/provider.js'
import { AuthStore } from '../lib/sharing/auth-store.js'
import { createScopeResolver } from '../lib/sharing/scope.js'
import { selectCapture } from '../lib/sharing/capture.js'

const home = mkdtempSync(join(tmpdir(), 'dshbl-asm-'))
process.env.DSH_HOME = home

function captureContext() {
  const listeners = []
  const tools = []
  const ctx = new Context()
  const originalOn = ctx.on.bind(ctx)
  ctx.on = (name, listener, options) => {
    listeners.push({ name, listener, options })
    return originalOn(name, listener, options)
  }
  ctx.tools = { register(tool) { tools.push(tool) } }
  return { ctx, listeners, tools }
}

const exec = (id = 'session-1') => ({ agent: { session: { id, header: { cwd: home } } } })

test('apply builds the sharing runtime before the provider and exposes auth + coordinator', () => {
  const { ctx, listeners } = captureContext()
  let providerOptions = null
  let toolOptions = null
  let live = null
  apply(ctx, {
    maxSessions: 2,
    idleTtlHours: 0,
    provision: false,
    sharing: {
      enabled: true,
      scopeId: 'trusted-group',
      allowCredentials: true,
      quotaBytes: 4096,
      artifactScanIntervalMs: 0,
      bindings: [{ origin: 'https://example.test', accountKey: 'work', cookieDomains: ['example.com'], ssoOrigins: ['https://sso.example.test'] }],
    },
  }, {
    applyProvider(_ctx, browserLive, options) {
      live = browserLive
      providerOptions = options
    },
    registerLiveTools(_ctx, _browserLive, options) {
      toolOptions = options
    },
  })
  assert.notEqual(providerOptions, null)
  assert.equal(typeof providerOptions.coordinator?.prepare, 'function', 'the provider receives the live coordinator')
  assert.notEqual(live.sharing, null)
  assert.equal(live.sharing.auth instanceof AuthStore, true, 'state tools can reach the AuthStore')
  assert.equal(typeof live.sharing.coordinator.clearRestored, 'function')
  assert.equal(live.sharing.bindings.forOrigin('https://example.test').accountKey, 'work')
  assert.deepEqual(live.sharing.bindings.forOrigin('https://example.test').cookieDomains, ['example.com'])
  assert.equal(live.sharing.store.quotaBytes, 4096)
  assert.equal(toolOptions.quotaBytes, 4096)
  assert.equal(listeners.some((item) => item.name === 'tools/execute' && item.options?.prepend === true), true, 'the gate is installed before other listeners')
  assert.equal(typeof live.beforeRelease, 'function', 'the pool collects once more before reclaiming a container')
})

test('sharing disabled keeps the pre-sharing behaviour (no gate, no runtime)', () => {
  const { ctx, listeners } = captureContext()
  let live = null
  let providerOptions = null
  apply(ctx, { maxSessions: 1, idleTtlHours: 0, provision: false, sharing: { enabled: false } }, {
    applyProvider(_ctx, browserLive, options) { live = browserLive; providerOptions = options },
    registerLiveTools() {},
  })
  assert.equal(live.sharing, null)
  assert.equal(providerOptions.coordinator, undefined)
  assert.equal(listeners.some((item) => item.name === 'tools/execute'), false)
})

test('browser_live_state list/forget hit the real AuthStore and report revision + epoch', async () => {
  const scopeRoot = join(home, 'runtime')
  const scope = createScopeResolver({ enabled: true })
  const fakePool = { listEntries: () => [], entryFor: () => null }
  const runtime = createSharingRuntime({
    ctx: new Context(),
    browserLive: fakePool,
    scope,
    sharingState: scope.describe(),
    scopeRoot,
    options: { bindings: [{ origin: 'https://example.test', accountKey: 'work' }] },
    dshHomePath: home,
  })
  fakePool.sharing = runtime
  const tools = []
  const ctx = new Context()
  ctx.get = () => undefined
  ctx.tools = { register(tool) { tools.push(tool) } }
  registerLiveTools(ctx, fakePool, {})
  const stateTool = tools.find((tool) => tool.name === 'browser_live_state')
  assert.notEqual(stateTool, undefined)

  const empty = await stateTool.execute({ action: 'list' }, exec())
  assert.deepEqual(empty.states, [])

  const published = await runtime.auth.publish({
    scopeId: 'trusted-group',
    siteKey: 'https://example.test',
    accountKey: 'work',
    sourceSessionId: 'session-1',
    state: { cookies: [{ name: 'sid', value: 'A', domain: 'example.test', path: '/' }], origins: [] },
  })
  const listed = await stateTool.execute({ action: 'list' }, exec())
  assert.equal(listed.states.length, 1)
  assert.equal(listed.states[0].revision, published.revision)
  assert.equal(listed.states[0].epoch, published.epoch)
  assert.equal(listed.states[0].revoked, false)
  assert.equal(JSON.stringify(listed).includes('sid'), false, 'the list never echoes cookie values')

  const forgotten = await stateTool.execute({ action: 'forget', name: 'work' }, exec())
  assert.equal(forgotten.revisions.length, 1)
  assert.equal(forgotten.revisions[0].epoch, published.epoch + 1)
  assert.deepEqual(forgotten.revisions[0].cleared, [])
  const after = await runtime.auth.list({ scopeId: 'trusted-group' })
  assert.equal(after[0].revoked, true)
})

test('a late save after revocation is rejected, not resurrected', async () => {
  const scopeRoot = join(home, 'late')
  const scope = createScopeResolver({ enabled: true })
  const fakePool = { listEntries: () => [], entryFor: () => null }
  const runtime = createSharingRuntime({
    ctx: new Context(),
    browserLive: fakePool,
    scope,
    sharingState: scope.describe(),
    scopeRoot,
    options: {},
    dshHomePath: home,
  })
  const first = await runtime.auth.publish({
    scopeId: 'trusted-group',
    siteKey: 'https://example.test',
    accountKey: 'work',
    sourceSessionId: 'session-1',
    state: { cookies: [], origins: [] },
  })
  await runtime.auth.revoke({ scopeId: 'trusted-group', siteKey: 'https://example.test', accountKey: 'work', expectedRevision: first.revision })
  await assert.rejects(
    () => runtime.auth.publish({
      scopeId: 'trusted-group',
      siteKey: 'https://example.test',
      accountKey: 'work',
      sourceSessionId: 'session-1',
      expectedRevision: first.revision,
      state: { cookies: [], origins: [] },
    }),
    /revoked/,
  )
  // A deliberate re-publish has to acknowledge the current epoch; it is not a
  // silent resurrection by a stale browser.
  const acknowledged = await runtime.auth.publish({
    scopeId: 'trusted-group',
    siteKey: 'https://example.test',
    accountKey: 'work',
    sourceSessionId: 'session-1',
    expectedRevision: first.revision,
    expectedEpoch: first.epoch + 1,
    state: { cookies: [], origins: [] },
  })
  assert.equal(acknowledged.epoch, first.epoch + 1)
})

test('selectCapture keeps exactly the site policy scope', () => {
  const plan = selectCapture({
    origin: 'https://app.example.test',
    binding: { accountKey: 'work', cookieDomains: ['example.test'], ssoOrigins: ['https://sso.example.test'] },
    cookies: [
      { name: 'sid', value: 'A', domain: 'app.example.test' },
      { name: 'parent', value: 'B', domain: '.example.test' },
      { name: 'foreign', value: 'C', domain: 'evil.test' },
      { name: '__dsh_restore_marker', value: '1', domain: 'app.example.test' },
    ],
    pages: [
      { origin: 'https://app.example.test', localStorage: [{ name: 'pref', value: 'dark' }] },
      { origin: 'https://sso.example.test', localStorage: [{ name: 'sso', value: '1' }] },
      { origin: 'https://evil.test', localStorage: [{ name: 'token', value: 'SECRET' }] },
    ],
  })
  assert.equal(plan.accountKey, 'work')
  assert.deepEqual(plan.cookies.map((cookie) => cookie.name).sort(), ['parent', 'sid'])
  assert.deepEqual(plan.origins.map((item) => item.origin).sort(), ['https://app.example.test', 'https://sso.example.test'])
  assert.deepEqual(plan.droppedCookieDomains, ['evil.test'])
  assert.deepEqual(plan.skippedOrigins, ['https://evil.test'])
})

test('selectCapture refuses to publish under a different bound account', () => {
  assert.throws(() => selectCapture({
    origin: 'https://app.example.test',
    binding: { accountKey: 'work', cookieDomains: [], ssoOrigins: [] },
    requestedAccount: 'home',
    cookies: [],
    pages: [],
  }), /account conflict/)
})

test('the MCP path derives the first-navigation target, including gateway_call', () => {
  assert.equal(targetUrlForCall('mcp__playwright-mcp__browser_navigate', { url: 'https://example.test/a' }), 'https://example.test/a')
  assert.equal(targetUrlForCall('mcp__playwright-mcp__browser_gateway_call', { tool: 'browser_navigate', arguments: { url: 'https://example.test/b' } }), 'https://example.test/b')
  assert.equal(targetUrlForCall('mcp__playwright-mcp__browser_click', { element: 'x' }), null)
  assert.equal(targetUrlForCall('browser_live_open', { url: 'https://example.test' }), null)
  assert.equal(sessionMcpOutputDir('session-1').endsWith('/mcp'), true)
  assert.equal(sessionMcpOutputDir('session-1').includes('browser-live'), true)
})

test('state save/load through the registered tool uses the current tab origin and a real store', async () => {
  const scopeRoot = join(home, 'tool-save')
  const scope = createScopeResolver({ enabled: true })
  const entry = { container: 'neko-abcd1234', generation: 1, slot: 1, short: 'abcd1234', cdpPort: 9399, publicPath: '/browser/abcd1234', state: 'active', lastUsed: Date.now() }
  const runtime = createSharingRuntime({
    ctx: new Context(),
    browserLive: { listEntries: () => [{ sessionId: 'session-1', entry }], entryFor: () => entry },
    scope,
    sharingState: scope.describe(),
    scopeRoot,
    options: { bindings: [{ origin: 'https://example.test', accountKey: 'work' }] },
    dshHomePath: home,
  })
  const cookieJar = [
    { name: 'sid', value: 'ACCOUNT_A', domain: 'example.test', path: '/' },
    { name: 'other', value: 'x', domain: 'evil.test', path: '/' },
  ]
  const scripts = []
  const markers = []
  const seeded = []
  const page = {
    url: () => 'https://example.test/app',
    evaluate: async (fn, arg) => {
      if (Array.isArray(arg)) return undefined
      if (arg !== null && typeof arg === 'object') {
        seeded.push(arg)
        return undefined
      }
      return [{ name: 'pref', value: 'dark' }]
    },
  }
  const context = {
    pages: () => [page],
    cookies: async () => cookieJar.map((cookie) => ({ ...cookie })),
    addCookies: async (list) => { for (const cookie of list) markers.push(cookie) },
    clearCookies: async () => undefined,
    addInitScript: async (script) => { scripts.push(script) },
  }
  const fakeBrowser = { contexts: () => [context], close: async () => undefined }
  const playwrightCore = (await import('playwright-core')).default
  const original = playwrightCore.chromium.connectOverCDP
  const connectCalls = []
  playwrightCore.chromium.connectOverCDP = async (...args) => { connectCalls.push(args); return fakeBrowser }
  try {
    const pool = {
      sharing: runtime,
      ensure: async () => entry,
      lease: () => () => undefined,
      entryFor: () => entry,
      listEntries: () => [{ sessionId: 'session-1', entry }],
    }
    const tools = []
    const ctx = new Context()
    ctx.get = () => undefined
    ctx.tools = { register(tool) { tools.push(tool) } }
    registerLiveTools(ctx, pool, {})
    const stateTool = tools.find((tool) => tool.name === 'browser_live_state')

    const saved = await stateTool.execute({ action: 'save', name: 'work' }, exec())
    assert.equal(saved.action, 'save')
    assert.equal(saved.revision.startsWith('1-'), true)
    assert.equal(saved.cookies, 1, 'the foreign cookie domain is not stored')
    assert.deepEqual(saved.droppedCookieDomains, ['evil.test'])
    const stored = await runtime.auth.current({ scopeId: 'trusted-group', siteKey: 'https://example.test', accountKey: 'work' })
    assert.equal(stored.state.cookies.some((cookie) => cookie.name === 'other'), false)

    const loaded = await stateTool.execute({ action: 'load', name: 'work' }, exec())
    assert.equal(loaded.revision, saved.revision)
    assert.equal(loaded.epoch, saved.epoch)
    // The page is already at the origin, so localStorage is seeded directly and
    // no pending marker/init-script is needed for it.
    assert.equal(seeded.some((values) => values.pref === 'dark'), true)
    assert.equal(scripts.length, 1)
    assert.equal(connectCalls.length > 0 && connectCalls.every((args) => args[1]?.noDefaults === true), true, 'attaching must not override the browser download directory')

    await assert.rejects(() => stateTool.execute({ action: 'save', name: 'home' }, exec()), /account conflict/)

    const unboundRuntime = createSharingRuntime({
      ctx: new Context(),
      browserLive: pool,
      scope,
      sharingState: scope.describe(),
      scopeRoot: join(home, 'tool-save-unbound'),
      options: {},
      dshHomePath: home,
    })
    const unboundTools = []
    const unboundCtx = new Context()
    unboundCtx.get = () => undefined
    unboundCtx.tools = { register(tool) { unboundTools.push(tool) } }
    registerLiveTools(unboundCtx, { ...pool, sharing: unboundRuntime }, {})
    const unboundStateTool = unboundTools.find((tool) => tool.name === 'browser_live_state')
    await assert.rejects(() => unboundStateTool.execute({ action: 'save', name: 'work' }, exec()), /is not bound to an account/)
  } finally {
    playwrightCore.chromium.connectOverCDP = original
  }
})

test('startup compensation collects a session directory from its marker after the map entry is gone', async () => {
  const base = join(home, 'data', 'browser-live', 'deadbeef')
  mkdirSync(join(base, 'downloads'), { recursive: true })
  writeFileSync(join(base, '.sharing-session.json'), JSON.stringify({ sessionId: 'session-gone', short: 'deadbeef', generation: 3 }))
  writeFileSync(join(base, 'downloads', 'late-report.pdf'), Buffer.from('%PDF-1.4'))
  const scope = createScopeResolver({ enabled: true })
  const runtime = createSharingRuntime({
    ctx: new Context(),
    browserLive: { listEntries: () => [], entryFor: () => null },
    scope,
    sharingState: scope.describe(),
    scopeRoot: join(home, 'startup'),
    options: {},
    dshHomePath: home,
  })
  const results = await runtime.collectAll()
  const target = results.find((item) => item.sessionId === 'session-gone')
  assert.notEqual(target, undefined)
  assert.equal(target.outcome.published.length, 1)
  assert.equal(target.outcome.published[0].name, 'late-report.pdf')
  const listed = await runtime.store.list({ scopeId: 'trusted-group' })
  assert.equal(listed.items.some((item) => item.fileName === 'late-report.pdf'), true)
  assert.equal(listed.items[0].browserGeneration, 3)
})

test('restore records survive a restart so a later revocation can clear the live browser', async () => {
  const scopeRoot = join(home, 'journal')
  const scope = createScopeResolver({ enabled: true })
  const entry = { container: 'neko-journal', generation: 2, short: 'journal1', cdpPort: 9398, state: 'active', lastUsed: Date.now() }
  const runtime1 = createSharingRuntime({
    ctx: new Context(),
    browserLive: { listEntries: () => [{ sessionId: 'session-1', entry }], entryFor: () => entry },
    scope,
    sharingState: scope.describe(),
    scopeRoot,
    options: { bindings: [{ origin: 'https://example.test', accountKey: 'work' }] },
    dshHomePath: home,
  })
  await runtime1.auth.publish({
    scopeId: 'trusted-group',
    siteKey: 'https://example.test',
    accountKey: 'work',
    sourceSessionId: 'session-1',
    state: {
      cookies: [{ name: 'sid', value: 'ACCOUNT_A', domain: 'example.test', path: '/' }],
      origins: [{ origin: 'https://example.test', localStorage: [{ name: 'pref', value: 'dark' }] }],
    },
  })
  const jar = []
  const scripts = []
  const page = { url: () => 'https://example.test/app', evaluate: async () => undefined }
  const context = {
    pages: () => [page],
    cookies: async () => jar.map((cookie) => ({ ...cookie })),
    addCookies: async (list) => { for (const cookie of list) jar.push({ ...cookie }) },
    clearCookies: async (filter = {}) => {
      for (let index = jar.length - 1; index >= 0; index--) {
        if ((filter.name === undefined || jar[index].name === filter.name)
          && (filter.domain === undefined || String(jar[index].domain).replace(/^\./, '') === filter.domain)) jar.splice(index, 1)
      }
    },
    addInitScript: async (script) => { scripts.push(script) },
  }
  const prepared = await runtime1.coordinator.prepare({
    agent: { session: { id: 'session-1' } },
    sessionId: 'session-1',
    context,
    entry,
    targetUrl: 'https://example.test/login',
  })
  assert.equal(prepared.restored, true)

  // A new process/runtime reads the same journal: the record is not lost.
  const runtime2 = createSharingRuntime({
    ctx: new Context(),
    browserLive: { listEntries: () => [{ sessionId: 'session-1', entry }], entryFor: () => entry },
    scope,
    sharingState: scope.describe(),
    scopeRoot,
    options: { bindings: [{ origin: 'https://example.test', accountKey: 'work' }] },
    dshHomePath: home,
  })
  const record = runtime2.coordinator.status().sessions.find((item) => item.sessionId === 'session-1')
  assert.notEqual(record, undefined)
  assert.equal(record.accountKey, 'work')
  const cleared = await runtime2.coordinator.clearRestored({
    sessionId: 'session-1',
    entry,
    attach: async () => ({ contexts: () => [context], close: async () => undefined }),
  })
  assert.equal(cleared.cleared, true)
  assert.equal(jar.length, 0)
})
