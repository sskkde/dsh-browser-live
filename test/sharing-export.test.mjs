/**
 * dsh-browser-live — artifact export tests.
 *
 * The export is the one place a shared object touches the caller's workspace,
 * so the tests focus on the two refusals that matter (outside the workspace, an
 * existing file) and on the exclusive write.
 *
 * Run with `node --test test/sharing-export.test.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { exportArtifact } from '../lib/sharing/export.js'

const workspace = () => mkdtempSync(join(tmpdir(), 'dsh-export-'))

function fakeStore(bytes) {
  return {
    async info({ artifactId }) { return artifactId === 'a1' ? { artifactId, size: bytes.length } : null },
    async read() { return bytes },
  }
}

function fakeFs(root) {
  return {
    async resolve(value) { return { targetKey: resolve(value) } },
    contains(parent, child) {
      const rel = relative(resolve(parent.targetKey), resolve(child.targetKey))
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    },
    async stat(target) {
      try {
        readFileSync(target.targetKey)
        return { size: 1 }
      } catch {
        return undefined
      }
    },
    processPath(target) { return target.targetKey },
  }
}

test('a published artifact is written into the workspace', async () => {
  const root = workspace()
  const targetPath = join(root, 'out.bin')
  const result = await exportArtifact({
    store: fakeStore(Buffer.from('hello')),
    fileSystem: fakeFs(root),
    scopeId: 's',
    artifactId: 'a1',
    targetPath,
    cwd: root,
  })
  assert.equal(result.bytes, 5)
  assert.equal(readFileSync(targetPath, 'utf8'), 'hello')
})

test('a target outside the workspace is refused', async () => {
  const root = workspace()
  await assert.rejects(
    () => exportArtifact({
      store: fakeStore(Buffer.from('x')),
      fileSystem: fakeFs(root),
      scopeId: 's',
      artifactId: 'a1',
      targetPath: '/etc/passwd',
      cwd: root,
    }),
    /outside the workspace/,
  )
})

test('an existing file is never overwritten by default', async () => {
  const root = workspace()
  const targetPath = join(root, 'out.bin')
  writeFileSync(targetPath, 'keep me')
  await assert.rejects(
    () => exportArtifact({
      store: fakeStore(Buffer.from('new')),
      fileSystem: fakeFs(root),
      scopeId: 's',
      artifactId: 'a1',
      targetPath,
      cwd: root,
    }),
    /refusing to overwrite/,
  )
  assert.equal(readFileSync(targetPath, 'utf8'), 'keep me')
})

test('an unknown artifact is refused', async () => {
  const root = workspace()
  await assert.rejects(
    () => exportArtifact({
      store: fakeStore(Buffer.from('x')),
      fileSystem: fakeFs(root),
      scopeId: 's',
      artifactId: 'missing',
      targetPath: join(root, 'out.bin'),
      cwd: root,
    }),
    /no artifact/,
  )
})

test('a missing host filesystem service fails closed', async () => {
  await assert.rejects(
    () => exportArtifact({ store: fakeStore(Buffer.from('x')), fileSystem: null, scopeId: 's', artifactId: 'a1', targetPath: 'x', cwd: '/' }),
    /filesystem service is unavailable/,
  )
})
