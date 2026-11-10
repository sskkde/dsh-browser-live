/**
 * dsh-browser-live — redacted audit log.
 *
 * Every sharing decision that matters (publish, restore, revoke, artifact
 * export, denial) is appended as one JSON line per event. The log is an
 * operator artefact, not a debugging dump: it records *what happened to which
 * logical key*, never the credential material and never a full URL.
 *
 * Records are append-only JSONL with mode 0600; a failed append is reported to
 * the caller, because silently losing an audit trail is worse than failing the
 * operation that produced it.
 */

import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

export const AUDIT_FORMAT_VERSION = 1

const SECRET_KEY_RE = /(cookie|token|password|secret|credential|authorization|value)/i
const URL_RE = /^https?:\/\//i

/**
 * Keep only the shape of a detail object, never its secrets.
 * @param {unknown} detail - caller-provided detail.
 * @param {number} [depth] - recursion guard.
 * @returns {unknown} redacted detail.
 */
export function redactDetail(detail, depth = 0) {
  if (depth > 4) return '[depth]'
  if (Array.isArray(detail)) return detail.map((item) => redactDetail(item, depth + 1))
  if (detail === null || typeof detail !== 'object') {
    if (typeof detail === 'string' && URL_RE.test(detail)) {
      try {
        return new URL(detail).origin
      } catch {
        return '[url]'
      }
    }
    return typeof detail === 'string' && detail.length > 200 ? detail.slice(0, 200) + '…' : detail
  }
  const out = {}
  for (const [key, value] of Object.entries(detail)) {
    out[key] = SECRET_KEY_RE.test(key) ? '[redacted]' : redactDetail(value, depth + 1)
  }
  return out
}

/** Audit log for one scope (or one deployment). */
export class AuditLog {
  #rootPath
  #now

  /**
   * @param {{ root: string, now?: () => number }} options - directory for the log files.
   */
  constructor({ root, now = () => Date.now() }) {
    if (typeof root !== 'string' || root.length === 0) throw new TypeError('audit root must be a non-empty path')
    this.#rootPath = path.resolve(root)
    this.#now = now
  }

  /**
   * Append one event.
   * @param {{ scopeId: string, action: string, actorSessionId?: string | null, subject?: object, outcome?: string, detail?: object }} event - event fields.
   * @returns {Promise<{at: number, file: string}>} audit handle.
   */
  async record(event) {
    if (event === null || typeof event !== 'object') throw new TypeError('audit event must be an object')
    if (typeof event.action !== 'string' || event.action.length === 0) throw new TypeError('audit event requires an action')
    if (typeof event.scopeId !== 'string' || event.scopeId.length === 0) throw new TypeError('audit event requires a scope id')
    const at = this.#now()
    const line = JSON.stringify({
      formatVersion: AUDIT_FORMAT_VERSION,
      at,
      action: event.action,
      scopeId: event.scopeId,
      actorSessionId: typeof event.actorSessionId === 'string' ? event.actorSessionId : null,
      subject: redactDetail(event.subject ?? {}),
      outcome: typeof event.outcome === 'string' ? event.outcome : 'ok',
      detail: redactDetail(event.detail ?? {}),
    }) + '\n'
    await fs.mkdir(this.#rootPath, { recursive: true, mode: 0o700 })
    const file = path.join(this.#rootPath, `${new Date(at).toISOString().slice(0, 10)}.jsonl`)
    const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600)
    try {
      await handle.writeFile(line, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    return { at, file }
  }

  /**
   * Read back the recorded lines (operator tooling and tests).
   * @param {{ limit?: number }} [options] - most recent lines.
   * @returns {Promise<object[]>} parsed events, oldest first.
   */
  async tail({ limit = 100 } = {}) {
    let names
    try {
      names = (await fs.readdir(this.#rootPath)).filter((name) => name.endsWith('.jsonl')).sort()
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const events = []
    for (const name of names) {
      const text = await fs.readFile(path.join(this.#rootPath, name), 'utf8')
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          events.push(JSON.parse(line))
        } catch {
          // a truncated final line from a crash is not an event
        }
      }
    }
    return events.slice(-Math.max(1, limit))
  }
}
