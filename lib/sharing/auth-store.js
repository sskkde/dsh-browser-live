import { constants as fsConstants } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Immutable authentication snapshots, stored beneath the caller-provided scope root:
 *
 *   index.json
 *   revisions/<opaque-scope-site>/<opaque-account>/<counter-random>.json
 *   epochs/<opaque-scope-site>/<opaque-account>.json
 *
 * The scope is folded into the opaque site directory so a root reused by more
 * than one scope cannot collide. The index contains metadata only; revision
 * payloads contain the full Playwright cookies/origins state. Writers are
 * serialized per logical key in this process, with a second short lock around
 * index read/modify/write so different keys cannot lose each other's entries.
 * This is a single-writer-process store; it does not provide cross-process CAS.
 */
export const AUTH_FORMAT_VERSION = 1

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0

export class RevisionConflictError extends Error {
  constructor(expected, current) {
    super('auth revision conflict')
    this.name = 'RevisionConflictError'
    this.current = current
    this.expected = expected
  }
}

export class AuthStore {
  constructor({ root, now = () => Date.now() }) {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('auth store root must be absolute')
    if (typeof now !== 'function') throw new Error('auth store clock must be a function')
    try {
      this.configuredRoot = resolve(root)
    } catch {
      throw new Error('auth store root is invalid')
    }
    this.now = now
    this.rootPromise = null
    this.keyLocks = new Map()
    this.indexLocks = new Map()
  }

  async publish({
    scopeId,
    siteKey,
    accountKey,
    sourceSessionId,
    state,
    expectedRevision = null,
    expectedEpoch = null,
    baseRevision = null,
    capabilities = [],
  }) {
    const key = makeKey(scopeId, siteKey, accountKey)
    if (expectedRevision !== null && typeof expectedRevision !== 'string') throw new Error('expected revision is invalid')
    if (expectedEpoch !== null && (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0)) {
      throw new Error('expected epoch is invalid')
    }
    if (baseRevision !== null && typeof baseRevision !== 'string') throw new Error('base revision is invalid')
    if (typeof sourceSessionId !== 'string' || sourceSessionId.length === 0) throw new Error('source session id is invalid')
    if (!Array.isArray(capabilities) || capabilities.some((value) => typeof value !== 'string')) {
      throw new Error('capabilities are invalid')
    }
    const safeState = copyAndValidateState(state)

    return runExclusive(this.keyLocks, key.id, async () => {
      const root = await this.ensureRoot()
      await ensureDirectory(root, ['revisions', key.encodedSite, key.encodedAccount])
      await ensureDirectory(root, ['epochs', key.encodedSite])

      const index = await readIndex(root)
      const previous = index.entries[key.id] ?? null
      const currentHead = previous?.headRevision ?? null
      const currentSummary = summaryFor(previous)
      if (expectedRevision !== currentHead) throw new RevisionConflictError(expectedRevision, currentSummary)

      const epochRecord = await readEpoch(root, key)
      const epoch = Math.max(previous?.epoch ?? 0, epochRecord?.epoch ?? 0)
      if (isRevokedEntry(previous, epoch) && (expectedEpoch === null || expectedEpoch < epoch)) {
        throw new Error('auth account has been revoked; current epoch acknowledgement is required')
      }
      if (expectedEpoch !== null && expectedEpoch !== epoch) throw new Error('auth epoch conflict')

      const revisionCounter = Math.max(previous?.revisionCounter ?? 0, epochRecord?.revisionCounter ?? 0) + 1
      if (!Number.isSafeInteger(revisionCounter)) throw new Error('auth revision counter exhausted')
      const revision = makeRevision(revisionCounter)
      let capturedAt
      try {
        capturedAt = this.now()
      } catch {
        throw new Error('auth capture clock failed')
      }
      if (!Number.isFinite(capturedAt)) throw new Error('auth capture time is invalid')

      const revisionData = {
        formatVersion: AUTH_FORMAT_VERSION,
        scopeId: key.scopeId,
        siteKey: key.siteKey,
        accountKey: key.accountKey,
        revision,
        epoch,
        capturedAt,
        sourceSessionId,
        baseRevision,
        capabilities: [...capabilities],
        state: safeState,
      }
      const serialized = serialize(revisionData)
      const bytes = Buffer.byteLength(serialized)
      const revisionSummary = {
        siteKey: key.siteKey,
        accountKey: key.accountKey,
        revision,
        epoch,
        capturedAt,
        sourceSessionId,
        bytes,
      }
      const revisionDir = join(root, 'revisions', key.encodedSite, key.encodedAccount)
      await atomicWrite(root, revisionDir, `${revision}.json`, serialized, { replace: false })

      const nextEntry = {
        scopeId: key.scopeId,
        siteKey: key.siteKey,
        accountKey: key.accountKey,
        headRevision: revision,
        headEpoch: epoch,
        epoch,
        capturedAt,
        sourceSessionId,
        bytes,
        revisionCounter,
        baseRevision,
        capabilities: [...capabilities],
      }
      await runExclusive(this.indexLocks, 'index', async () => {
        const latest = await readIndex(root)
        latest.entries[key.id] = nextEntry
        await writeIndex(root, latest)
      })
      return revisionSummary
    })
  }

