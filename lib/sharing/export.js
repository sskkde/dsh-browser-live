/**
 * dsh-browser-live — artifact export.
 *
 * `browser_live_artifact save` (and the legacy `browser_live_download save`)
 * copy a file into the caller's workspace. The rules that matter more than the
 * copy itself:
 *
 *  - the host filesystem service must resolve and contain the target, the host
 *    `fs/write-intent` waterfall must be consulted, and the session's sandbox
 *    policy must allow the write — all BEFORE any directory is created;
 *  - an existing file is never overwritten, and the write itself is exclusive;
 *  - the final open happens relative to an opened, no-follow parent directory
 *    handle, so replacing a checked parent with a symlink cannot redirect the
 *    write outside the authorized root.
 *
 * The host filesystem service in DSH 0.2.1-rc.2 exposes text writes only
 * (`writeText`); there is no binary write API. A screenshot/PDF/download is
 * therefore written through the same authorization seam the text tool uses —
 * `fs.resolve` + `contains` + `fs/write-intent` + the resolved
 * `SandboxExecutionPolicy` — and the bytes are published with
 * `O_EXCL|O_NOFOLLOW`. The real-backend integration test exercises this path; a
 * fake filesystem alone is not treated as proof of authorization.
 */

import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0
const O_DIRECTORY = constants.O_DIRECTORY ?? 0

/**
 * Copy one published artifact into a workspace path.
 * @param {{ store: object, fileSystem: object, ctx: object, exec?: object, scopeId: string, artifactId: string, targetPath: string, cwd: string }} input - export request.
 * @returns {Promise<{ artifactId: string, path: string, bytes: number }>} written file facts.
 */
export async function exportArtifact({ store, fileSystem, ctx, exec = undefined, scopeId, artifactId, targetPath, cwd }) {
  requireHostContext({ fileSystem, ctx })
  const record = await store.info({ scopeId, artifactId })
  if (record === null) throw new Error(`no artifact ${artifactId} in this scope`)
  const bytes = await store.read({ scopeId, artifactId })
  const written = await writeIntoWorkspace({ fileSystem, ctx, exec, targetPath, cwd, bytes })
  return { artifactId, path: written.path, bytes: bytes.length }
}

/**
 * Copy a host file (a session's private download) into the caller's workspace
 * with the same containment/intent/sandbox checks as {@link exportArtifact}.
 * @param {{ sourcePath: string, targetPath: string, cwd: string, fileSystem: object, ctx: object, exec?: object }} input - copy request.
 * @returns {Promise<{ path: string, bytes: number }>} written file facts.
 */
export async function copyFileIntoWorkspace({ sourcePath, targetPath, cwd, fileSystem, ctx, exec = undefined }) {
  requireHostContext({ fileSystem, ctx })
  const source = await fs.open(sourcePath, constants.O_RDONLY | O_NOFOLLOW)
  try {
    const stat = await source.stat()
    if (!stat.isFile()) throw new Error('artifact source is not a regular file')
    return await writeIntoWorkspace({ fileSystem, ctx, exec, targetPath, cwd, sourceHandle: source, size: stat.size })
  } finally {
    await source.close().catch(() => undefined)
  }
}

/** A write without the host policy seams is a bypass, not a fallback. */
function requireHostContext({ fileSystem, ctx }) {
  if (fileSystem === undefined || fileSystem === null || typeof fileSystem.resolve !== 'function') {
    throw new Error('host filesystem service is unavailable; refusing an unchecked write')
  }
  if (ctx === undefined || ctx === null || typeof ctx.waterfall !== 'function' || typeof ctx.get !== 'function') {
    throw new Error('host authorization context is unavailable; refusing an unchecked write')
  }
}

/**
 * Authorize and publish one file into the workspace.
 * @param {{ fileSystem: object, ctx: object, exec: object | undefined, targetPath: string, cwd: string, bytes?: Buffer, sourceHandle?: object, size?: number }} input
 * @returns {Promise<{ path: string, bytes: number }>}
 */
