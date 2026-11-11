/**
 * dsh-browser-live — artifact collector.
 *
 * Turns the places a session's browser leaves files — its bind-mounted download
 * folder, its native screenshot folder, and the Playwright MCP `--output-dir` —
 * into immutable shared objects.
 *
 * Completion rules come from the P0 probes (docs/p0-capability-matrix.md C11):
 * Chromium writes `Unconfirmed <id>.crdownload` while the transfer runs and only
 * renames to the real name when it finishes, so a scan must accept exactly the
 * final rename and nothing else. A per-directory index remembers what was
 * already published, which keeps repeated scans idempotent without rehashing
 * every byte.
 *
 * Only verified artifact types are auto-published from the screenshot/MCP
 * directories: images as `screenshot`, PDFs as `pdf`. Anything else (MCP `.yml`,
 * `.log`, tracing/video output) stays on disk and is reported as unsupported —
 * it is never presented as screenshot-equivalent.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Temp names Chromium/Playwright use before a download is complete. */
export function isCompletedFileName(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (name.startsWith('.')) return false
  if (name.endsWith('.crdownload') || name.endsWith('.tmp') || name.endsWith('.part')) return false
  if (/^Unconfirmed /i.test(name)) return false
  return true
}

/** Artifact kind for a file name, or null when the type is not verified for that directory. */
export function kindForFile(name) {
  const lower = String(name ?? '').toLowerCase()
  if (/\.(png|jpe?g|webp|gif)$/.test(lower)) return 'screenshot'
  if (lower.endsWith('.pdf')) return 'pdf'
  return null
}

/** Stable identity for one file version. Nanosecond mtime when available (BigInt stats). */
export function fileKey(stat) {
  const size = typeof stat.size === 'bigint' ? stat.size.toString() : String(stat.size)
  const mtime = stat.mtimeNs !== undefined ? stat.mtimeNs.toString() : String(Math.floor(stat.mtimeMs * 1e6))
  return `${size}:${mtime}`
}

/**
 * Per-directory publication index. Losing it only costs a re-publish attempt;
 * the store refuses duplicates by content hash only if asked, so v1 accepts a
 * duplicate after index loss.
 */
export class ArtifactIndex {
  #file
  #entries

  /**
   * @param {string} file - absolute path of the index JSON.
   * @param {object} [entries] - preloaded entries.
   */
  constructor(file, entries = {}) {
    this.#file = file
    this.#entries = { ...entries }
  }

  static load(file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      return new ArtifactIndex(file, parsed !== null && typeof parsed === 'object' ? parsed.entries ?? {} : {})
    } catch {
      return new ArtifactIndex(file, {})
    }
  }

  /** The artifactId published for this name+version, or null. */
  get(name, key) {
    const entry = this.#entries[name]
    return entry !== undefined && entry.key === key ? entry.artifactId : null
  }

  set(name, key, artifactId) {
    this.#entries[name] = { key, artifactId }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true })
      const tmp = `${this.#file}.tmp`
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, entries: this.#entries }, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(tmp, this.#file)
    } catch {
      // a lost index only costs a re-publish attempt on the next scan
    }
  }
}

/**
 * Publish every completed file in `dir` that was not published before.
 * @param {{ dir: string, kind?: string, kindFor?: ((name: string) => string | null) | null, store: object, scopeId: string, sessionId: string, generation?: number, index: ArtifactIndex }} input - scan inputs.
 * @returns {Promise<{ published: object[], skipped: number, failed: object[], unsupported: object[] }>} scan outcome.
 */
