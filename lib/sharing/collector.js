/**
 * dsh-browser-live — artifact collector.
 *
 * Turns the two places a session's browser leaves files — its bind-mounted
 * download folder and its screenshot folder — into immutable shared objects.
 *
 * Completion rules come from the P0 probes (docs/p0-capability-matrix.md C11):
 * Chromium writes `Unconfirmed <id>.crdownload` while the transfer runs and only
 * renames to the real name when it finishes, so a scan must accept exactly the
 * final rename and nothing else. A per-directory index remembers what was
 * already published, which keeps repeated scans idempotent without rehashing
 * every byte.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Temp names Chromium/Playwright use before a download is complete. */
export function isCompletedFileName(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (name.startsWith('.')) return false
  if (name.endsWith('.crdownload') || name.endsWith('.tmp')) return false
  if (/^Unconfirmed /i.test(name)) return false
  return true
}

/** Stable identity for one file version: size and mtime are enough for v1. */
export function fileKey(stat) {
  return `${stat.size}:${Math.floor(stat.mtimeMs)}`
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
 * @param {{ dir: string, kind: string, store: object, scopeId: string, sessionId: string, generation?: number, index: ArtifactIndex }} input - scan inputs.
 * @returns {Promise<{ published: object[], skipped: number, failed: object[] }>} scan outcome.
 */
export async function collectDirectory({ dir, kind, store, scopeId, sessionId, generation = null, index }) {
  const published = []
  const failed = []
  let skipped = 0
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return { published, skipped, failed }
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!isCompletedFileName(entry.name)) continue
    const file = path.join(dir, entry.name)
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.size === 0) continue
    const key = fileKey(stat)
    if (index.get(entry.name, key) !== null) {
      skipped++
      continue
    }
    try {
      const record = await store.stage({
        scopeId,
        kind,
        fileName: entry.name,
        bytes: fs.createReadStream(file),
        sourceSessionId: sessionId,
        browserGeneration: generation,
      })
      const metadata = await store.publish({ scopeId, artifactId: record.artifactId })
      index.set(entry.name, key, record.artifactId)
      published.push({ name: entry.name, artifactId: record.artifactId, size: metadata.size, sha256: metadata.sha256 })
    } catch (error) {
      failed.push({ name: entry.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (published.length > 0) index.save()
  return { published, skipped, failed }
}

/**
 * Scan the two directories a session's browser writes into.
 *
 * `baseDir` is the session's host directory (`<DSH_HOME>/data/browser-live/<short>`):
 * screenshots land directly in it, downloads in its `downloads/` subdirectory.
 * Each keeps its own index so a scan of one never counts files of the other.
 * @param {{ store: object, scopeId: string, sessionId: string, baseDir: string, generation?: number }} input - session scan inputs.
 * @returns {Promise<{ published: object[], skipped: number, failed: object[] }>} combined outcome.
 */
export async function collectSessionArtifacts({ store, scopeId, sessionId, baseDir, generation = null }) {
  const targets = [
    { dir: baseDir, kind: 'screenshot', indexFile: path.join(baseDir, '.artifacts-screenshots.json') },
    { dir: path.join(baseDir, 'downloads'), kind: 'download', indexFile: path.join(baseDir, '.artifacts-downloads.json') },
  ]
  const outcome = { published: [], skipped: 0, failed: [] }
  for (const target of targets) {
    const index = ArtifactIndex.load(target.indexFile)
    const result = await collectDirectory({
      dir: target.dir,
      kind: target.kind,
      store,
      scopeId,
      sessionId,
      generation,
      index,
    })
    outcome.published.push(...result.published)
    outcome.skipped += result.skipped
    outcome.failed.push(...result.failed)
  }
  return outcome
}