async function writeIntoWorkspace({ fileSystem, ctx, exec, targetPath, cwd, bytes = null, sourceHandle = null, size = null }) {
  const workspace = await fileSystem.resolve(cwd)
  const lexical = path.resolve(cwd, targetPath)
  const workspacePath = fileSystem.processPath(workspace)
  // Authorization order matters: refuse read-only/out-of-root targets before
  // creating a single directory. The canonical re-check happens after mkdir.
  await assertSandboxAllowsLexical({ ctx, exec, lexical, workspacePath, targetPath })
  await ensureWorkspaceParent({ fileSystem, workspace, cwd, targetPath })
  // Reject a symlink at the final component BEFORE resolving: `resolve` follows
  // it, and a link pointing outside would otherwise be reported as an
  // out-of-workspace path instead of the link it is.
  if (typeof fileSystem.lstat === 'function') {
    let link
    try {
      link = await fileSystem.lstat(lexical, { cwd })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (link !== undefined && link !== null && (link.type === 'symlink' || link.isSymbolicLink === true)) {
      throw new Error(`refusing to write through a symbolic link: ${targetPath}`)
    }
  }
  const target = await fileSystem.resolve(lexical, { cwd })
  const parent = await fileSystem.resolve(path.dirname(lexical), { cwd })
  if (!fileSystem.contains(workspace, parent) || !fileSystem.contains(workspace, target)) {
    throw new Error(`refusing to write outside the workspace: ${targetPath}`)
  }
  const existing = await fileSystem.stat(target)
  if (existing !== undefined && existing !== null) {
    throw new Error(`refusing to overwrite an existing file: ${targetPath}`)
  }

  const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
  if (intent?.kind === 'replaceIfVersion') {
    throw new Error(`refusing to replace an observed file without an overwrite grant: ${targetPath}`)
  }
  await assertSandboxAllowsCanonical({ ctx, exec, fileSystem, target, targetPath })

  const processPath = fileSystem.processPath(target)
  const parentProcessPath = fileSystem.processPath(parent)
  const written = await writeExclusive({
    parentProcessPath,
    baseName: path.basename(processPath),
    bytes,
    sourceHandle,
    size,
    ctx,
    exec,
    workspaceProcessPath: workspacePath,
    targetPath,
  })
  return { path: targetPath, bytes: written }
}

/**
 * Open the parent directory itself (no-follow), prove it is still inside the
 * workspace and sandbox root, then create the file relative to that handle via
 * `/proc/self/fd`. This closes the parent-symlink TOCTOU window that a
 * pathname-based open leaves.
 */
async function writeExclusive({ parentProcessPath, baseName, bytes, sourceHandle, size, ctx, exec, workspaceProcessPath, targetPath }) {
  const parentReal = await fs.realpath(parentProcessPath)
  const workspaceReal = await fs.realpath(workspaceProcessPath)
  if (!isInside(workspaceReal, parentReal)) throw new Error(`refusing to write outside the workspace: ${targetPath}`)
  const policy = resolveSandboxPolicy({ ctx, exec })
  if (policy !== null && policy.mode !== 'danger-full-access') {
    const root = await fs.realpath(policy.workspaceRoot)
    if (!isInside(root, parentReal)) throw new Error(`file access denied under workspace-write mode: ${targetPath}`)
  }
  let dirHandle = null
  let handle = null
  try {
    dirHandle = await fs.open(parentReal, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    const fdDir = `/proc/self/fd/${dirHandle.fd}`
    // The opened directory's real identity, not the pathname that was checked.
    const actualParent = await fs.realpath(fdDir).catch(() => null)
    if (actualParent !== null) {
      if (!isInside(workspaceReal, actualParent)) {
        throw new Error(`refusing to write through a replaced parent directory: ${targetPath}`)
      }
      if (policy !== null && policy.mode !== 'danger-full-access') {
        const root = await fs.realpath(policy.workspaceRoot)
        if (!isInside(root, actualParent)) throw new Error(`file access denied under workspace-write mode: ${targetPath}`)
      }
    } else if (!isInside(workspaceReal, parentReal)) {
      // Non-Linux hosts have no /proc/self/fd: keep the path-based open, but the
      // no-follow directory handle above still closes the ordinary symlink case.
      throw new Error(`refusing to write outside the workspace: ${targetPath}`)
    }
    const fdPath = actualParent === null ? path.join(parentReal, baseName) : path.join(fdDir, baseName)
    handle = await fs.open(fdPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600)
    let written = 0
    await handle.chmod(0o600)
    if (bytes !== null) {
      await handle.writeFile(bytes)
      written = bytes.length
    } else {
      const buffer = Buffer.allocUnsafe(1024 * 1024)
      let position = 0
      while (true) {
        const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break
        let offset = 0
        while (offset < bytesRead) {
          const { bytesWritten } = await handle.write(buffer, offset, bytesRead - offset, written + offset)
          if (bytesWritten <= 0) throw new Error('target write made no progress')
          offset += bytesWritten
        }
        position += bytesRead
        written += bytesRead
        if (size !== null && written > size) throw new Error('source file grew while copying; refusing a partial artifact')
      }
    }
    await handle.sync()
    const after = await handle.stat()
    const onDisk = await fs.lstat(fdPath)
    if (!after.isFile() || after.dev !== onDisk.dev || after.ino !== onDisk.ino) {
      throw new Error('target changed while writing; refusing to report success')
    }
    await syncDirectoryHandle(dirHandle)
    return written
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined)
    if (dirHandle !== null) await dirHandle.close().catch(() => undefined)
  }
}

/**
 * Create missing parent directories for a workspace target, refusing any
 * existing component that is a symlink or not a directory. Returns the lexical
 * (unresolved) target; the caller still resolves and re-checks containment.
 * @param {{ fileSystem: object, workspace: object, cwd: string, targetPath: string }} input
 * @returns {Promise<string>} absolute lexical target path.
 */
async function ensureWorkspaceParent({ fileSystem, workspace, cwd, targetPath }) {
  const workspacePath = fileSystem.processPath(workspace)
  const lexical = path.resolve(cwd, targetPath)
  const relative = path.relative(workspacePath, lexical)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`refusing to write outside the workspace: ${targetPath}`)
  }
  let current = workspacePath
  for (const part of relative.split(path.sep).slice(0, -1)) {
    if (part === '') continue
    current = path.join(current, part)
    let stat
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await fs.mkdir(current, { recursive: true })
      continue
    }
    if (stat.isSymbolicLink()) throw new Error(`refusing to write through a symbolic link: ${targetPath}`)
    if (!stat.isDirectory()) throw new Error(`target parent is not a directory: ${targetPath}`)
  }
  return lexical
}