  async current({ scopeId, siteKey, accountKey }) {
    const key = makeKey(scopeId, siteKey, accountKey)
    const root = await this.ensureRoot()
    const index = await readIndex(root)
    const entry = index.entries[key.id]
    if (entry === undefined || entry.headRevision === null) return null

    const epochRecord = await readEpoch(root, key)
    const epoch = Math.max(entry.epoch, epochRecord?.epoch ?? 0)
    if (entry.headEpoch < epoch) return null

    const filePath = containedPath(root, 'revisions', key.encodedSite, key.encodedAccount, `${entry.headRevision}.json`)
    const revisionData = await readJson(root, filePath, { optional: false, invalidMessage: 'auth revision is invalid' })
    if (!isRecord(revisionData)
      || revisionData.formatVersion !== AUTH_FORMAT_VERSION
      || revisionData.scopeId !== key.scopeId
      || revisionData.siteKey !== key.siteKey
      || revisionData.accountKey !== key.accountKey
      || revisionData.revision !== entry.headRevision
      || revisionData.epoch !== entry.headEpoch) {
      throw new Error('auth revision is invalid')
    }
    const state = copyAndValidateState(revisionData.state)
    return {
      revision: entry.headRevision,
      epoch: entry.headEpoch,
      capturedAt: entry.capturedAt,
      state,
    }
  }

  async list({ scopeId }) {
    validateKeyPart(scopeId, 'scope id')
    const root = await this.ensureRoot()
    const index = await readIndex(root)
    const results = []
    for (const [id, entry] of Object.entries(index.entries)) {
      if (entry.scopeId !== scopeId) continue
      const key = makeKey(entry.scopeId, entry.siteKey, entry.accountKey)
      if (key.id !== id) throw new Error('auth index is invalid')
      const epochRecord = await readEpoch(root, key)
      const epoch = Math.max(entry.epoch, epochRecord?.epoch ?? 0)
      const revoked = isRevokedEntry(entry, epoch)
      results.push({
        siteKey: entry.siteKey,
        accountKey: entry.accountKey,
        revision: entry.headRevision,
        epoch,
        capturedAt: entry.capturedAt,
        revoked,
      })
    }
    return results
  }