export async function collectDirectory({ dir, kind = 'download', kindFor = null, store, scopeId, sessionId, generation = null, index }) {
  const published = []
  const failed = []
  const unsupported = []
  let skipped = 0
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return { published, skipped, failed, unsupported }
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!isCompletedFileName(entry.name)) continue
    const effectiveKind = kindFor === null ? kind : kindFor(entry.name)
    if (effectiveKind === null) {
      unsupported.push({ name: entry.name, reason: 'type-not-verified' })
      continue
    }
    const file = path.join(dir, entry.name)
    let stat
    try {
      stat = fs.statSync(file, { bigint: true })
    } catch {
      continue
    }
    if (!stat.isFile() || stat.size <= 0) continue
    const key = fileKey(stat)
    if (index.get(entry.name, key) !== null) {
      skipped++
      continue
    }
    try {
      const record = await store.stage({
        scopeId,
        kind: effectiveKind,
        fileName: entry.name,
        bytes: fs.createReadStream(file),
        sourceSessionId: sessionId,
        browserGeneration: generation,
      })
      // A writer may still be appending to a final-named file (MCP output is
      // not guaranteed to be renamed atomically). Never publish bytes that
      // changed while they were read.
      let afterStat
      try {
        afterStat = fs.statSync(file, { bigint: true })
      } catch {
        await store.discard({ scopeId, artifactId: record.artifactId }).catch(() => undefined)
        failed.push({ name: entry.name, error: 'file disappeared while reading' })
        continue
      }
      if (fileKey(afterStat) !== key) {
        await store.discard({ scopeId, artifactId: record.artifactId }).catch(() => undefined)
        failed.push({ name: entry.name, error: 'file changed while reading (still being written)' })
        continue
      }
      const metadata = await store.publish({ scopeId, artifactId: record.artifactId })
      index.set(entry.name, key, record.artifactId)
      published.push({ name: entry.name, artifactId: record.artifactId, kind: effectiveKind, size: metadata.size, sha256: metadata.sha256 })
    } catch (error) {
      failed.push({ name: entry.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (published.length > 0) index.save()
  return { published, skipped, failed, unsupported }
}

/**
 * Publish one already-observed file (a screenshot just captured by a native
 * tool) and return its committed metadata. Reuses the directory index so a
 * repeated call for the same file version does not create a second object.
 * @param {{ store: object, scopeId: string, sessionId: string, generation?: number | null, dir: string, filePath: string, kind: string, indexFile: string }} input
 * @returns {Promise<object>} published metadata record.
 */
export async function publishFileInDir({ store, scopeId, sessionId, generation = null, dir, filePath, kind, indexFile }) {
  const name = path.basename(filePath)
  const stat = fs.statSync(filePath, { bigint: true })
  if (!stat.isFile()) throw new Error('artifact source is not a regular file')
  if (stat.size <= 0) throw new Error('refusing to publish an empty file')
  const index = ArtifactIndex.load(indexFile)
  const key = fileKey(stat)
  const previous = index.get(name, key)
  if (previous !== null) {
    const record = await store.info({ scopeId, artifactId: previous })
    if (record !== null) return record
  }
  const staged = await store.stage({
    scopeId,
    kind,
    fileName: name,
    bytes: fs.createReadStream(filePath),
    sourceSessionId: sessionId,
    browserGeneration: generation,
  })
  const after = fs.statSync(filePath, { bigint: true })
  if (fileKey(after) !== key) {
    await store.discard({ scopeId, artifactId: staged.artifactId }).catch(() => undefined)
    throw new Error('file changed while reading (still being written)')
  }
  const metadata = await store.publish({ scopeId, artifactId: staged.artifactId })
  index.set(name, key, staged.artifactId)
  index.save()
  return metadata
}

/**
 * Scan the directories a session's browser writes into.
 *
 * `baseDir` is the session's host directory (`<DSH_HOME>/data/browser-live/<short>`):
 * screenshots land directly in it, downloads in its `downloads/` subdirectory,
 * and Playwright MCP output (screenshots/PDFs, plus `.yml`/`.log` side files)
 * in its `mcp/` subdirectory. Each keeps its own index so a scan of one never
 * counts files of the other.
 * @param {{ store: object, scopeId: string, sessionId: string, baseDir: string, generation?: number, mcpDir?: string | string[] | null }} input - session scan inputs.
 * @returns {Promise<{ published: object[], skipped: number, failed: object[], unsupported: object[], byDir: object }>} combined outcome.
 */
export async function collectSessionArtifacts({ store, scopeId, sessionId, baseDir, generation = null, mcpDir = null }) {
  const targets = [
    { dir: baseDir, kind: 'screenshot', kindFor: kindForFile, indexFile: path.join(baseDir, '.artifacts-screenshots.json'), label: 'screenshots' },
    { dir: path.join(baseDir, 'downloads'), kind: 'download', kindFor: null, indexFile: path.join(baseDir, '.artifacts-downloads.json'), label: 'downloads' },
  ]
  const mcpDirs = (Array.isArray(mcpDir) ? mcpDir : [mcpDir]).filter((value) => typeof value === 'string' && value.length > 0)
  for (const dir of mcpDirs) {
    targets.push({ dir, kind: 'screenshot', kindFor: kindForFile, indexFile: path.join(baseDir, '.artifacts-mcp.json'), label: 'mcp' })
  }
  const outcome = { published: [], skipped: 0, failed: [], unsupported: [], byDir: {} }
  for (const target of targets) {
    const index = ArtifactIndex.load(target.indexFile)
    const result = await collectDirectory({
      dir: target.dir,
      kind: target.kind,
      kindFor: target.kindFor,
      store,
      scopeId,
      sessionId,
      generation,
      index,
    })
    outcome.published.push(...result.published)
    outcome.skipped += result.skipped
    outcome.failed.push(...result.failed)
    outcome.unsupported.push(...result.unsupported.map((item) => ({ ...item, dir: target.label })))
    outcome.byDir[target.label] = { published: result.published.length, skipped: result.skipped, failed: result.failed.length, unsupported: result.unsupported.length }
  }
  return outcome
}
