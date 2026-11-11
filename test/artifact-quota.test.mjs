/**
 * dsh-browser-live — artifact store quota, crash windows and reconciliation.
 *
 * The P2 gate needs a cumulative hard cap that stops publishing without
 * deleting history, and a report of the crash windows an immutable store can
 * leave behind (object without metadata, metadata without data, orphan
 * staging). Nothing here deletes: reconciliation reports for an operator.
 *
 * Run with `node --test test/artifact-quota.test.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactError, ArtifactStore } from '../lib/sharing/artifact-store.js'

const root = () => mkdtempSync(join(tmpdir(), 'dshbl-art-'))

test('a cumulative quota stops a new publish and keeps the source file', async () => {
  const dir = root()
  const store = new ArtifactStore({ root: dir, quotaBytes: 10 })
  const first = await store.stage({ scopeId: 's', kind: 'download', fileName: 'a.bin', bytes: Buffer.from('12345678'), sourceSessionId: 'sess' })
  await store.publish({ scopeId: 's', artifactId: first.artifactId })

  await assert.rejects(
    () => store.stage({ scopeId: 's', kind: 'download', fileName: 'b.bin', bytes: Buffer.from('12345'), sourceSessionId: 'sess' }),
    (error) => error instanceof ArtifactError && error.code === 'QUOTA',
  )
  // The rejected staging attempt leaves no half object behind…
  assert.deepEqual(readdirSync(join(dir, 'objects', '.staging')), [])
  // …and the already published object is still readable.
  const read = await store.read({ scopeId: 's', artifactId: first.artifactId })
  assert.equal(read.toString(), '12345678')
})

test('a quota reached between staging and publishing is refused at publication', async () => {
  const dir = root()
  const store = new ArtifactStore({ root: dir, quotaBytes: 20 })
  const first = await store.stage({ scopeId: 's', kind: 'download', fileName: 'a.bin', bytes: Buffer.from('12345678'), sourceSessionId: 'sess' })
  const second = await store.stage({ scopeId: 's', kind: 'download', fileName: 'b.bin', bytes: Buffer.from('12345'), sourceSessionId: 'sess' })
  await store.publish({ scopeId: 's', artifactId: first.artifactId })
  // Another object appears under the same root (an orphan, a concurrent writer):
  // it consumes the remaining budget between stage and publish.
  const blocker = '00000000-0000-4000-8000-00000000000a'
  mkdirSync(join(dir, 'objects', blocker), { recursive: true })
  writeFileSync(join(dir, 'objects', blocker, 'data.bin'), Buffer.alloc(10))
  await assert.rejects(
    () => store.publish({ scopeId: 's', artifactId: second.artifactId }),
    (error) => error instanceof ArtifactError && error.code === 'QUOTA',
  )
  assert.equal(await store.info({ scopeId: 's', artifactId: second.artifactId }), null)
  assert.deepEqual(readdirSync(join(dir, 'objects', '.staging')), [], 'the refused staging files are removed')
  assert.equal(readFileSync(join(dir, 'objects', first.artifactId, 'data.bin'), 'utf8'), '12345678')
})

test('reconcile reports orphan objects, missing data and orphan staging without deleting', async () => {
  const dir = root()
  const store = new ArtifactStore({ root: dir })
  const published = await store.stage({ scopeId: 's', kind: 'screenshot', fileName: 'a.png', bytes: Buffer.from('png'), sourceSessionId: 'sess' })
  await store.publish({ scopeId: 's', artifactId: published.artifactId })

  const orphanId = '00000000-0000-4000-8000-000000000001'
  const missingId = '00000000-0000-4000-8000-000000000002'
  const stagingId = '00000000-0000-4000-8000-000000000003'
  mkdirSync(join(dir, 'objects', orphanId), { recursive: true })
  writeFileSync(join(dir, 'objects', orphanId, 'data.bin'), 'orphan')
  writeFileSync(join(dir, 'objects', '.staging', `${stagingId}.part`), 'partial')
  // A metadata record whose object data is gone.
  writeFileSync(join(dir, 'metadata', `${missingId}.json`), JSON.stringify({
    formatVersion: 1,
    artifactId: missingId,
    scopeId: 's',
    kind: 'download',
    fileName: 'gone.bin',
    displayName: 'gone.bin',
    size: 3,
    sha256: 'a'.repeat(64),
    createdAt: new Date().toISOString(),
    sourceSessionId: 'sess',
    browserGeneration: null,
    sourceUrl: null,
    status: 'published',
  }))

  const report = await store.reconcile({ scopeId: 's' })
  assert.equal(report.published, 2)
  assert.deepEqual(report.orphanObjects, [orphanId])
  assert.deepEqual(report.missingData, [missingId])
  assert.deepEqual(report.orphanStaging, [stagingId])
  // Report only: every file is still there.
  assert.equal(readFileSync(join(dir, 'objects', orphanId, 'data.bin'), 'utf8'), 'orphan')
  assert.equal(readFileSync(join(dir, 'objects', '.staging', `${stagingId}.part`), 'utf8'), 'partial')
})

test('the quota is null by default (retention policy unchanged)', () => {
  const store = new ArtifactStore({ root: root() })
  assert.equal(store.quotaBytes, null)
})

test('a zero quota stops publication entirely', async () => {
  const store = new ArtifactStore({ root: root(), quotaBytes: 0 })
  await assert.rejects(
    () => store.stage({ scopeId: 's', kind: 'download', fileName: 'a.bin', bytes: Buffer.from('x'), sourceSessionId: 'sess' }),
    (error) => error instanceof ArtifactError && error.code === 'QUOTA',
  )
})

test('concurrent staging cannot both fit under the same quota snapshot', async () => {
  const store = new ArtifactStore({ root: root(), quotaBytes: 10 })
  const results = await Promise.allSettled([
    store.stage({ scopeId: 's', kind: 'download', fileName: 'a.bin', bytes: Buffer.from('12345678'), sourceSessionId: 'sess' }),
    store.stage({ scopeId: 's', kind: 'download', fileName: 'b.bin', bytes: Buffer.from('12345678'), sourceSessionId: 'sess' }),
  ])
  const fulfilled = results.filter((item) => item.status === 'fulfilled')
  const rejected = results.filter((item) => item.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].reason.code, 'QUOTA')
  const stats = await store.stats({ scopeId: 's' })
  assert.ok(stats.bytes <= 10, `staged bytes ${stats.bytes} stay within quota`)
})