  async revoke({ scopeId, siteKey, accountKey, expectedRevision = null }) {
    const key = makeKey(scopeId, siteKey, accountKey)
    if (expectedRevision !== null && typeof expectedRevision !== 'string') throw new Error('expected revision is invalid')

    return runExclusive(this.keyLocks, key.id, async () => {
      const root = await this.ensureRoot()
      await ensureDirectory(root, ['epochs', key.encodedSite])
      const index = await readIndex(root)
      const previous = index.entries[key.id] ?? null
      const currentHead = previous?.headRevision ?? null
      if (expectedRevision !== currentHead) {
        throw new RevisionConflictError(expectedRevision, summaryFor(previous))
      }
      const oldEpochRecord = await readEpoch(root, key)
      const epoch = Math.max(previous?.epoch ?? 0, oldEpochRecord?.epoch ?? 0) + 1
      if (!Number.isSafeInteger(epoch)) throw new Error('auth epoch counter exhausted')
      const revisionCounter = Math.max(previous?.revisionCounter ?? 0, oldEpochRecord?.revisionCounter ?? 0) + 1
      if (!Number.isSafeInteger(revisionCounter)) throw new Error('auth revision counter exhausted')
      const revision = makeRevision(revisionCounter)
      let revokedAt
      try {
        revokedAt = this.now()
      } catch {
        throw new Error('auth revoke clock failed')
      }
      if (!Number.isFinite(revokedAt)) throw new Error('auth revoke time is invalid')

      const tombstone = {
        formatVersion: AUTH_FORMAT_VERSION,
        scopeId: key.scopeId,
        siteKey: key.siteKey,
        accountKey: key.accountKey,
        epoch,
        revision,
        revisionCounter,
        revokedAt,
      }
      const epochDir = join(root, 'epochs', key.encodedSite)
      await atomicWrite(root, epochDir, `${key.encodedAccount}.json`, serialize(tombstone))

      const nextEntry = previous === null
        ? {
            scopeId: key.scopeId,
            siteKey: key.siteKey,
            accountKey: key.accountKey,
            headRevision: null,
            headEpoch: null,
            epoch,
            capturedAt: null,
            sourceSessionId: null,
            bytes: 0,
            revisionCounter,
            baseRevision: null,
            capabilities: [],
          }
        : { ...previous, epoch, revisionCounter }
      await runExclusive(this.indexLocks, 'index', async () => {
        const latest = await readIndex(root)
        latest.entries[key.id] = nextEntry
        await writeIndex(root, latest)
      })
      return { epoch, revision }
    })
  }

  async epochOf({ scopeId, siteKey, accountKey }) {
    const key = makeKey(scopeId, siteKey, accountKey)
    const root = await this.ensureRoot()
    const index = await readIndex(root)
    const entry = index.entries[key.id]
    const epochRecord = await readEpoch(root, key)
    return Math.max(entry?.epoch ?? 0, epochRecord?.epoch ?? 0)
  }

  async ensureRoot() {
    if (this.rootPromise === null) {
      this.rootPromise = initializeRoot(this.configuredRoot).catch((error) => {
        this.rootPromise = null
        throw error
      })
    }
    const root = await this.rootPromise
    try {
      const info = await fs.lstat(root)
      if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(root) !== root) throw new Error()
      const handle = await openDirectory(root)
      await handle.close()
    } catch {
      throw new Error('auth storage root is unsafe')
    }
    return root
  }
}

