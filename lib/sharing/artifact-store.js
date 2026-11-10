import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const ARTIFACT_FORMAT_VERSION = 1

const DEFAULT_MAX_STAGE_BYTES = 512 * 1024 * 1024
const DEFAULT_MAX_READ_BYTES = 64 * 1024 * 1024
const KINDS = new Set(['download', 'screenshot', 'pdf', 'other'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_RE = /^[0-9a-f]{64}$/
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g
const CONTROL_TEST_RE = /[\u0000-\u001f\u007f-\u009f]/
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

export class ArtifactError extends Error {
  constructor(code, message, options) {
    super(message, options)
    if (!['NOT_FOUND', 'OVERSIZE', 'CORRUPT', 'CONFLICT'].includes(code)) {
      throw new TypeError(`invalid ArtifactError code: ${code}`)
    }
    this.name = 'ArtifactError'
    this.code = code
  }
}

/** Return a safe, cross-platform basename without changing stored display metadata. */
export function safeExportName(fileName) {
  let name = String(fileName ?? '')
    .replace(CONTROL_RE, '')
    .replace(/[\\/]/g, '')
    .replace(/[<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/g, '')

  if (name === '' || name === '.' || name === '..') return 'artifact'
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`
  name = Array.from(name).slice(0, 120).join('').replace(/[. ]+$/g, '')
  return name || 'artifact'
}

/**
 * Immutable per-scope artifact storage. `maxStageBytes` is an optional test and
 * deployment override; its default is the documented 512 MiB staging limit.
 */
export class ArtifactStore {
  #rootPath
  #rootReal = null
  #now
  #maxStageBytes
  #locks = new Map()

  constructor({ root, now = () => Date.now(), maxStageBytes = DEFAULT_MAX_STAGE_BYTES }) {
    if (typeof root !== 'string' || root.length === 0) throw new TypeError('root must be a non-empty path')
    if (typeof now !== 'function') throw new TypeError('now must be a function')
    if (!Number.isSafeInteger(maxStageBytes) || maxStageBytes < 0) throw new TypeError('maxStageBytes must be a non-negative safe integer')
    this.#rootPath = path.resolve(root)
    this.#now = now
    this.#maxStageBytes = maxStageBytes
  }

  async stage({ scopeId, kind, fileName, bytes, sourceSessionId, browserGeneration = null, sourceUrl = null }) {
    validateScopeId(scopeId)
    if (!KINDS.has(kind)) throw new ArtifactError('CONFLICT', `unsupported artifact kind: ${String(kind)}`)
    if (typeof fileName !== 'string') throw new ArtifactError('CONFLICT', 'fileName must be a string')
    if (kind === 'download' && fileName.toLowerCase().endsWith('.crdownload')) {
      throw new ArtifactError('CONFLICT', 'unfinished .crdownload files cannot be staged')
    }
    if (typeof sourceSessionId !== 'string' || sourceSessionId.length === 0) {
      throw new ArtifactError('CONFLICT', 'sourceSessionId must be a non-empty string')
    }
    if (!Buffer.isBuffer(bytes) && (!bytes || typeof bytes[Symbol.asyncIterator] !== 'function')) {
      throw new ArtifactError('CONFLICT', 'bytes must be a Buffer or readable stream')
    }

    const dirs = await this.#ensureLayout()
    const artifactId = randomUUID()
    const stagedPath = path.join(dirs.staging, `${artifactId}.part`)
    const stagedMetadataPath = path.join(dirs.staging, `${artifactId}.json`)
    let handle
    let size = 0
    const hash = createHash('sha256')

    try {
      await this.#assertDirectory(dirs.staging)
      handle = await fs.open(stagedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
      await handle.chmod(0o600)
      const writeChunk = async (chunk) => {
        const buffer = toBuffer(chunk)
        if (size + buffer.length > this.#maxStageBytes) {
          throw new ArtifactError('OVERSIZE', `artifact exceeds the ${this.#maxStageBytes}-byte staging limit`)
        }
        let offset = 0
        while (offset < buffer.length) {
          const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset)
          if (bytesWritten <= 0) throw new Error('staging write made no progress')
          offset += bytesWritten
        }
        hash.update(buffer)
        size += buffer.length
      }

      if (Buffer.isBuffer(bytes)) {
        await writeChunk(bytes)
      } else {
        for await (const chunk of bytes) await writeChunk(chunk)
      }
      await handle.close()
      handle = null

      const record = {
        formatVersion: ARTIFACT_FORMAT_VERSION,
        artifactId,
        scopeId,
        kind,
        fileName,
        displayName: fileName.replace(CONTROL_RE, '\uFFFD'),
        size,
        sha256: hash.digest('hex'),
        createdAt: this.#timestamp(),
        sourceSessionId,
        browserGeneration,
        sourceUrl: redactUrl(sourceUrl),
        status: 'staged',
      }
      await this.#writeNewJson(stagedMetadataPath, record)
      return { artifactId, stagedPath }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      await fs.rm(stagedPath, { force: true }).catch(() => undefined)
      await fs.rm(stagedMetadataPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async publish({ scopeId, artifactId }) {
    validateScopeId(scopeId)
    validateArtifactId(artifactId)
    return this.#withLock(artifactId, async () => {
      const existing = await this.info({ scopeId, artifactId })
      if (existing) return existing

      const dirs = await this.#ensureLayout()
      const stagedPath = path.join(dirs.staging, `${artifactId}.part`)
      const stagedMetadataPath = path.join(dirs.staging, `${artifactId}.json`)
      const dataPath = path.join(dirs.objects, artifactId, 'data.bin')
      const stagedStat = await this.#lstatOrNull(stagedPath)
      const stagedMetadataStat = await this.#lstatOrNull(stagedMetadataPath)
      if (!stagedStat && !stagedMetadataStat) throw new ArtifactError('NOT_FOUND', `no staged artifact ${artifactId}`)
      if (!stagedStat || !stagedMetadataStat) throw new ArtifactError('CORRUPT', `staged artifact ${artifactId} is incomplete`)
      if (!stagedStat.isFile() || stagedStat.isSymbolicLink() || !stagedMetadataStat.isFile() || stagedMetadataStat.isSymbolicLink()) {
        throw new ArtifactError('CONFLICT', `staged artifact ${artifactId} is not stored as regular files`)
      }

      const staged = await this.#readJson(stagedMetadataPath, dirs.root, 'CORRUPT')
      if (!isRecord(staged) || staged.status !== 'staged' || staged.artifactId !== artifactId || staged.scopeId !== scopeId) {
        throw new ArtifactError('CORRUPT', `staged metadata for ${artifactId} is invalid`)
      }
      await this.#assertDirectory(dirs.staging)
      const stagedHandle = await this.#openRegularFile(stagedPath, dirs.root, 'NOT_FOUND', constants.O_RDWR | NOFOLLOW)
      try {
        const actual = await hashHandle(stagedHandle)
        if (actual.size !== staged.size || actual.sha256 !== staged.sha256) {
          throw new ArtifactError('CORRUPT', `staged artifact ${artifactId} failed its size or SHA-256 check`)
        }
        await stagedHandle.sync()
        const current = await stagedHandle.stat()
        const byPath = await fs.lstat(stagedPath)
        if (!sameFile(current, byPath)) throw new ArtifactError('CONFLICT', `staged artifact ${artifactId} changed during publish`)
      } finally {
        await stagedHandle.close()
      }

      const objectDir = path.join(dirs.objects, artifactId)
      try {
        await fs.mkdir(objectDir, { mode: 0o700 })
      } catch (error) {
        if (error.code === 'EEXIST') {
          await this.#assertDirectory(objectDir)
          throw new ArtifactError('CONFLICT', `object ${artifactId} already exists without committed metadata`)
        }
        throw error
      }
      await this.#assertDirectory(objectDir)
      await fs.chmod(objectDir, 0o700)
      await syncDirectory(dirs.objects)
      if (await this.#lstatOrNull(dataPath)) throw new ArtifactError('CONFLICT', `object data already exists for ${artifactId}`)

      try {
        await fs.rename(stagedPath, dataPath)
      } catch (error) {
        if (error.code === 'ENOENT') throw new ArtifactError('NOT_FOUND', `staged artifact ${artifactId} disappeared during publish`, { cause: error })
        throw error
      }
      const objectFile = await this.#openRegularFile(dataPath, dirs.root, 'CORRUPT', constants.O_RDWR | NOFOLLOW)
      try {
        await objectFile.chmod(0o600)
        await objectFile.sync()
      } finally {
        await objectFile.close()
      }
      await syncDirectory(objectDir)
      await syncDirectory(dirs.objects)

      const record = {
        ...staged,
        status: 'published',
        publishedAt: this.#timestamp(),
      }
      delete record.stagedAt
      const metadataPath = path.join(dirs.metadata, `${artifactId}.json`)
      await this.#commitMetadata(metadataPath, record, dirs.metadata)
      await this.#unlinkRegularIfPresent(stagedMetadataPath, dirs.root)
      await syncDirectory(dirs.staging).catch(() => undefined)
      await this.#refreshIndex(dirs).catch(() => undefined)
      return record
    })
  }

  async discard({ scopeId, artifactId }) {
    validateScopeId(scopeId)
    validateArtifactId(artifactId)
    return this.#withLock(artifactId, async () => {
      const dirs = await this.#ensureLayout()
      await this.#unlinkRegularIfPresent(path.join(dirs.staging, `${artifactId}.part`), dirs.root)
      await this.#unlinkRegularIfPresent(path.join(dirs.staging, `${artifactId}.json`), dirs.root)
      await syncDirectory(dirs.staging).catch(() => undefined)
    })
  }

  async list({ scopeId, kind = null, limit = 50, cursor = null }) {
    validateScopeId(scopeId)
    if (kind !== null && !KINDS.has(kind)) throw new ArtifactError('CONFLICT', `unsupported artifact kind: ${String(kind)}`)
    if (!Number.isSafeInteger(limit) || limit < 1) throw new ArtifactError('CONFLICT', 'limit must be a positive safe integer')
    const cursorKey = cursor === null ? null : decodeCursor(cursor)
    const dirs = await this.#ensureLayout()
    let records = await this.#recordsForList(dirs)
    records = records
      .filter((record) => record.scopeId === scopeId && record.status === 'published' && (kind === null || record.kind === kind))
      .sort(compareNewestFirst)
    if (cursorKey) {
      records = records.filter((record) => isOlder(record, cursorKey))
    }
    const page = records.slice(0, limit)
    const hasMore = records.length > page.length
    return {
      items: page,
      nextCursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]) : null,
    }
  }

  async info({ scopeId, artifactId }) {
    validateScopeId(scopeId)
    validateArtifactId(artifactId)
    const dirs = await this.#ensureLayout()
    const metadataPath = path.join(dirs.metadata, `${artifactId}.json`)
    const stat = await this.#lstatOrNull(metadataPath)
    if (!stat) return null
    if (stat.isSymbolicLink() || !stat.isFile()) throw new ArtifactError('CONFLICT', `metadata for ${artifactId} is not a regular file`)
    const record = await this.#readJson(metadataPath, dirs.root, 'CORRUPT')
    if (!isRecord(record) || record.artifactId !== artifactId || record.status !== 'published') {
      throw new ArtifactError('CORRUPT', `metadata for ${artifactId} is invalid`)
    }
    if (record.scopeId !== scopeId) return null
    return record
  }

  async read({ scopeId, artifactId, maxBytes = DEFAULT_MAX_READ_BYTES }) {
    validateReadLimit(maxBytes)
    const record = await this.info({ scopeId, artifactId })
    if (!record) throw new ArtifactError('NOT_FOUND', `published artifact ${artifactId} was not found`)
    const dirs = await this.#ensureLayout()
    const filePath = path.join(dirs.objects, artifactId, 'data.bin')
    await this.#assertDirectory(path.dirname(filePath))
    const handle = await this.#openRegularFile(filePath, dirs.root, 'NOT_FOUND')
    try {
      const stat = await handle.stat()
      if (stat.size > maxBytes) throw new ArtifactError('OVERSIZE', `artifact is ${stat.size} bytes; read limit is ${maxBytes}`)
      return await readBounded(handle, maxBytes)
    } finally {
      await handle.close()
    }
  }

  async stats({ scopeId }) {
    validateScopeId(scopeId)
    const dirs = await this.#ensureLayout()
    const byKind = Object.fromEntries([...KINDS].map((kind) => [kind, 0]))
    const published = await this.#scanMetadata(dirs, { strict: true })
    for (const record of published) {
      if (record.scopeId === scopeId && record.status === 'published') byKind[record.kind] += 1
    }

    let objects = 0
    let bytes = 0
    const objectEntries = await fs.readdir(dirs.objects, { withFileTypes: true })
    for (const entry of objectEntries) {
      if (entry.name === '.staging') continue
      if (!UUID_RE.test(entry.name)) continue
      const objectDir = path.join(dirs.objects, entry.name)
      await this.#assertDirectory(objectDir)
      const dataPath = path.join(objectDir, 'data.bin')
      const stat = await this.#lstatOrNull(dataPath)
      if (!stat) continue
      if (stat.isSymbolicLink() || !stat.isFile()) throw new ArtifactError('CONFLICT', `object data ${entry.name} is not a regular file`)
      await this.#assertContained(dataPath, dirs.root)
      objects += 1
      bytes += stat.size
    }

    const stagingIds = new Set()
    const stagingEntries = await fs.readdir(dirs.staging, { withFileTypes: true })
    for (const entry of stagingEntries) {
      if (entry.isSymbolicLink()) throw new ArtifactError('CONFLICT', `staging entry ${entry.name} is a symbolic link`)
      const match = /^([0-9a-f-]{36})\.(?:part|json|json\.tmp)$/i.exec(entry.name)
      if (!match) continue
      const stagePath = path.join(dirs.staging, entry.name)
      const stat = await this.#lstatOrNull(stagePath)
      if (!stat) continue
      if (!stat.isFile()) throw new ArtifactError('CONFLICT', `staging entry ${entry.name} is not a regular file`)
      await this.#assertContained(stagePath, dirs.root)
      stagingIds.add(match[1])
      if (entry.name.endsWith('.part')) bytes += stat.size
    }
    return { objects, staging: stagingIds.size, bytes, byKind }
  }

  async verify({ scopeId, artifactId }) {
    const record = await this.info({ scopeId, artifactId })
    if (!record) throw new ArtifactError('NOT_FOUND', `published artifact ${artifactId} was not found`)
    const dirs = await this.#ensureLayout()
    const filePath = path.join(dirs.objects, artifactId, 'data.bin')
    await this.#assertDirectory(path.dirname(filePath))
    const handle = await this.#openRegularFile(filePath, dirs.root, 'NOT_FOUND')
    try {
      const actual = await hashHandle(handle)
      return { ok: actual.sha256 === record.sha256 && actual.size === record.size, expected: record.sha256, actual: actual.sha256 }
    } finally {
      await handle.close()
    }
  }

  #timestamp() {
    return new Date(this.#now()).toISOString()
  }

  async #ensureLayout() {
    await fs.mkdir(this.#rootPath, { recursive: true, mode: 0o700 })
    const rootStat = await fs.lstat(this.#rootPath)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new ArtifactError('CONFLICT', 'artifact root must be a real directory')
    const root = await fs.realpath(this.#rootPath)
    if (this.#rootReal !== null && root !== this.#rootReal) throw new ArtifactError('CONFLICT', 'artifact root changed after initialization')
    this.#rootReal = root
    await fs.chmod(root, 0o700)
    const objects = await this.#ensureDirectory(path.join(root, 'objects'), root)
    const staging = await this.#ensureDirectory(path.join(objects, '.staging'), root)
    const metadata = await this.#ensureDirectory(path.join(root, 'metadata'), root)
    return { root, objects, staging, metadata, index: path.join(root, 'index.json') }
  }

  async #ensureDirectory(dirPath, root) {
    try {
      await fs.mkdir(dirPath, { mode: 0o700 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const stat = await fs.lstat(dirPath)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ArtifactError('CONFLICT', `directory path is not a real directory: ${dirPath}`)
    await this.#assertContained(dirPath, root)
    await fs.chmod(dirPath, 0o700)
    return dirPath
  }

  async #assertDirectory(dirPath) {
    const stat = await fs.lstat(dirPath)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ArtifactError('CONFLICT', `expected a non-symlink directory: ${dirPath}`)
    await this.#assertContained(dirPath, this.#rootReal)
  }

  async #assertContained(targetPath, root = this.#rootReal) {
    if (!root) throw new ArtifactError('CONFLICT', 'artifact root is not initialized')
    let real
    try {
      real = await fs.realpath(targetPath)
    } catch (error) {
      if (error.code === 'ENOENT') throw error
      throw new ArtifactError('CONFLICT', `cannot resolve artifact path: ${targetPath}`, { cause: error })
    }
    const relative = path.relative(root, real)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new ArtifactError('CONFLICT', `artifact path escapes its canonical root: ${targetPath}`)
    }
    return real
  }

  async #lstatOrNull(filePath) {
    try {
      return await fs.lstat(filePath)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  async #openRegularFile(filePath, root, missingCode, flags = constants.O_RDONLY | NOFOLLOW) {
    const before = await this.#lstatOrNull(filePath)
    if (!before) throw new ArtifactError(missingCode, `artifact file is missing: ${filePath}`)
    if (before.isSymbolicLink() || !before.isFile()) throw new ArtifactError('CONFLICT', `artifact path is not a regular file: ${filePath}`)
    await this.#assertContained(filePath, root)
    let handle
    try {
      handle = await fs.open(filePath, flags)
      const after = await handle.stat()
      const pathStat = await fs.lstat(filePath)
      if (!after.isFile() || !sameFile(after, before) || !sameFile(after, pathStat)) {
        throw new ArtifactError('CONFLICT', `artifact file changed while opening: ${filePath}`)
      }
      await this.#assertContained(filePath, root)
      return handle
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      if (error.code === 'ELOOP') throw new ArtifactError('CONFLICT', `refusing symbolic link: ${filePath}`, { cause: error })
      throw error
    }
  }

  async #readJson(filePath, root, errorCode) {
    const handle = await this.#openRegularFile(filePath, root, errorCode)
    try {
      const text = await handle.readFile({ encoding: 'utf8' })
      try {
        return JSON.parse(text)
      } catch (error) {
        throw new ArtifactError(errorCode, `invalid JSON at ${filePath}`, { cause: error })
      }
    } finally {
      await handle.close()
    }
  }

  async #writeNewJson(filePath, value) {
    const handle = await fs.open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
    try {
      await handle.chmod(0o600)
      await handle.writeFile(jsonLine(value), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async #commitMetadata(metadataPath, record, metadataDir) {
    const tempPath = path.join(metadataDir, `.${record.artifactId}.${randomUUID()}.tmp`)
    const handle = await fs.open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
    try {
      await handle.chmod(0o600)
      await handle.writeFile(jsonLine(record), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await this.#assertDirectory(metadataDir)
      const existing = await this.#lstatOrNull(metadataPath)
      if (existing) {
        if (existing.isSymbolicLink() || !existing.isFile()) throw new ArtifactError('CONFLICT', `metadata path is not a regular file: ${metadataPath}`)
        throw new ArtifactError('CONFLICT', `metadata already exists for ${record.artifactId}`)
      }
      await this.#assertContained(tempPath)
      await fs.link(tempPath, metadataPath)
      await fs.unlink(tempPath)
      await syncDirectory(metadataDir)
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
      if (error.code === 'EEXIST') throw new ArtifactError('CONFLICT', `metadata already exists for ${record.artifactId}`, { cause: error })
      throw error
    }
  }

  async #unlinkRegularIfPresent(filePath, root) {
    const stat = await this.#lstatOrNull(filePath)
    if (!stat) return
    if (stat.isSymbolicLink() || !stat.isFile()) throw new ArtifactError('CONFLICT', `refusing to remove non-regular staging path: ${filePath}`)
    await this.#assertContained(filePath, root)
    await fs.unlink(filePath)
  }

  async #scanMetadata(dirs, { strict = true } = {}) {
    const names = await fs.readdir(dirs.metadata)
    const records = []
    for (const name of names) {
      const match = /^([0-9a-f-]{36})\.json$/i.exec(name)
      if (!match || !UUID_RE.test(match[1])) continue
      const metadataPath = path.join(dirs.metadata, name)
      const stat = await this.#lstatOrNull(metadataPath)
      if (!stat) continue
      if (stat.isSymbolicLink() || !stat.isFile()) {
        if (strict) throw new ArtifactError('CONFLICT', `metadata path is not a regular file: ${metadataPath}`)
        continue
      }
      let record
      try {
        record = await this.#readJson(metadataPath, dirs.root, 'CORRUPT')
        if (!isRecord(record) || record.artifactId !== match[1] || record.status !== 'published') {
          throw new ArtifactError('CORRUPT', `metadata record ${name} is invalid`)
        }
      } catch (error) {
        if (strict) throw error
        continue
      }
      records.push(record)
    }
    return records
  }

  async #recordsForList(dirs) {
    const metadataStat = await fs.stat(dirs.metadata, { bigint: true })
    const indexed = await this.#readIndex(dirs.index, metadataStat.mtimeNs.toString(), dirs.root)
    if (indexed) return indexed
    const records = await this.#scanMetadata(dirs, { strict: true })
    const after = await fs.stat(dirs.metadata, { bigint: true })
    const mtime = after.mtimeNs.toString()
    await this.#writeIndex(dirs, records, mtime).catch(() => undefined)
    return records
  }

  async #readIndex(indexPath, metadataMtimeNs, root) {
    const stat = await this.#lstatOrNull(indexPath)
    if (!stat) return null
    if (stat.isSymbolicLink() || !stat.isFile()) throw new ArtifactError('CONFLICT', 'artifact index is not a regular file')
    let value
    try {
      value = await this.#readJson(indexPath, root, 'CORRUPT')
    } catch (error) {
      if (error instanceof ArtifactError && error.code === 'CORRUPT') return null
      throw error
    }
    if (value?.formatVersion !== ARTIFACT_FORMAT_VERSION || value.metadataMtimeNs !== metadataMtimeNs || !Array.isArray(value.items)) return null
    if (!value.items.every((record) => isRecord(record) && record.status === 'published')) return null
    return value.items
  }

  async #writeIndex(dirs, records, metadataMtimeNs) {
    const tempPath = path.join(dirs.root, `.index.${randomUUID()}.tmp`)
    const handle = await fs.open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
    try {
      await handle.chmod(0o600)
      await handle.writeFile(jsonLine({ formatVersion: ARTIFACT_FORMAT_VERSION, metadataMtimeNs, items: records }), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      const existing = await this.#lstatOrNull(dirs.index)
      if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new ArtifactError('CONFLICT', 'artifact index is not a regular file')
      await fs.rename(tempPath, dirs.index)
      await syncDirectory(dirs.root)
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async #refreshIndex(dirs) {
    const records = await this.#scanMetadata(dirs, { strict: true })
    const metadataStat = await fs.stat(dirs.metadata, { bigint: true })
    await this.#writeIndex(dirs, records, metadataStat.mtimeNs.toString())
  }

  async #withLock(key, fn) {
    const previous = this.#locks.get(key) ?? Promise.resolve()
    let release
    const current = new Promise((resolve) => { release = resolve })
    this.#locks.set(key, current)
    await previous.catch(() => undefined)
    try {
      return await fn()
    } finally {
      release()
      if (this.#locks.get(key) === current) this.#locks.delete(key)
    }
  }
}

