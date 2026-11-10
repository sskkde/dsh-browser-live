/**
 * dsh-browser-live — artifact export.
 *
 * `browser_live_artifact save` copies a published object into the caller's
 * workspace. Two rules matter more than the copy itself:
 *
 *  - the target must be resolved and contained by the host filesystem service
 *    (the same policy the built-in edit tools obey), never a bare path join;
 *  - an existing file is never overwritten, and the write itself is exclusive.
 *
 * The host filesystem service exposes text writes only, so a binary export
 * resolves the target through it (canonical path, containment, symlink
 * handling) and then writes the resolved process path with O_EXCL.
 */

import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

/**
 * Copy one artifact into a workspace path.
 * @param {{ store: object, fileSystem: object, scopeId: string, artifactId: string, targetPath: string, cwd: string, overwrite?: boolean }} input - export request.
 * @returns {Promise<{ artifactId: string, path: string, bytes: number }>} written file facts.
 */
export async function exportArtifact({ store, fileSystem, scopeId, artifactId, targetPath, cwd, overwrite = false }) {
  if (fileSystem === undefined || fileSystem === null || typeof fileSystem.resolve !== 'function') {
    throw new Error('host filesystem service is unavailable; refusing an unchecked write')
  }
  const record = await store.info({ scopeId, artifactId })
  if (record === null) throw new Error(`no artifact ${artifactId} in this scope`)
  const bytes = await store.read({ scopeId, artifactId })

  const workspace = await fileSystem.resolve(cwd)
  const target = await fileSystem.resolve(targetPath, { cwd })
  const parent = await fileSystem.resolve(path.dirname(targetPath), { cwd })
  if (!fileSystem.contains(workspace, parent) || !fileSystem.contains(workspace, target)) {
    throw new Error(`refusing to write outside the workspace: ${targetPath}`)
  }
  const existing = await fileSystem.stat(target)
  if (existing !== undefined && existing !== null && overwrite !== true) {
    throw new Error(`refusing to overwrite an existing file: ${targetPath}`)
  }

  const processPath = fileSystem.processPath(target)
  const handle = await fs.open(processPath, overwrite === true ? constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return { artifactId, path: targetPath, bytes: bytes.length }
}
