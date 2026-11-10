import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { ArtifactError, ArtifactStore, safeExportName } from '../lib/sharing/artifact-store.js'

async function fixture(t, options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-store-'))
  t.after(async () => fs.rm(temp, { recursive: true, force: true }))
  const root = path.join(temp, 'artifacts')
  let tick = 1_800_000_000_000
  const store = new ArtifactStore({ root, now: () => tick++, ...options })
  return { root, store }
}

async function staged(store, { fileName = 'report.pdf', bytes = Buffer.from('artifact bytes'), kind = 'pdf', ...rest } = {}) {
  return store.stage({
    scopeId: 'trusted-scope',
    kind,
    fileName,
    bytes,
    sourceSessionId: 'session-a',
    ...rest,
  })
}

async function publish(store, data) {
  const stagedResult = await staged(store, data)
  return { stagedResult, record: await store.publish({ scopeId: 'trusted-scope', artifactId: stagedResult.artifactId }) }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

test('stage, publish, info, and read round-trip bytes with SHA-256 verification', async (t) => {
  const { store } = await fixture(t)
  const bytes = Buffer.from('round-trip payload\0with bytes')
  const result = await store.stage({
    scopeId: 'trusted-scope',
    kind: 'download',
    fileName: 'report.bin',
    bytes: Readable.from([bytes.subarray(0, 8), bytes.subarray(8)]),
    sourceSessionId: 'session-a',
  })
  const record = await store.publish({ scopeId: 'trusted-scope', artifactId: result.artifactId })

  assert.equal(record.artifactId, result.artifactId)
  assert.equal(record.size, bytes.length)
  assert.equal(record.sha256, sha256(bytes))
  assert.deepEqual(await store.info({ scopeId: 'trusted-scope', artifactId: result.artifactId }), record)
  assert.deepEqual(await store.read({ scopeId: 'trusted-scope', artifactId: result.artifactId }), bytes)
  assert.deepEqual(await store.verify({ scopeId: 'trusted-scope', artifactId: result.artifactId }), {
    ok: true,
    expected: sha256(bytes),
    actual: sha256(bytes),
  })
})

test('same fileName publishes distinct immutable object ids', async (t) => {
  const { store } = await fixture(t)
  const first = await publish(store, { fileName: 'same.txt', bytes: Buffer.from('one') })
  const second = await publish(store, { fileName: 'same.txt', bytes: Buffer.from('two') })

  assert.notEqual(first.record.artifactId, second.record.artifactId)
  assert.equal(first.record.fileName, 'same.txt')
  assert.equal(second.record.fileName, 'same.txt')
  assert.deepEqual(await store.read({ scopeId: 'trusted-scope', artifactId: first.record.artifactId }), Buffer.from('one'))
  assert.deepEqual(await store.read({ scopeId: 'trusted-scope', artifactId: second.record.artifactId }), Buffer.from('two'))
})

test('publishing the same artifact id twice is idempotent', async (t) => {
  const { store } = await fixture(t)
  const stagedResult = await staged(store)
  const first = await store.publish({ scopeId: 'trusted-scope', artifactId: stagedResult.artifactId })
  const second = await store.publish({ scopeId: 'trusted-scope', artifactId: stagedResult.artifactId })
  assert.deepEqual(second, first)
})

test('list is newest-first, filters by kind, and paginates with a cursor', async (t) => {
  const { store } = await fixture(t)
  const older = await publish(store, { fileName: 'old.pdf', bytes: Buffer.from('old'), kind: 'pdf' })
  const middle = await publish(store, { fileName: 'middle.png', bytes: Buffer.from('middle'), kind: 'screenshot' })
  const newest = await publish(store, { fileName: 'new.pdf', bytes: Buffer.from('new'), kind: 'pdf' })

  const firstPage = await store.list({ scopeId: 'trusted-scope', limit: 2 })
  assert.deepEqual(firstPage.items.map((item) => item.artifactId), [newest.record.artifactId, middle.record.artifactId])
  assert.ok(firstPage.nextCursor)
  const secondPage = await store.list({ scopeId: 'trusted-scope', limit: 2, cursor: firstPage.nextCursor })
  assert.deepEqual(secondPage.items.map((item) => item.artifactId), [older.record.artifactId])
  assert.equal(secondPage.nextCursor, null)
  const pdfs = await store.list({ scopeId: 'trusted-scope', kind: 'pdf' })
  assert.deepEqual(pdfs.items.map((item) => item.artifactId), [newest.record.artifactId, older.record.artifactId])
})

test('list rebuilds from metadata when index.json is deleted', async (t) => {
  const { root, store } = await fixture(t)
  const published = await publish(store, { fileName: 'indexed.txt' })
  await store.list({ scopeId: 'trusted-scope' })
  const indexPath = path.join(root, 'index.json')
  assert.equal((await fs.stat(indexPath)).isFile(), true)
  await fs.unlink(indexPath)

  const result = await store.list({ scopeId: 'trusted-scope' })
  assert.deepEqual(result.items.map((item) => item.artifactId), [published.record.artifactId])
})

test('staged artifacts are invisible to list and visible to stats', async (t) => {
  const { store } = await fixture(t)
  await staged(store, { bytes: Buffer.from('pending') })

  assert.deepEqual((await store.list({ scopeId: 'trusted-scope' })).items, [])
  const stats = await store.stats({ scopeId: 'trusted-scope' })
  assert.equal(stats.objects, 0)
  assert.equal(stats.staging, 1)
  assert.equal(stats.bytes, Buffer.byteLength('pending'))
})

test('an object renamed before metadata commit stays invisible but is counted', async (t) => {
  const { root, store } = await fixture(t)
  const bytes = Buffer.from('renamed but uncommitted')
  const stagedResult = await staged(store, { bytes })
  const objectDir = path.join(root, 'objects', stagedResult.artifactId)
  await fs.mkdir(objectDir, { mode: 0o700 })
  await fs.rename(stagedResult.stagedPath, path.join(objectDir, 'data.bin'))

  assert.deepEqual((await store.list({ scopeId: 'trusted-scope' })).items, [])
  const stats = await store.stats({ scopeId: 'trusted-scope' })
  assert.equal(stats.objects, 1)
  assert.equal(stats.staging, 1)
  assert.equal(stats.bytes, bytes.length)
  assert.equal(Object.values(stats.byKind).reduce((sum, value) => sum + value, 0), 0)
})

test('oversize stream is refused and leaves no staging file', async (t) => {
  const { root, store } = await fixture(t, { maxStageBytes: 4 })
  await assert.rejects(
    () => staged(store, { bytes: Readable.from([Buffer.from('123'), Buffer.from('45')]) }),
    (error) => error instanceof ArtifactError && error.code === 'OVERSIZE',
  )
  const stagingDir = path.join(root, 'objects', '.staging')
  assert.deepEqual(await fs.readdir(stagingDir), [])
  assert.deepEqual(await store.stats({ scopeId: 'trusted-scope' }), {
    objects: 0,
    staging: 0,
    bytes: 0,
    byKind: { download: 0, screenshot: 0, pdf: 0, other: 0 },
  })
})

test('unfinished .crdownload inputs cannot be staged as completed downloads', async (t) => {
  const { root, store } = await fixture(t)
  await assert.rejects(
    () => staged(store, { fileName: 'report.pdf.crdownload', kind: 'download' }),
    (error) => error instanceof ArtifactError && error.code === 'CONFLICT',
  )
  await store.stats({ scopeId: 'trusted-scope' })
  const stagingDir = path.join(root, 'objects', '.staging')
  assert.deepEqual(await fs.readdir(stagingDir), [])
})

test('verify detects a flipped byte in a published object', async (t) => {
  const { root, store } = await fixture(t)
  const { record } = await publish(store, { bytes: Buffer.from('original') })
  const dataPath = path.join(root, 'objects', record.artifactId, 'data.bin')
  await fs.writeFile(dataPath, Buffer.from('Original'))

  const result = await store.verify({ scopeId: 'trusted-scope', artifactId: record.artifactId })
  assert.equal(result.ok, false)
  assert.equal(result.expected, sha256(Buffer.from('original')))
  assert.equal(result.actual, sha256(Buffer.from('Original')))
})

test('hostile artifact ids are rejected before path resolution', async (t) => {
  const { store } = await fixture(t)
  for (const artifactId of ['../x', path.resolve('/tmp/x'), 'not-a-uuid']) {
    await assert.rejects(
      () => store.info({ scopeId: 'trusted-scope', artifactId }),
      (error) => error instanceof ArtifactError && error.code === 'CONFLICT',
    )
  }
})

test('source URL metadata retains only the origin', async (t) => {
  const { root, store } = await fixture(t)
  const { record } = await publish(store, {
    sourceUrl: 'https://person:secret@example.test/private/path?token=secret#fragment',
  })
  assert.equal(record.sourceUrl, 'https://example.test')
  const metadataText = await fs.readFile(path.join(root, 'metadata', `${record.artifactId}.json`), 'utf8')
  assert.doesNotMatch(metadataText, /secret|private|token|fragment/)
})

test('metadata preserves raw fileName as JSON-escaped data and sanitizes displayName', async (t) => {
  const { root, store } = await fixture(t)
  const fileName = 'report\u0001\n\u0085name.pdf'
  const { record } = await publish(store, { fileName })
  const metadataText = await fs.readFile(path.join(root, 'metadata', `${record.artifactId}.json`), 'utf8')
  const metadata = JSON.parse(metadataText)

  assert.equal(metadata.fileName, fileName)
  assert.equal(metadata.displayName, 'report\uFFFD\uFFFD\uFFFDname.pdf')
  assert.doesNotMatch(metadataText.slice(0, -1), /[\u0000-\u001f\u007f-\u009f]/)
})

test('safeExportName strips control chars, separators, and leading dots', () => {
  assert.equal(safeExportName('..\u0000../folder\\report  final.pdf'), 'folderreport final.pdf')
  assert.equal(safeExportName('...'), 'artifact')
  assert.equal(safeExportName('x'.repeat(130)).length, 120)
})

test('created directories and files use 0700 and 0600 permissions', async (t) => {
  const { root, store } = await fixture(t)
  const { stagedResult, record } = await publish(store, { fileName: 'mode.txt' })
  const dirs = [root, path.join(root, 'objects'), path.join(root, 'objects', '.staging'), path.join(root, 'objects', record.artifactId), path.join(root, 'metadata')]
  for (const dir of dirs) assert.equal((await fs.stat(dir)).mode & 0o777, 0o700, dir)
  const files = [path.join(root, 'objects', record.artifactId, 'data.bin'), path.join(root, 'metadata', `${record.artifactId}.json`)]
  for (const file of files) assert.equal((await fs.stat(file)).mode & 0o777, 0o600, file)
  assert.equal(stagedResult.stagedPath.endsWith('.part'), true)
})