function validateScopeId(scopeId) {
  if (typeof scopeId !== 'string' || scopeId.length === 0) throw new ArtifactError('CONFLICT', 'scopeId must be a non-empty string')
}

function validateArtifactId(artifactId) {
  if (typeof artifactId !== 'string' || !UUID_RE.test(artifactId)) {
    throw new ArtifactError('CONFLICT', 'artifactId must be a UUID generated by the artifact store')
  }
}

function validateReadLimit(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new ArtifactError('CONFLICT', 'maxBytes must be a non-negative safe integer')
}

function jsonLine(value) {
  const json = JSON.stringify(value).replace(/[\u007f-\u009f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return `${json}\n`
}

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk
  if (typeof chunk === 'string') return Buffer.from(chunk)
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  throw new ArtifactError('CONFLICT', 'readable stream must yield byte chunks')
}

function redactUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const origin = new URL(value).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.formatVersion === ARTIFACT_FORMAT_VERSION
    && typeof value.artifactId === 'string' && UUID_RE.test(value.artifactId)
    && typeof value.scopeId === 'string'
    && KINDS.has(value.kind)
    && typeof value.fileName === 'string'
    && typeof value.displayName === 'string' && !CONTROL_TEST_RE.test(value.displayName)
    && Number.isSafeInteger(value.size) && value.size >= 0
    && typeof value.sha256 === 'string' && SHA256_RE.test(value.sha256)
    && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.sourceSessionId === 'string'
    && (value.sourceUrl === null || typeof value.sourceUrl === 'string')
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

async function syncDirectory(dirPath) {
  const handle = await fs.open(dirPath, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function hashHandle(handle) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let position = 0
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
    if (bytesRead === 0) break
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return { size: position, sha256: hash.digest('hex') }
}

async function readBounded(handle, maxBytes) {
  const chunks = []
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let total = 0
  let position = 0
  while (true) {
    const remaining = maxBytes - total
    const length = Math.min(buffer.length, Math.max(remaining + 1, 1))
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    if (bytesRead === 0) break
    total += bytesRead
    if (total > maxBytes) throw new ArtifactError('OVERSIZE', `artifact exceeds the ${maxBytes}-byte read limit`)
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    position += bytesRead
  }
  return Buffer.concat(chunks, total)
}

function compareNewestFirst(left, right) {
  if (left.createdAt !== right.createdAt) return left.createdAt > right.createdAt ? -1 : 1
  if (left.artifactId === right.artifactId) return 0
  return left.artifactId > right.artifactId ? -1 : 1
}

function encodeCursor(record) {
  return Buffer.from(JSON.stringify({ createdAt: record.createdAt, artifactId: record.artifactId })).toString('base64url')
}

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new ArtifactError('CONFLICT', 'cursor is invalid')
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!isRecordCursor(parsed)) throw new Error('invalid cursor fields')
    return parsed
  } catch (error) {
    if (error instanceof ArtifactError) throw error
    throw new ArtifactError('CONFLICT', 'cursor is invalid', { cause: error })
  }
}

function isRecordCursor(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.artifactId === 'string' && UUID_RE.test(value.artifactId)
}

function isOlder(record, cursor) {
  return record.createdAt < cursor.createdAt
    || (record.createdAt === cursor.createdAt && record.artifactId < cursor.artifactId)
}