/** Return only a URL's origin; invalid or opaque-origin inputs produce null. */
export function redactUrl(value) {
  if (typeof value !== 'string') return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function makeKey(scopeId, siteKey, accountKey) {
  validateKeyPart(scopeId, 'scope id')
  validateKeyPart(siteKey, 'site key')
  validateKeyPart(accountKey, 'account key')
  const id = sha256(JSON.stringify([scopeId, siteKey, accountKey]))
  return {
    id,
    scopeId,
    siteKey,
    accountKey,
    encodedSite: sha256(JSON.stringify([scopeId, siteKey])),
    encodedAccount: sha256(accountKey),
  }
}

function validateKeyPart(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new Error(`invalid ${label}`)
  }
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function makeRevision(counter) {
  return `${counter}-${randomBytes(12).toString('hex')}`
}

function isRevokedEntry(entry, epoch) {
  if (entry === null || entry === undefined || entry.headRevision === null) return epoch > 0
  return entry.headEpoch < epoch
}

function summaryFor(entry) {
  if (entry === null || entry === undefined || entry.headRevision === null) return null
  return {
    siteKey: entry.siteKey,
    accountKey: entry.accountKey,
    revision: entry.headRevision,
    epoch: entry.headEpoch,
    capturedAt: entry.capturedAt,
    sourceSessionId: entry.sourceSessionId,
    bytes: entry.bytes,
  }
}

function copyAndValidateState(state) {
  let encoded
  try {
    encoded = JSON.stringify(state)
  } catch {
    throw new Error('auth state must be JSON-serializable')
  }
  if (typeof encoded !== 'string') throw new Error('auth state is invalid')
  let copy
  try {
    copy = JSON.parse(encoded)
  } catch {
    throw new Error('auth state is invalid')
  }
  if (!isRecord(copy) || !Array.isArray(copy.cookies) || !Array.isArray(copy.origins)) {
    throw new Error('auth state must contain cookies and origins arrays')
  }
  for (const cookie of copy.cookies) {
    if (!isRecord(cookie) || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') {
      throw new Error('auth state contains an invalid cookie')
    }
  }
  for (const origin of copy.origins) {
    if (!isRecord(origin) || typeof origin.origin !== 'string' || !Array.isArray(origin.localStorage)) {
      throw new Error('auth state contains an invalid origin')
    }
    for (const item of origin.localStorage) {
      if (!isRecord(item) || typeof item.name !== 'string' || typeof item.value !== 'string') {
        throw new Error('auth state contains an invalid localStorage item')
      }
    }
  }
  return copy
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function serialize(value) {
  try {
    const text = JSON.stringify(value)
    if (typeof text !== 'string') throw new Error()
    return text
  } catch {
    throw new Error('auth data could not be serialized')
  }
}

async function initializeRoot(configuredRoot) {
  try {
    await fs.mkdir(configuredRoot, { recursive: true, mode: DIRECTORY_MODE })
    const root = await fs.realpath(configuredRoot)
    const info = await fs.lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error()
    const handle = await openDirectory(root)
    try {
      await handle.chmod(DIRECTORY_MODE)
    } finally {
      await handle.close()
    }
    return root
  } catch {
    throw new Error('auth storage root is unavailable')
  }
}

function containedPath(root, ...parts) {
  const target = resolve(root, ...parts)
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('auth storage path is outside its root')
  }
  return target
}

async function ensureDirectory(root, parts) {
  let current = root
  for (const part of parts) {
    if (typeof part !== 'string' || part === '' || part === '.' || part === '..' || /[\\/\0]/.test(part)) {
      throw new Error('auth storage path is invalid')
    }
    const next = containedPath(root, relative(root, current), part)
    try {
      await fs.mkdir(next, { mode: DIRECTORY_MODE })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw new Error('auth storage directory is unavailable')
    }
    try {
      const info = await fs.lstat(next)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error()
      const canonical = await fs.realpath(next)
      if (canonical !== next) throw new Error()
      const handle = await openDirectory(next)
      try {
        await handle.chmod(DIRECTORY_MODE)
      } finally {
        await handle.close()
      }
    } catch {
      throw new Error('auth storage directory is unsafe')
    }
    current = next
  }
  return current
}

async function openDirectory(directoryPath) {
  try {
    const handle = await fs.open(directoryPath, fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW)
    const info = await handle.stat()
    if (!info.isDirectory()) {
      await handle.close()
      throw new Error()
    }
    return handle
  } catch {
    throw new Error('auth storage directory is unsafe')
  }
}

async function readIndex(root) {
  const raw = await readJson(root, containedPath(root, 'index.json'), {
    optional: true,
    invalidMessage: 'auth index is invalid',
  })
  if (raw === null) return { formatVersion: AUTH_FORMAT_VERSION, entries: {} }
  if (!isRecord(raw) || raw.formatVersion !== AUTH_FORMAT_VERSION || !isRecord(raw.entries)) {
    throw new Error('auth index is invalid')
  }
  for (const [id, entry] of Object.entries(raw.entries)) {
    if (!/^[a-f0-9]{64}$/.test(id) || !isRecord(entry)
      || typeof entry.scopeId !== 'string' || typeof entry.siteKey !== 'string' || typeof entry.accountKey !== 'string'
      || makeKey(entry.scopeId, entry.siteKey, entry.accountKey).id !== id
      || (entry.headRevision !== null && (typeof entry.headRevision !== 'string' || !isRevision(entry.headRevision)))
      || (entry.headRevision === null && entry.headEpoch !== null)
      || (entry.headRevision !== null && !isEpoch(entry.headEpoch))
      || !isEpoch(entry.epoch)
      || !isEpoch(entry.revisionCounter)
      || (entry.capturedAt !== null && !Number.isFinite(entry.capturedAt))
      || (entry.sourceSessionId !== null && typeof entry.sourceSessionId !== 'string')
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error('auth index is invalid')
    }
  }
  return raw
}

async function writeIndex(root, index) {
  const text = serialize(index)
  await atomicWrite(root, root, 'index.json', text)
}

async function readEpoch(root, key) {
  const filePath = containedPath(root, 'epochs', key.encodedSite, `${key.encodedAccount}.json`)
  const raw = await readJson(root, filePath, { optional: true, invalidMessage: 'auth epoch record is invalid' })
  if (raw === null) return null
  if (!isRecord(raw)
    || raw.formatVersion !== AUTH_FORMAT_VERSION
    || raw.scopeId !== key.scopeId
    || raw.siteKey !== key.siteKey
    || raw.accountKey !== key.accountKey
    || !isEpoch(raw.epoch)
    || !isRevision(raw.revision)
    || !isEpoch(raw.revisionCounter)) {
    throw new Error('auth epoch record is invalid')
  }
  return raw
}

function isEpoch(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function isRevision(value) {
  return typeof value === 'string' && /^\d+-[a-f0-9]{24}$/.test(value)
}

async function readJson(root, filePath, { optional, invalidMessage }) {
  let handle
  try {
    const resolved = resolve(filePath)
    const rootCanonical = await fs.realpath(root)
    if (rootCanonical !== root) throw new Error()
    const relativePath = relative(root, resolved)
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error()
    const info = await fs.lstat(resolved)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error()
    const canonical = await fs.realpath(resolved)
    if (canonical !== resolved) throw new Error()
    handle = await fs.open(resolved, fsConstants.O_RDONLY | NOFOLLOW)
    const openedInfo = await handle.stat()
    if (!openedInfo.isFile()) throw new Error()
    const text = await handle.readFile('utf8')
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(invalidMessage)
    }
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null
    if (error?.message === invalidMessage) throw error
    throw new Error(invalidMessage)
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined)
  }
}