/** Resolve the per-session sandbox policy; a missing policy is not permission. */
function resolveSandboxPolicy({ ctx, exec }) {
  const policy = ctx.get('sandboxPolicy')
  if (policy === undefined || policy === null || typeof policy.resolve !== 'function') return null
  const resolved = policy.resolve({ session: exec?.agent?.session })
  return resolved === undefined || resolved === null || resolved.mode === undefined ? null : resolved
}

/** Lexical sandbox check, before any directory exists. */
async function assertSandboxAllowsLexical({ ctx, exec, lexical, workspacePath, targetPath }) {
  const policy = resolveSandboxPolicy({ ctx, exec })
  if (policy === null) throw new Error(`sandbox policy is unavailable; refusing an unchecked write: ${targetPath}`)
  if (policy.mode === 'danger-full-access') return
  if (policy.mode === 'read-only') throw new Error(`file access denied under read-only mode: ${targetPath}`)
  if (policy.mode !== 'workspace-write') throw new Error(`file access denied under ${String(policy.mode)} mode: ${targetPath}`)
  if (!isInside(workspacePath, lexical)) throw new Error(`refusing to write outside the workspace: ${targetPath}`)
  if (!isInside(path.resolve(policy.workspaceRoot), lexical)) throw new Error(`file access denied under workspace-write mode: ${targetPath}`)
}

/** Canonical sandbox check, after the parent exists. */
async function assertSandboxAllowsCanonical({ ctx, exec, fileSystem, target, targetPath }) {
  const policy = resolveSandboxPolicy({ ctx, exec })
  if (policy === null) throw new Error(`sandbox policy is unavailable; refusing an unchecked write: ${targetPath}`)
  if (policy.mode === 'danger-full-access') return
  if (policy.mode === 'read-only') throw new Error(`file access denied under read-only mode: ${targetPath}`)
  if (policy.mode !== 'workspace-write') throw new Error(`file access denied under ${String(policy.mode)} mode: ${targetPath}`)
  const root = await fs.realpath(policy.workspaceRoot)
  const parent = await fs.realpath(path.dirname(fileSystem.processPath(target)))
  if (!isInside(root, parent)) throw new Error(`file access denied under workspace-write mode: ${targetPath}`)
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

async function syncDirectoryHandle(handle) {
  try {
    await handle.sync()
  } catch {
    // directory fsync is best-effort on filesystems that reject it
  }
}
