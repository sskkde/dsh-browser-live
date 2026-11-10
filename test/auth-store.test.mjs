import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  AUTH_FORMAT_VERSION,
  AuthStore,
  RevisionConflictError,
  redactUrl,
} from '../lib/sharing/auth-store.js'

const secretCookie = 'COOKIE_VALUE_MUST_NEVER_LEAK'
const secretStorage = 'LOCAL_STORAGE_VALUE_MUST_NEVER_LEAK'

async function fixture(t, options = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'auth-store-test-'))
  const root = path.join(parent, 'scope-auth')
  t.after(async () => rm(parent, { recursive: true, force: true }))
  const store = new AuthStore({ root, ...options })
  return { parent, root, store }
}

function state(cookieValue = secretCookie, localValue = secretStorage) {
  return {
    cookies: [{ name: 'session', value: cookieValue, domain: 'example.test', path: '/', httpOnly: true, secure: true }],
    origins: [{ origin: 'https://example.test', localStorage: [{ name: 'token', value: localValue }] }],
  }
}

function publishArgs(overrides = {}) {
  return {
    scopeId: 'trusted-test-scope',
    siteKey: 'example',
    accountKey: 'alice',
    sourceSessionId: 'session-a',
    state: state(),
    ...overrides,
  }
}

async function walk(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    result.push(fullPath)
    if (entry.isDirectory()) result.push(...await walk(fullPath))
  }
  return result
}

test('first publish persists a versioned snapshot and current round-trips state', async (t) => {
  const { root, store } = await fixture(t, { now: () => 1_800_000_000_000 })
  const input = state()
  const published = await store.publish(publishArgs({ state: input }))

  assert.equal(AUTH_FORMAT_VERSION, 1)
  assert.deepEqual(Object.keys(published).sort(), [
    'accountKey', 'bytes', 'capturedAt', 'epoch', 'revision', 'siteKey', 'sourceSessionId',
  ])
  assert.equal(published.siteKey, 'example')
  assert.equal(published.accountKey, 'alice')
  assert.equal(published.epoch, 0)
  assert.equal(published.capturedAt, 1_800_000_000_000)
  assert.match(published.revision, /^1-[a-f0-9]{24}$/)
  assert.ok(published.bytes > 0)
  const revisionFiles = await walk(path.join(root, 'revisions'))
  const revisionFile = revisionFiles.find((filePath) => path.basename(filePath) === `${published.revision}.json`)
  assert.ok(revisionFile)
  const revisionData = JSON.parse(await readFile(revisionFile, 'utf8'))
  assert.equal(revisionData.formatVersion, AUTH_FORMAT_VERSION)
  assert.deepEqual(await store.current({ scopeId: 'trusted-test-scope', siteKey: 'example', accountKey: 'alice' }), {
    revision: published.revision,
    epoch: 0,
    capturedAt: published.capturedAt,
    state: input,
  })
})

test('CAS conflict returns safe current summary and expected revision', async (t) => {
  const { store } = await fixture(t)
  const published = await store.publish(publishArgs())

  await assert.rejects(
    store.publish(publishArgs({ expectedRevision: 'stale-revision' })),
    (error) => {
      assert.ok(error instanceof RevisionConflictError)
      assert.equal(error.expected, 'stale-revision')
      assert.deepEqual(error.current, published)
      const exposed = JSON.stringify({ message: error.message, current: error.current, expected: error.expected })
      assert.equal(exposed.includes(secretCookie), false)
      assert.equal(exposed.includes(secretStorage), false)
      return true
    },
  )
})

test('revoke bumps epoch and rejects a publish using an older expected epoch', async (t) => {
  const { store } = await fixture(t)
  const published = await store.publish(publishArgs())
  const revoked = await store.revoke({
    scopeId: 'trusted-test-scope',
    siteKey: 'example',
    accountKey: 'alice',
    expectedRevision: published.revision,
  })

  assert.equal(revoked.epoch, 1)
  assert.match(revoked.revision, /^2-[a-f0-9]{24}$/)
  assert.equal(await store.epochOf({ scopeId: 'trusted-test-scope', siteKey: 'example', accountKey: 'alice' }), 1)
  assert.equal(await store.current({ scopeId: 'trusted-test-scope', siteKey: 'example', accountKey: 'alice' }), null)
  assert.equal((await store.list({ scopeId: 'trusted-test-scope' }))[0].revoked, true)

  await assert.rejects(
    store.publish(publishArgs({ expectedRevision: published.revision, expectedEpoch: 0 })),
    (error) => {
      assert.equal(error instanceof RevisionConflictError, false)
      assert.match(error.message, /revoked/)
      assert.equal(error.message.includes(secretCookie), false)
      return true
    },
  )

  const rebound = await store.publish(publishArgs({
    expectedRevision: published.revision,
    expectedEpoch: revoked.epoch,
  }))
  assert.equal(rebound.epoch, 1)
  assert.equal((await store.list({ scopeId: 'trusted-test-scope' }))[0].revoked, false)
  const next = await store.publish(publishArgs({ expectedRevision: rebound.revision }))
  assert.equal(next.epoch, 1)
})

