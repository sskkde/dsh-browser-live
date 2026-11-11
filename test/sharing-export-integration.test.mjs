/**
 * dsh-browser-live — real filesystem export integration.
 *
 * A fake filesystem proves the shape of the checks, not that the host's
 * `@deepseek-ai/dsh-fs` backend accepts them. These tests load the real
 * `dsh-fs-local` implementation from the harness checkout and run the export
 * against it: canonical resolution, containment, `lstat` symlink rejection, the
 * `fs/write-intent` waterfall, and the sandbox policy gate.
 *
 * The checkout is located through `DSH_CHECKOUT`. When it is unavailable the
 * tests are skipped, not faked; no developer-local path is hardcoded.
 *
 * Run with `node --test test/sharing-export-integration.test.mjs`.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { copyFileIntoWorkspace, exportArtifact } from '../lib/sharing/export.js'

const checkout = process.env.DSH_CHECKOUT ?? ''
let LocalFileSystem = null
if (checkout !== '') {
  try {
    const module = await import(pathToFileURL(join(checkout, 'node_modules', '@deepseek-ai', 'dsh-fs-local', 'lib', 'index.js')).href)
    LocalFileSystem = module.LocalFileSystem ?? module.default
  } catch {
    LocalFileSystem = null
  }
}
const integration = { skip: LocalFileSystem === null ? 'harness checkout/dsh-fs-local not available' : false }

const workspace = () => mkdtempSync(join(tmpdir(), 'dshbl-fs-'))

function fakeStore(bytes) {
  return {
    async info() { return { artifactId: 'a1', size: bytes.length } },
    async read() { return bytes },
  }
}

function realFs(root) {
  const ctx = new Context()
  return new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 1024 * 1024 })
}

function sandbox(ctx, policy) {
  ctx.get = (name) => (name === 'sandboxPolicy' ? { resolve: () => policy } : undefined)
  return ctx
}

test('real backend: an artifact is written and the host write-intent is consulted', integration, async () => {
  const root = workspace()
  const ctx = sandbox(new Context(), { mode: 'danger-full-access', workspaceRoot: root })
  const intents = []
  ctx.on('fs/write-intent', (target) => {
    intents.push(target.targetKey)
    return { kind: 'createIfAbsent' }
  })
  const result = await exportArtifact({
    store: fakeStore(Buffer.from('binary\x00payload')),
    fileSystem: realFs(root),
    ctx,
    exec: undefined,
    scopeId: 's',
    artifactId: 'a1',
    targetPath: join(root, 'out.bin'),
    cwd: root,
  })
  assert.equal(result.bytes, 14)
  assert.deepEqual(readFileSync(join(root, 'out.bin')), Buffer.from('binary\x00payload'))
  assert.equal(intents.length, 1, 'fs/write-intent ran before the write')
})

test('real backend: outside the workspace is refused even with a resolved target', integration, async () => {
  const root = workspace()
  await assert.rejects(
    () => exportArtifact({
      store: fakeStore(Buffer.from('x')),
      fileSystem: realFs(root),
      ctx: sandbox(new Context(), { mode: 'danger-full-access', workspaceRoot: root }),
      scopeId: 's',
      artifactId: 'a1',
      targetPath: '/etc/dshbl-should-not-exist',
      cwd: root,
    }),
    /outside the workspace/,
  )
})

test('real backend: an existing file and a symlink target are refused', integration, async () => {
  const root = workspace()
  const fs = realFs(root)
  const ctx = sandbox(new Context(), { mode: 'danger-full-access', workspaceRoot: root })
  writeFileSync(join(root, 'existing.bin'), 'keep')
  await assert.rejects(
    () => exportArtifact({ store: fakeStore(Buffer.from('x')), fileSystem: fs, ctx, scopeId: 's', artifactId: 'a1', targetPath: join(root, 'existing.bin'), cwd: root }),
    /refusing to overwrite/,
  )
  assert.equal(readFileSync(join(root, 'existing.bin'), 'utf8'), 'keep')
  const outside = workspace()
  writeFileSync(join(outside, 'secret'), 'secret')
  symlinkSync(join(outside, 'secret'), join(root, 'link.bin'))
  await assert.rejects(
    () => exportArtifact({ store: fakeStore(Buffer.from('x')), fileSystem: fs, ctx, scopeId: 's', artifactId: 'a1', targetPath: join(root, 'link.bin'), cwd: root }),
    /symbolic link/,
  )
})

test('real backend: the sandbox policy denies read-only and out-of-root writes', integration, async () => {
  const root = workspace()
  const fs = realFs(root)
  await assert.rejects(
    () => exportArtifact({
      store: fakeStore(Buffer.from('x')),
      fileSystem: fs,
      ctx: sandbox(new Context(), { mode: 'read-only', workspaceRoot: root }),
      scopeId: 's',
      artifactId: 'a1',
      targetPath: join(root, 'readonly.bin'),
      cwd: root,
    }),
    /read-only/,
  )
  await assert.rejects(
    () => exportArtifact({
      store: fakeStore(Buffer.from('x')),
      fileSystem: fs,
      ctx: sandbox(new Context(), { mode: 'workspace-write', workspaceRoot: workspace() }),
      scopeId: 's',
      artifactId: 'a1',
      targetPath: join(root, 'escaped.bin'),
      cwd: root,
    }),
    /workspace-write/,
  )
})

test('real backend: a replaceIfVersion intent refuses to clobber an unobserved file', integration, async () => {
  const root = workspace()
  const ctx = sandbox(new Context(), { mode: 'danger-full-access', workspaceRoot: root })
  ctx.on('fs/write-intent', () => ({ kind: 'replaceIfVersion', version: 'v0' }))
  await assert.rejects(
    () => exportArtifact({ store: fakeStore(Buffer.from('x')), fileSystem: realFs(root), ctx, scopeId: 's', artifactId: 'a1', targetPath: join(root, 'intent.bin'), cwd: root }),
    /without an overwrite grant/,
  )
})

test('real backend: copyFileIntoWorkspace streams a session download with the same gate', integration, async () => {
  const root = workspace()
  const source = join(root, 'source.bin')
  writeFileSync(source, Buffer.from('download-bytes'))
  const ctx = sandbox(new Context(), { mode: 'danger-full-access', workspaceRoot: root })
  const written = await copyFileIntoWorkspace({
    sourcePath: source,
    targetPath: join(root, 'downloads', 'report.bin'),
    cwd: root,
    fileSystem: realFs(root),
    ctx,
  })
  assert.equal(written.bytes, 14)
  assert.equal(readFileSync(join(root, 'downloads', 'report.bin'), 'utf8'), 'download-bytes')
})


test('real backend: a symlinked parent directory is refused', integration, async () => {
  const root = workspace()
  const outside = workspace()
  symlinkSync(outside, join(root, 'escape'))
  await assert.rejects(
    () => exportArtifact({
      store: fakeStore(Buffer.from('x')),
      fileSystem: realFs(root),
      ctx: sandbox(new Context(), { mode: 'danger-full-access', workspaceRoot: root }),
      scopeId: 's',
      artifactId: 'a1',
      targetPath: join(root, 'escape', 'out.bin'),
      cwd: root,
    }),
    /symbolic link/,
  )
  assert.equal(existsSync(join(outside, 'out.bin')), false)
})

test('real backend: a denied target does not create its parent directory', integration, async () => {
  const root = workspace()
  await assert.rejects(
    () => exportArtifact({
      store: fakeStore(Buffer.from('x')),
      fileSystem: realFs(root),
      ctx: sandbox(new Context(), { mode: 'read-only', workspaceRoot: root }),
      scopeId: 's',
      artifactId: 'a1',
      targetPath: join(root, 'newdir', 'out.bin'),
      cwd: root,
    }),
    /read-only/,
  )
  assert.equal(existsSync(join(root, 'newdir')), false, 'the denial happened before mkdir')
})
