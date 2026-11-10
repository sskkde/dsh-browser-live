/**
 * dsh-browser-live — audit log tests.
 *
 * The audit trail must be useful to an operator without becoming a second copy
 * of the credentials it records events about.
 *
 * Run with `node --test test/sharing-audit.test.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AuditLog, redactDetail } from '../lib/sharing/audit.js'

const root = () => mkdtempSync(join(tmpdir(), 'dsh-audit-'))

test('an event is appended with metadata and read back', async () => {
  const log = new AuditLog({ root: root(), now: () => Date.parse('2026-11-10T12:00:00Z') })
  await log.record({
    scopeId: 'trusted-group',
    action: 'auth.publish',
    actorSessionId: 'session-a',
    subject: { siteKey: 'example.test', accountKey: 'work' },
    detail: { revision: 'r2' },
  })
  const [event] = await log.tail()
  assert.equal(event.action, 'auth.publish')
  assert.equal(event.scopeId, 'trusted-group')
  assert.equal(event.actorSessionId, 'session-a')
  assert.deepEqual(event.subject, { siteKey: 'example.test', accountKey: 'work' })
  assert.equal(event.outcome, 'ok')
  assert.equal(event.formatVersion, 1)
})

test('credential-shaped fields are replaced, not logged', async () => {
  const log = new AuditLog({ root: root() })
  await log.record({
    scopeId: 's',
    action: 'auth.publish',
    detail: { cookie: 'sessionid=SECRET', token: 't0k', password: 'p', nested: { value: 'v', ok: 1 } },
  })
  const [event] = await log.tail()
  assert.equal(event.detail.cookie, '[redacted]')
  assert.equal(event.detail.token, '[redacted]')
  assert.equal(event.detail.password, '[redacted]')
  assert.equal(event.detail.nested.value, '[redacted]')
  assert.equal(event.detail.nested.ok, 1)
  assert.equal(JSON.stringify(event).includes('SECRET'), false)
})

test('a URL detail keeps only its origin', () => {
  assert.equal(redactDetail('https://example.test/path?token=abc#frag'), 'https://example.test')
  assert.equal(redactDetail('not a url'), 'not a url')
  assert.equal(redactDetail({ url: 'https://user:pass@example.test/x?y=1' }).url, 'https://example.test')
})

test('the log file is 0600 and lines are append-only', async () => {
  const rootDir = root()
  const log = new AuditLog({ root: rootDir })
  await log.record({ scopeId: 's', action: 'a.one' })
  await log.record({ scopeId: 's', action: 'a.two' })
  const events = await log.tail()
  assert.deepEqual(events.map((e) => e.action), ['a.one', 'a.two'])
  const file = join(rootDir, events[0] === undefined ? '' : `${new Date(events[0].at).toISOString().slice(0, 10)}.jsonl`)
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('a truncated trailing line is ignored rather than fatal', async () => {
  const rootDir = root()
  const log = new AuditLog({ root: rootDir, now: () => Date.parse('2026-11-10T12:00:00Z') })
  await log.record({ scopeId: 's', action: 'a.one' })
  writeFileSync(join(rootDir, '2026-11-10.jsonl'), '{"half":', { flag: 'a' })
  const events = await log.tail()
  assert.deepEqual(events.map((e) => e.action), ['a.one'])
})