async function atomicWrite(root, directoryPath, targetName, contents, { replace = true } = {}) {
  if (typeof targetName !== 'string' || targetName === '' || targetName === '.' || targetName === '..' || /[\\/\0]/.test(targetName)) {
    throw new Error('auth storage target is invalid')
  }
  const tempName = `.tmp-${process.pid}-${randomBytes(12).toString('hex')}`
  let tempPath
  let targetPath
  try {
    if (await fs.realpath(root) !== root || await fs.realpath(directoryPath) !== directoryPath) throw new Error()
    tempPath = containedPath(root, relative(root, directoryPath), tempName)
    targetPath = containedPath(root, relative(root, directoryPath), targetName)
  } catch {
    throw new Error('auth storage path is unsafe')
  }
  let handle
  let renamed = false
  try {
    if (replace) {
      try {
        const existing = await fs.lstat(targetPath)
        if (existing.isSymbolicLink() || !existing.isFile()) throw new Error()
      } catch (error) {
        if (error?.code !== 'ENOENT') throw new Error()
      }
    } else {
      try {
        await fs.lstat(targetPath)
        throw new Error()
      } catch (error) {
        if (error?.code !== 'ENOENT') throw new Error()
      }
    }
    handle = await fs.open(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
      FILE_MODE,
    )
    await handle.writeFile(contents, 'utf8')
    await handle.chmod(FILE_MODE)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(tempPath, targetPath)
    renamed = true
    await syncDirectory(directoryPath)
  } catch {
    throw new Error('auth data could not be committed')
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined)
    if (!renamed) await fs.unlink(tempPath).catch(() => undefined)
  }
}

async function syncDirectory(directoryPath) {
  let handle
  try {
    handle = await fs.open(directoryPath, fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW)
    const info = await handle.stat()
    if (!info.isDirectory()) throw new Error()
    await handle.sync()
  } catch {
    throw new Error('auth storage directory could not be synced')
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined)
  }
}

async function runExclusive(locks, key, operation) {
  const previous = locks.get(key)
  let release
  const gate = new Promise((resolveGate) => { release = resolveGate })
  locks.set(key, gate)
  if (previous !== undefined) await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (locks.get(key) === gate) locks.delete(key)
  }
}