test('concurrent publishes with one expected head have exactly one winner', async (t) => {
  const { store } = await fixture(t)
  const first = await store.publish(publishArgs())
  const attempts = await Promise.allSettled([
    store.publish(publishArgs({ expectedRevision: first.revision, state: state('winner-one') })),
    store.publish(publishArgs({ expectedRevision: first.revision, state: state('winner-two') })),
  ])

  const winners = attempts.filter((attempt) => attempt.status === 'fulfilled')
  const losers = attempts.filter((attempt) => attempt.status === 'rejected')
  assert.equal(winners.length, 1)
  assert.equal(losers.length, 1)
  assert.ok(losers[0].reason instanceof RevisionConflictError)
  assert.equal((await store.current({ scopeId: 'trusted-test-scope', siteKey: 'example', accountKey: 'alice' })).revision, winners[0].value.revision)
})

test('an interrupted staging file is not visible as a revision', async (t) => {
  const { root, store } = await fixture(t)
  const published = await store.publish(publishArgs())
  const revisionsRoot = path.join(root, 'revisions')
  const [siteDirectory] = await readdir(revisionsRoot)
  const [accountDirectory] = await readdir(path.join(revisionsRoot, siteDirectory))
  const accountPath = path.join(revisionsRoot, siteDirectory, accountDirectory)
  await writeFile(path.join(accountPath, '.staging-interrupted.tmp'), '{"half":', { mode: 0o600 })

  const current = await store.current({ scopeId: 'trusted-test-scope', siteKey: 'example', accountKey: 'alice' })
  assert.equal(current.revision, published.revision)
  assert.deepEqual(current.state, state())
})

test('hostile logical identifiers are safely encoded and stay inside root', async (t) => {
  const { parent, root, store } = await fixture(t)
  const outside = path.join(parent, 'outside')
  await mkdir(outside, { mode: 0o700 })
  const marker = path.join(outside, 'marker')
  await writeFile(marker, 'untouched')
  const keys = {
    scopeId: '../../etc/passwd',
    siteKey: path.join(outside, 'must-not-be-a-path'),
    accountKey: '\0../../outside/marker',
  }

  const published = await store.publish(publishArgs({ ...keys, state: state() }))
  assert.ok(published.revision)
  assert.equal(await readFile(marker, 'utf8'), 'untouched')
  const paths = await walk(root)
  assert.ok(paths.length > 0)
  for (const filePath of paths) {
    const real = await stat(filePath)
    assert.ok(real.isDirectory() || real.isFile())
    assert.ok(path.relative(root, filePath) !== '..')
    assert.equal(path.relative(root, filePath).startsWith(`..${path.sep}`), false)
  }
  const listed = await store.list({ scopeId: keys.scopeId })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].accountKey, keys.accountKey)
})

test('list returns metadata without reading revision payloads', async (t) => {
  const { root, store } = await fixture(t)
  const published = await store.publish(publishArgs())
  const files = await walk(path.join(root, 'revisions'))
  const revisionFile = files.find((filePath) => path.basename(filePath) === `${published.revision}.json`)
  assert.ok(revisionFile)
  await writeFile(revisionFile, 'corrupt revision payload')

  const listed = await store.list({ scopeId: 'trusted-test-scope' })
  assert.deepEqual(listed, [{
    siteKey: 'example',
    accountKey: 'alice',
    revision: published.revision,
    epoch: 0,
    capturedAt: published.capturedAt,
    revoked: false,
  }])
  assert.equal(JSON.stringify(listed).includes(secretCookie), false)
  assert.equal(JSON.stringify(listed).includes(secretStorage), false)
})

test('created files are 0600 and directories are 0700', async (t) => {
  const { root, store } = await fixture(t)
  const published = await store.publish(publishArgs())
  await store.revoke({
    scopeId: 'trusted-test-scope',
    siteKey: 'example',
    accountKey: 'alice',
    expectedRevision: published.revision,
  })

  for (const entryPath of [root, ...await walk(root)]) {
    const info = await stat(entryPath)
    const mode = info.mode & 0o777
    assert.equal(mode, info.isDirectory() ? 0o700 : 0o600, entryPath)
  }
})

test('redactUrl returns only an origin or null', () => {
  assert.equal(redactUrl('https://user:password@example.test/path?token=secret#fragment'), 'https://example.test')
  assert.equal(redactUrl('not a url'), null)
  assert.equal(redactUrl('file:///tmp/private'), 'null')
  assert.equal(redactUrl(null), null)
})
