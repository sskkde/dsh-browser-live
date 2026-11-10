/**
 * dsh-browser-live — artifact collector tests.
 *
 * Completion is a rename, not a size that stopped changing (P0 C11): the
 * collector must ignore `.crdownload`/`Unconfirmed` temp names, publish each
 * completed file exactly once per version, and stay idempotent across scans.
 *
 * Run with `node --test test/sharing-collector.test.mjs`.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactIndex, collectDirectory, collectSessionArtifacts, fileKey, isCompletedFileName } from '../lib/sharing/collector.js'

const dir = () => mkdtempSync(join(tmpdir(), 'dsh-collector-'))

function fakeStore() {
  const calls = []
  const objects = new Map()
  return {
    calls,
    objects,
    async stage({ scopeId, kind, fileName, bytes, sourceSessionId }) {
      const chunks = []
      for await (const chunk of bytes) chunks.push(chunk)
      const buffer = Buffer.concat(chunks)
      const artifactId = `a-${calls.length + 1}`
      calls.push({ op: 'stage', fileName, kind, scopeId, sourceSessionId, size: buffer.length })
      objects.set(artifactId, buffer)
      return { artifactId, stagedPath: `/staging/${artifactId}` }
    },
    async publish({ artifactId }) {
      calls.push({ op: 'publish', artifactId })
      const bytes = objects.get(artifactId)
      return { artifactId, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    },
  }
}

test('completion names exclude Chromium temp files', () => {
  assert.equal(isCompletedFileName('report.pdf'), true)
  assert.equal(isCompletedFileName('Unconfirmed 1234.crdownload'), false)
  assert.equal(isCompletedFileName('report.pdf.crdownload'), false)
  assert.equal(isCompletedFileName('part.tmp'), false)
  assert.equal(isCompletedFileName('.hidden'), false)
  assert.equal(isCompletedFileName(''), false)
})

test('a completed file is staged and published once', async () => {
  const folder = dir()
  writeFileSync(join(folder, 'report.pdf'), Buffer.from('PDF'))
  const store = fakeStore()
  const index = new ArtifactIndex(join(folder, '.index.json'))
  const outcome = await collectDirectory({ dir: folder, kind: 'download', store, scopeId: 's', sessionId: 'sess', index })
  assert.equal(outcome.published.length, 1)
  assert.equal(outcome.published[0].name, 'report.pdf')
  assert.deepEqual(store.calls.map((call) => call.op), ['stage', 'publish'])
  assert.equal(store.calls[0].size, 3)
})

test('a second scan publishes nothing new', async () => {
  const folder = dir()
  writeFileSync(join(folder, 'report.pdf'), Buffer.from('PDF'))
  const store = fakeStore()
  const index = new ArtifactIndex(join(folder, '.index.json'))
  await collectDirectory({ dir: folder, kind: 'download', store, scopeId: 's', sessionId: 'sess', index })
  const second = await collectDirectory({ dir: folder, kind: 'download', store, scopeId: 's', sessionId: 'sess', index })
  assert.equal(second.published.length, 0)
  assert.equal(second.skipped, 1)
})

test('a changed file is a new version and is published again', async () => {
  const folder = dir()
  const file = join(folder, 'report.pdf')
  writeFileSync(file, Buffer.from('PDF'))
  const store = fakeStore()
  const index = new ArtifactIndex(join(folder, '.index.json'))
  await collectDirectory({ dir: folder, kind: 'download', store, scopeId: 's', sessionId: 'sess', index })
  writeFileSync(file, Buffer.from('PDF v2'))
  const second = await collectDirectory({ dir: folder, kind: 'download', store, scopeId: 's', sessionId: 'sess', index })
  assert.equal(second.published.length, 1)
  assert.equal(second.published[0].size, 6)
})

test('temp and empty files are ignored', async () => {
  const folder = dir()
  writeFileSync(join(folder, 'Unconfirmed 99.crdownload'), Buffer.from('x'))
  writeFileSync(join(folder, 'empty.pdf'), Buffer.alloc(0))
  writeFileSync(join(folder, 'ok.pdf'), Buffer.from('ok'))
  const store = fakeStore()
  const outcome = await collectDirectory({
    dir: folder,
    kind: 'download',
    store,
    scopeId: 's',
    sessionId: 'sess',
    index: new ArtifactIndex(join(folder, '.index.json')),
  })
  assert.deepEqual(outcome.published.map((item) => item.name), ['ok.pdf'])
})

test('a publish failure is reported and retried on the next scan', async () => {
  const folder = dir()
  writeFileSync(join(folder, 'report.pdf'), Buffer.from('PDF'))
  let failures = 1
  const store = {
    async stage() {
      if (failures-- > 0) throw new Error('disk full')
      return { artifactId: 'a-1' }
    },
    async publish() { return { size: 3, sha256: 'x' } },
    calls: [{ op: 'stage' }],
  }
  const index = new ArtifactIndex(join(folder, '.index.json'))
  const first = await collectDirectory({ dir: folder, kind: 'download', store, scopeId: 's', sessionId: 'sess', index })
  assert.equal(first.failed.length, 1)
  assert.equal(index.get('report.pdf', fileKey({ size: 3, mtimeMs: 0 })), null)
  const second = await collectDirectory({ dir: folder, kind: 'download', store, scopeId: 's', sessionId: 'sess', index })
  assert.equal(second.published.length, 1)
})

test('the index survives a process restart', async () => {
  const folder = dir()
  writeFileSync(join(folder, 'report.pdf'), Buffer.from('PDF'))
  const indexFile = join(folder, '.index.json')
  const store = fakeStore()
  const index = new ArtifactIndex(indexFile)
  await collectDirectory({ dir: folder, kind: 'download', store, scopeId: 's', sessionId: 'sess', index })
  const reloaded = ArtifactIndex.load(indexFile)
  const again = await collectDirectory({ dir: folder, kind: 'download', store, scopeId: 's', sessionId: 'sess', index: reloaded })
  assert.equal(again.published.length, 0)
})

test('a missing directory is an empty scan, not an error', async () => {
  const outcome = await collectDirectory({
    dir: join(tmpdir(), 'dsh-collector-does-not-exist'),
    kind: 'screenshot',
    store: fakeStore(),
    scopeId: 's',
    sessionId: 'sess',
    index: new ArtifactIndex(join(tmpdir(), 'x.json')),
  })
  assert.deepEqual(outcome, { published: [], skipped: 0, failed: [] })
})

test('a session scan covers screenshots and downloads with separate indexes', async () => {
  const base = dir()
  mkdirSync(join(base, 'downloads'), { recursive: true })
  writeFileSync(join(base, 'recipe-1.png'), Buffer.from('png'))
  writeFileSync(join(base, 'downloads', 'report.pdf'), Buffer.from('pdf'))
  const store = fakeStore()
  const first = await collectSessionArtifacts({ store, scopeId: 's', sessionId: 'sess', baseDir: base })
  assert.deepEqual(first.published.map((item) => item.name).sort(), ['recipe-1.png', 'report.pdf'])
  const second = await collectSessionArtifacts({ store, scopeId: 's', sessionId: 'sess', baseDir: base })
  assert.equal(second.published.length, 0)
})
