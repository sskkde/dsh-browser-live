/**
 * dsh-browser-live — per-session Neko container pool (the `browserLive` service).
 *
 * Every live session gets its own Neko virtual Chromium container, its own CDP
 * endpoint, its own profile volume, and its own viewer path:
 *
 *   slot 0  → legacy shared container `neko`     (viewer `/browser`,     CDP 9222)
 *   slot n  → per-session container `neko-<short>` (viewer `/browser/<short>/`,
 *             CDP 9222+n, web 8080+2n, UDPMUX 52100+n, TCPMUX 52101+n)
 *
 * `short` = base36(sha1(sessionId)).slice(0, 8). The session→container map is
 * persisted to `~/.dsh/neko-browser-live.map.json`, so a harness restart adopts
 * running containers as-is. The pool is bounded (`maxSessions`); when full, the
 * least-recently-used session's container is stopped and its nginx location
 * removed (its profile volume is kept — D3 keeps browser state across sessions).
 *
 * Slots are lazy twice over. `ensure()` (called on the session's first browser
 * tool call, and by the provider's tools/execute hook) is what calls
 * `allocate()` — an agent that never browses never takes a slot, so opening a
 * Session or spawning a subagent can no longer evict a live one. Container
 * starts are lazier still: `allocate()` only reserves the slot and pins the
 * endpoints, and the docker work happens inside the same `ensure()`.
 *
 * Two reclaim paths keep the pool honest: LRU eviction on a full pool (above),
 * and `sweepIdle()` — the idle sweeper releases slots untouched for
 * `idleTtlMs` (default 4 h), which is what stops abandoned subagent slots from
 * shrinking the pool. Everything is best-effort: docker/nginx failures are
 * logged with the `[browser-live]` prefix and never throw into the harness.
 */

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { log, warn } from './log.js'

const run = promisify(execFile)

export const IMAGE = 'neko-chromium-cdp:latest'
export const DSH_WEB_PORT = 3080

/** Slot 0 keeps the pre-concurrency deployment's names and paths. */
const LEGACY = Object.freeze({
  slot: 0,
  container: 'neko',
  volume: 'neko-profile',
  cdpPort: 9222,
  webPort: 8080,
  publicPath: '/browser',
})

/**
 * Port bases for pool slots. The legacy container keeps 9222 / 8080 / 52100 /
 * 52101 for as long as it runs, so the new pool starts above those ranges and
 * never assigns slot 0 to that container.
 */
export const POOL_PORTS = Object.freeze({ cdp: 9300, web: 8300, udpMux: 52200, tcpMux: 52210 })

/** Current session-map format. Version 1 maps are migrated, never rewritten in place. */
export const MAP_VERSION = 2

/**
 * Ports for one pool slot. The slot only decides the port block; every slot
 * gets its own container, profile volume and viewer path.
 * @param {number} slot - zero-based slot index.
 * @returns {{ cdpPort: number, webPort: number, udpMux: number, tcpMux: number }} the slot's port block.
 */
export function poolPorts(slot) {
  return {
    cdpPort: POOL_PORTS.cdp + slot,
    webPort: POOL_PORTS.web + 2 * slot,
    udpMux: POOL_PORTS.udpMux + slot,
    tcpMux: POOL_PORTS.tcpMux + slot,
  }
}

/** Raised when the pool is full and no slot may be reclaimed without killing work. */
export class BrowserLiveCapacityError extends Error {
  /**
   * @param {number} capacity - configured slot count.
   * @param {string[]} busy - sessions holding a lease or inside a turn.
   */
  constructor(capacity, busy) {
    super(`browser pool is full (${capacity} slots) and every slot is busy or being reclaimed; retry once the running browser operation settles`)
    this.name = 'BrowserLiveCapacityError'
    this.capacity = capacity
    this.busy = busy
  }
}

/**
 * Least-recently-used session that may be reclaimed without interrupting work.
 * Entries already being deleted are excluded: their slot is on its way out and
 * must not be handed to another session before the container is gone.
 * @param {Record<string, {lastUsed?: number, state?: string}>} sessions - map entries.
 * @param {{ busy?: Set<string>, leased?: Set<string> }} [busy] - sessions that must not be reclaimed.
 * @returns {string | null} the session id to reclaim, or null when none qualifies.
 */
export function pickEvictionCandidate(sessions, busy = {}) {
  const busyIds = busy.busy ?? new Set()
  const leasedIds = busy.leased ?? new Set()
  const candidates = Object.entries(sessions)
    .filter(([id, entry]) => entry !== null && typeof entry === 'object'
      && entry.state !== 'deleting'
      && !busyIds.has(id) && !leasedIds.has(id))
    .sort(([, a], [, b]) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0))
  return candidates.length === 0 ? null : candidates[0][0]
}

/**
 * Migrate any session map to {@link MAP_VERSION} without touching containers.
 *
 * Version 1 could hand slot 0 the shared legacy `neko` container. That entry is
 * retired into `retired` (kept as a migration source, never adopted, never
 * deleted here); every other entry keeps its container and profile volume and
 * gains an instance generation plus a reclaim state.
 * @param {unknown} raw - parsed map file, any version.
 * @param {number} [now] - epoch ms for the migration stamp.
 * @returns {{version: number, generation: number, sessions: Record<string, object>, retired: object[], migratedAt?: number}} the migrated map.
 */
export function migrateMap(raw, now = Date.now()) {
  const map = { version: MAP_VERSION, generation: 1, sessions: {}, retired: [] }
  if (raw === null || typeof raw !== 'object' || raw.sessions === null || typeof raw.sessions !== 'object') return map
  if (Array.isArray(raw.retired)) map.retired = raw.retired.filter((item) => item !== null && typeof item === 'object')
  if (Number.isInteger(raw.generation) && raw.generation > 0) map.generation = raw.generation
  const previous = Number.isInteger(raw.version) ? raw.version : 1
  for (const [sessionId, entry] of Object.entries(raw.sessions)) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.legacy === true || entry.container === LEGACY.container) {
      map.retired.push({
        sessionId,
        container: entry.container ?? LEGACY.container,
        volume: entry.volume ?? LEGACY.volume,
        cdpPort: entry.cdpPort ?? LEGACY.cdpPort,
        retiredAt: now,
      })
      continue
    }
    map.sessions[sessionId] = {
      ...entry,
      legacy: false,
      generation: Number.isInteger(entry.generation) && entry.generation > 0 ? entry.generation : 1,
      state: entry.state === 'deleting' ? 'deleting' : 'active',
      migratedFrom: previous,
    }
  }
  if (previous !== MAP_VERSION) map.migratedAt = now
  return map
}

const CDP_READY_ATTEMPTS = 20
const CDP_READY_INTERVAL_MS = 2_000

/** Default idle budget for a session's slot: 4 hours without a browser call. */
export const DEFAULT_IDLE_TTL_MS = 4 * 60 * 60 * 1000

/** Sweep cadence for a TTL: TTL/20, clamped to [1 min, 15 min]. */
function sweepIntervalMs(ttlMs) {
  if (!(ttlMs > 0)) return 0
  return Math.min(15 * 60_000, Math.max(60_000, Math.floor(ttlMs / 20)))
}

/**
 * Session ids whose slot has been idle past `ttlMs`, oldest first.
 *
 * Pure, so the reclaim policy is testable without a context. Entries already on
 * their way out are skipped, and the legacy container is not in the map at all:
 * migration retires it instead of lending it to slot 0.
 *
 * @param {Record<string, object>} sessions - the session map.
 * @param {number} now - current epoch ms.
 * @param {number} ttlMs - idle budget; `<= 0` disables the sweep.
 * @returns {string[]} ids the sweeper may release.
 */
export function expiredSessions(sessions, now, ttlMs) {
  if (!(ttlMs > 0)) return []
  return Object.entries(sessions)
    .filter(([, entry]) => entry.legacy !== true && entry.state !== 'deleting' && now - entry.lastUsed > ttlMs)
    .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)
    .map(([sessionId]) => sessionId)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function dshHome() {
  return process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh')
}

/** Deterministic, collision-extended container name suffix for a session id. */
export function sessionShort(sessionId, attempt = 0) {
  const seed = attempt === 0 ? String(sessionId) : `${sessionId}#${attempt}`
  let hex = crypto.createHash('sha1').update(seed).digest('hex')
  let short = BigInt(`0x${hex}`).toString(36).slice(0, 8)
  if (short.length < 8) short = short.padStart(8, '0')
  return short
}

/** Container-side path bound to {@link downloadsDir}: Chromium's default download folder. */
export const CONTAINER_DOWNLOADS = '/home/neko/Downloads'

/**
 * Host directory that backs one slot's Chromium download folder. Chromium writes
 * downloads inside the container (Playwright is told `noDefaults`, so it never
 * redirects them), so the folder is bind-mounted out to the host — that is the
 * only way a downloaded file reaches the agent.
 * @param {string} short - slot suffix; the legacy slot's empty string maps to `legacy`.
 * @returns {string} absolute host path.
 */
export function downloadsDir(short) {
  return path.join(dshHome(), 'data', 'browser-live', short || 'legacy', 'downloads')
}

/** Files directly inside `dir`, newest first. Missing directory reads as empty. */
function listFiles(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      const stat = fs.statSync(path.join(dir, entry.name))
      files.push({ name: entry.name, size: stat.size, modified: new Date(stat.mtimeMs).toISOString() })
    } catch {
      // raced with a concurrent delete: skip
    }
  }
  return files.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0))
}

function slotsFor(maxSessions) {
  return Array.from({ length: Math.max(1, maxSessions) }, (_, slot) => slot)
}

async function cdpAlive(port, timeoutMs = 3_000) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
  } catch {
    return false
  }
}

async function containerState(container) {
  try {
    const { stdout } = await run('docker', ['inspect', '-f', '{{.State.Running}}', container], { timeout: 10_000 })
    return stdout.trim() === 'true' ? 'running' : 'stopped'
  } catch {
    return 'absent'
  }
}

/**
 * Per-session Neko container pool. Extends cordis Service so instances register
 * as `browserLive` on the plugin context.
 */
export class BrowserLiveService extends Service {
  #mapPath
  #envPath
  #hostDir
  #map
  #ensuring = new Map()
  #readyCache = new Map()
  /** Sessions whose container this service (re)started since the last `ensure()`. */
  #restarted = new Set()
  /** Sessions this service has brought a container up for, in this process lifetime. */
  #served = new Set()
  /** Session ids with at least one in-flight browser operation. */
  #leases = new Map()

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - owning plugin context.
   * @param {{ maxSessions?: number, idleTtlMs?: number, egressProxy?: string }} [options]
   */
  constructor(ctx, options = {}) {
    super(ctx, 'browserLive')
    this.maxSessions = Math.min(8, Math.max(1, options.maxSessions ?? 3))
    const ttl = Number(options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS)
    this.idleTtlMs = Number.isFinite(ttl) ? Math.max(0, ttl) : DEFAULT_IDLE_TTL_MS
    this.sweepIntervalMs = sweepIntervalMs(this.idleTtlMs)
    // Chromium is launched with this proxy (or `direct://`); it is a launch flag,
    // so it reaches the browser only when the container is created.
    this.egressProxy = typeof options.egressProxy === 'string' ? options.egressProxy.trim() : ''
    this.#mapPath = path.join(dshHome(), 'neko-browser-live.map.json')
    this.#envPath = path.join(dshHome(), 'neko-browser-live.env')
    this.#hostDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'host')
    this.#map = this.#readMap()
  }

  // ---------------------------------------------------------------- map io

  #readMap() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#mapPath, 'utf8'))
      const migrated = migrateMap(parsed)
      if (migrated.retired.length > 0) {
        log('retired legacy slot entries from the session map:', migrated.retired.map((item) => item.container).join(', '))
      }
      return migrated
    } catch {
      // missing or unreadable map: start empty
    }
    return { version: MAP_VERSION, generation: 1, sessions: {}, retired: [] }
  }

  #writeMap() {
    const tmp = `${this.#mapPath}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.#mapPath), { recursive: true })
      fs.writeFileSync(tmp, `${JSON.stringify(this.#map, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(tmp, this.#mapPath)
    } catch (error) {
      warn('cannot persist session map:', error.message)
    }
  }

  // ------------------------------------------------------------ allocation

  entryFor(sessionId) {
    return this.#map.sessions[sessionId] ?? null
  }

  /**
   * Reserve a slot for the session without starting anything. Idempotent.
   *
   * Every slot — including slot 0 — gets its own container, profile volume and
   * viewer path; the shared legacy `neko` container is never handed out (map
   * migration retires it). When the pool is full the least-recently-used idle
   * session is marked for reclamation, but its slot is **not** reused until the
   * container is actually gone, so the caller gets a capacity error to retry.
   * Every call announces the owning session on `browserLive/allocated` so the
   * provider can hand the slot back when that activation ends — whichever tool
   * path allocated it.
   * @param {string} sessionId - durable session id (`agent.session.id`).
   * @returns {object} the session's map entry.
   * @throws {BrowserLiveCapacityError} when no slot is free and nothing may be reclaimed.
   */
  allocate(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('browserLive.allocate requires a session id')
    }
    const existing = this.#map.sessions[sessionId]
    if (existing) {
      if (existing.state === 'deleting') {
        throw new Error(`session ${sessionId}: its browser is still being reclaimed; retry in a moment`)
      }
      existing.lastUsed = Date.now()
      existing.generation = Number.isInteger(existing.generation) ? existing.generation : 1
      this.#writeMap()
      this.#announceAllocation(sessionId, existing)
      return existing
    }
    const used = new Set(Object.values(this.#map.sessions).map((entry) => entry.slot))
    const slot = slotsFor(this.maxSessions).find((candidate) => !used.has(candidate))
    if (slot === undefined) {
      const victim = pickEvictionCandidate(this.#map.sessions, { leased: new Set(this.#leases.keys()) })
      if (victim === null) {
        throw new BrowserLiveCapacityError(this.maxSessions, this.#busySessions())
      }
      const entry = this.#map.sessions[victim]
      warn('pool full (' + this.maxSessions + '); reclaiming least-recently-used session', entry.short)
      this.#evict(victim, entry)
      throw new BrowserLiveCapacityError(this.maxSessions, this.#busySessions())
    }
    let short = sessionShort(sessionId)
    for (let attempt = 1; Object.values(this.#map.sessions).some((entry) => entry.short === short); attempt++) {
      short = sessionShort(sessionId, attempt)
    }
    const ports = poolPorts(slot)
    const entry = {
      slot,
      legacy: false,
      generation: 1,
      state: 'active',
      short,
      container: `neko-${short}`,
      volume: `neko-profile-${short}`,
      ...ports,
      publicPath: `/browser/${short}`,
      createdAt: Date.now(),
      lastUsed: Date.now(),
    }
    this.#map.sessions[sessionId] = entry
    this.#writeMap()
    log('allocated slot', slot, '(' + entry.container + ') for session', sessionId)
    this.#announceAllocation(sessionId, entry)
    return entry
  }

  /**
   * Publish which activation now holds a slot. The provider listens so that an
   * activation's end can release exactly the entry it was given; the event
   * covers every allocation path (`browser_live_*` tools allocate inside their
   * own call, not through the provider's MCP hook).
   */
  #announceAllocation(sessionId, entry) {
    try {
      this.ctx.emit('browserLive/allocated', { sessionId, entry })
    } catch (error) {
      warn('allocation announce failed:', error.message)
    }
  }

  /**
   * Begin reclaiming a slot: `active → deleting → released`.
   *
   * The entry stays in the map (and keeps its slot reserved) until the container
   * is actually gone, so a slot is never handed to another session while the
   * previous container still exists. A failed deletion keeps the entry with its
   * error so the next sweep can retry it instead of losing track of a live
   * container.
   * @param {string} sessionId - durable session id.
   * @param {object} entry - the map entry to reclaim.
   */
  #evict(sessionId, entry) {
    if (entry.state === 'deleting') return
    entry.state = 'deleting'
    entry.deletingSince = Date.now()
    this.#writeMap()
    this.#readyCache.delete(sessionId)
    void this.#finishEviction(sessionId, entry)
  }

  async #finishEviction(sessionId, entry) {
    try {
      await this.#stopContainer(entry.container)
      await this.#dropNginxLocation(entry.publicPath).catch(() => undefined)
      if (this.#map.sessions[sessionId] === entry) {
        delete this.#map.sessions[sessionId]
        this.#writeMap()
      }
      log('released', entry.container, '(slot ' + entry.slot + ')')
    } catch (error) {
      entry.state = 'active'
      entry.lastError = error.message
      delete entry.deletingSince
      this.#writeMap()
      warn('reclaim failed; keeping', entry.container, 'in the map for retry:', error.message)
    }
  }

  /**
   * Explicitly release a session's container. Idempotent; the slot becomes
   * reusable only after the container is actually gone.
   * @param {string} sessionId - durable session id.
   */
  release(sessionId) {
    const entry = this.#map.sessions[sessionId]
    if (!entry || entry.state === 'deleting') return
    log('releasing session', sessionId, '(' + entry.container + ')')
    this.#evict(sessionId, entry)
  }

  /**
   * Take a lease on a session's browser for the duration of one operation.
   * Leased sessions are never reclaimed and never evicted; the returned function
   * releases the lease and must be called (idempotently) in a `finally`.
   * @param {string} sessionId - durable session id.
   * @returns {() => void} release function.
   */
  lease(sessionId) {
    this.#leases.set(sessionId, (this.#leases.get(sessionId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.#leases.get(sessionId) ?? 1) - 1
      if (remaining <= 0) this.#leases.delete(sessionId)
      else this.#leases.set(sessionId, remaining)
    }
  }

  /** True while any operation holds a lease on the session's browser. */
  leased(sessionId) {
    return (this.#leases.get(sessionId) ?? 0) > 0
  }

  /** Sessions holding a lease or inside a running turn. */
  #busySessions() {
    const busy = new Set(this.#leases.keys())
    for (const sessionId of Object.keys(this.#map.sessions)) {
      if (this.#agentBusy(sessionId)) busy.add(sessionId)
    }
    return [...busy]
  }

  /**
   * Release every slot idle past `idleTtlMs`, oldest first.
   *
   * This is the reclaim path for sessions that were abandoned rather than
   * evicted: a settled subagent, or a Session whose agent is still resident but
   * has not touched its browser in hours. A session whose agent is inside a
   * turn is skipped for this pass — pulling a container out from under a
   * running operation is worse than holding the slot until the next sweep.
   *
   * @param {number} [now] - epoch ms; injectable for tests.
   * @returns {Promise<string[]>} released session ids, oldest first.
   */
  async sweepIdle(now = Date.now()) {
    const released = []
    for (const sessionId of expiredSessions(this.#map.sessions, now, this.idleTtlMs)) {
      const entry = this.#map.sessions[sessionId]
      if (entry === undefined) continue
      if (this.leased(sessionId) || this.#agentBusy(sessionId)) {
        log('idle sweep: keeping', entry.container, '(browser operation in flight)')
        continue
      }
      log('idle sweep: releasing', entry.container, '(idle ' + Math.round((now - entry.lastUsed) / 60_000) + ' min)')
      this.release(sessionId)
      released.push(sessionId)
    }
    return released
  }

  /** True while the session's agent is mid-turn (best-effort, never throws). */
  #agentBusy(sessionId) {
    try {
      return this.ctx.get('agents')?.get(sessionId)?.status === 'running'
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------- endpoints

  /** CDP endpoint for the session's container (valid after allocate()). */
  endpointFor(sessionId) {
    const entry = this.#map.sessions[sessionId]
    return entry ? `http://127.0.0.1:${entry.cdpPort}` : null
  }

  /** Public viewer path for the session's container, e.g. `/browser/<short>/`. */
  viewerPath(sessionId) {
    const entry = this.#map.sessions[sessionId]
    return entry ? `${entry.publicPath}/` : null
  }

  // ------------------------------------------------------------ provisioning

  /**
   * Make sure the session's container is running, healthy, and proxied.
   * Concurrent and repeat calls share one in-flight start per session.
   * @param {string} sessionId - durable session id.
   * @returns {Promise<object>} the session's map entry, ready for CDP attach.
   */
  async ensure(sessionId) {
    const entry = this.allocate(sessionId)
    const inflight = this.#ensuring.get(sessionId)
    if (inflight) return inflight
    const start = this.#ensureEntry(entry, sessionId).finally(() => this.#ensuring.delete(sessionId))
    this.#ensuring.set(sessionId, start)
    return start
  }

  /**
   * Report — and clear — whether the most recent `ensure()` had to (re)start this
   * session's container after this service had already brought one up for it.
   *
   * That is exactly the condition under which a session's MCP server can be
   * holding a dead CDP connection: it connected to a browser process that no
   * longer exists. A container this call created for the first time is not a
   * restart (nothing could have been attached to it), and neither is a fresh
   * process lifetime (a harness restart replaces the MCP servers too).
   *
   * @param {string} sessionId - durable session id.
   * @returns {boolean} true when a previously served container had to be (re)started.
   */
  consumeRestart(sessionId) {
    return this.#restarted.delete(sessionId)
  }

  async #ensureEntry(entry, sessionId) {
    if (entry.state === 'deleting') throw new Error(`container ${entry.container} is being reclaimed; retry in a moment`)
    const state = await containerState(entry.container)
    const served = this.#served.has(sessionId)
    if (state !== 'running') {
      if (state === 'stopped') await run('docker', ['rm', '-f', entry.container], { timeout: 30_000 }).catch(() => undefined)
      await this.#startContainer(entry)
      if (state === 'stopped' || served) this.#restarted.add(sessionId)
    } else if (!(await cdpAlive(entry.cdpPort))) {
      log('container', entry.container, 'is running but CDP is down; restarting it')
      await run('docker', ['restart', entry.container], { timeout: 60_000 }).catch((error) => warn('restart failed:', error.message))
      await this.#waitCdp(entry)
      this.#restarted.add(sessionId)
    }
    if (entry.state === 'deleting') throw new Error(`container ${entry.container} is being reclaimed; retry in a moment`)
    await this.#ensureNginxLocation(entry.publicPath, entry.webPort)
    log('session container ready:', entry.container, 'CDP 127.0.0.1:' + entry.cdpPort, 'viewer', entry.publicPath + '/')
    this.#served.add(sessionId)
    return entry
  }

  async #waitCdp(entry) {
    for (let attempt = 0; attempt < CDP_READY_ATTEMPTS; attempt++) {
      await sleep(CDP_READY_INTERVAL_MS)
      if (await cdpAlive(entry.cdpPort, 2_000)) return
    }
    throw new Error(`container ${entry.container} CDP did not come up; check docker logs ${entry.container}`)
  }

  async #startContainer(entry) {
    await this.#ensureImage()
    const envFile = await this.#ensureEnvFile()
    const downloads = downloadsDir(entry.short)
    try {
      fs.mkdirSync(downloads, { recursive: true })
    } catch (error) {
      warn('cannot create download directory:', error.message)
    }
    const args = [
      'run', '-d',
      '--name', entry.container,
      // Fixed hostname: the profile volume's chromium SingletonLock records it;
      // a changing hostname would make every restart refuse the profile.
      '--hostname', entry.container,
      '--restart', 'unless-stopped',
      // Chrome enforces loopback-only DevTools binds, so host networking is the
      // only way the host-side CDP attach (127.0.0.1) can reach it.
      '--network', 'host',
      '--shm-size', '1g',
      '--env-file', envFile,
    ]
    args.push(
      '-e', `NEKO_WEBRTC_UDPMUX=${entry.udpMux}`,
      '-e', `NEKO_WEBRTC_TCPMUX=${entry.tcpMux}`,
      '-e', `NEKO_SERVER_PATH_PREFIX=${entry.publicPath}`,
      '-e', 'NEKO_SERVER_PROXY=true',
      '-e', `NEKO_SERVER_BIND=127.0.0.1:${entry.webPort}`,
      // X11 abstract sockets live in the network namespace, which host
      // networking shares: the image's baked-in DISPLAY=:99 would collide with
      // the legacy container's X server, so give each slot its own.
      '-e', `DISPLAY=:${900 + entry.slot * 10}.0`,
    )
    args.push(
      '-v', `${entry.volume}:/home/neko/.config/chromium`,
      // Chromium's default download folder, bound to the host so downloaded
      // files are reachable by the agent at all (they are otherwise trapped
      // inside the container's filesystem). Playwright is told `noDefaults`, so
      // it never redirects downloads away from this directory.
      '-v', `${downloads}:${CONTAINER_DOWNLOADS}`,
      // Skip Neko's credential gate: the viewer is already behind the DSH Web
      // auth (nginx Basic Auth + trusted-host fence), so a second login only
      // adds friction. noauth still shows a display-name field but accepts any
      // value and no password. Overrides the multiuser env-file passwords.
      '-e', 'NEKO_MEMBER_PROVIDER=noauth',
      // The image's chromium.conf expands %(ENV_CDP_PORT)s: every container
      // binds its own DevTools port (host networking shares loopback, so a
      // baked-in 9222 would collide across containers).
      '-e', `CDP_PORT=${entry.cdpPort}`,
      // chromium.conf also expands %(ENV_CHROMIUM_PROXY)s into --proxy-server.
      // The variable must always exist or supervisord refuses to start the
      // program, hence the `direct://` default; `--proxy-server` cannot be set
      // per Playwright context here, because an attached (CDP) MCP server reuses
      // the browser's existing default context and ignores context options.
      '-e', `CHROMIUM_PROXY=${this.egressProxy || 'direct://'}`,
      '--health-cmd', `wget -q -O - http://127.0.0.1:${entry.webPort}${entry.publicPath}/health || exit 1`,
      '--health-interval', '15s', '--health-timeout', '5s', '--health-retries', '4',
      IMAGE,
    )
    log('starting container', entry.container, '(slot', entry.slot + ')')
    await run('docker', args, { timeout: 60_000 })
    await this.#waitCdp(entry)
    log('container CDP is up on', `127.0.0.1:${entry.cdpPort}`)
  }

  async #stopContainer(container) {
    await run('docker', ['rm', '-f', container], { timeout: 30_000 })
    log('stopped container', container)
  }

  async #ensureImage() {
    // Always build -q: with an unchanged host/ context every layer is cached
    // (a second), and a changed chromium.conf self-heals the running pool on
    // the next container start. On build failure, fall back to the old image.
    try {
      await run('docker', ['build', '-q', '-t', IMAGE, this.#hostDir], { timeout: 300_000 })
      return
    } catch (error) {
      warn('image build failed:', error.message)
    }
    try {
      await run('docker', ['image', 'inspect', IMAGE], { timeout: 10_000 })
      log('adopted existing', IMAGE, 'despite build failure')
    } catch {
      throw new Error(`image ${IMAGE} unavailable and build failed; check docker output`)
    }
  }

  async #ensureEnvFile() {
    let created = false
    if (!fs.existsSync(this.#envPath)) {
      let publicIp = ''
      try {
        const { stdout } = await run('curl', ['-s', '--max-time', '5', 'https://checkip.amazonaws.com'], { timeout: 8_000 })
        publicIp = stdout.trim()
      } catch {
        warn('public IP detection failed; set NEKO_WEBRTC_NAT1TO1 manually in', this.#envPath, 'if WebRTC video fails')
      }
      const lines = [
        `NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=${crypto.randomBytes(12).toString('hex')}`,
        `NEKO_MEMBER_MULTIUSER_USER_PASSWORD=${crypto.randomBytes(12).toString('hex')}`,
        ...(publicIp ? [`NEKO_WEBRTC_NAT1TO1=${publicIp}`] : []),
        `NEKO_WEBRTC_UDPMUX=${52100}`,
        `NEKO_WEBRTC_TCPMUX=${52101}`,
        `NEKO_SERVER_PATH_PREFIX=${LEGACY.publicPath}`,
        'NEKO_SERVER_PROXY=true',
        `NEKO_SERVER_BIND=127.0.0.1:${LEGACY.webPort}`,
        '',
      ]
      fs.writeFileSync(this.#envPath, lines.join('\n'), { mode: 0o600 })
      log('wrote', this.#envPath, '(neko passwords live here, chmod 600)')
      created = true
    }
    if (!created) {
      // Pre-concurrency env files predate the %(ENV_CDP_PORT)s image; make sure
      // the legacy slot-0 container can still be recreated from it.
      const content = fs.readFileSync(this.#envPath, 'utf8')
      if (!/^CDP_PORT=/m.test(content)) {
        fs.appendFileSync(this.#envPath, 'CDP_PORT=9222\n')
      }
      // Same for %(ENV_CHROMIUM_PROXY)s: supervisord refuses to start a program
      // whose expansion has no variable, so an older env file must gain one.
      if (!/^CHROMIUM_PROXY=/m.test(content)) {
        fs.appendFileSync(this.#envPath, 'CHROMIUM_PROXY=direct://\n')
      }
    }
    return this.#envPath
  }

  // --------------------------------------------------------------- downloads

  /**
   * Files this session's browser has downloaded, newest first.
   *
   * Chromium writes downloads into the container, so the host directory is
   * authoritative only for containers created with the bind mount. A container
   * adopted from an earlier version has no mount — for those, the files are
   * pulled out with `docker cp` so the answer does not depend on when the
   * container happened to be created.
   *
   * @param {string} sessionId - durable session id.
   * @returns {Promise<{ dir: string, mounted: boolean, collected: boolean, files: Array<{name: string, size: number, modified: string}> }>}
   */
  async listDownloads(sessionId) {
    const entry = this.entryFor(sessionId)
    const dir = downloadsDir(entry?.short ?? sessionShort(sessionId))
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (error) {
      warn('cannot create download directory:', error.message)
    }
    if (entry === null) return { dir, mounted: false, collected: false, files: listFiles(dir) }
    const mounted = await this.#hasDownloadsMount(entry.container, dir)
    let collected = false
    if (!mounted && (await containerState(entry.container)) === 'running') {
      try {
        await run('docker', ['cp', `${entry.container}:${CONTAINER_DOWNLOADS}/.`, dir], { timeout: 60_000 })
        collected = true
      } catch {
        // No download folder inside the container yet: nothing to collect.
      }
    }
    return { dir, mounted, collected, files: listFiles(dir) }
  }

  /** Whether a running container carries the host download bind mount. */
  async #hasDownloadsMount(container, dir) {
    try {
      const { stdout } = await run('docker', ['inspect', '-f', '{{json .Mounts}}', container], { timeout: 10_000 })
      const mounts = JSON.parse(stdout.trim() || '[]')
      return Array.isArray(mounts) && mounts.some((mount) => mount?.Source === dir || mount?.Destination === CONTAINER_DOWNLOADS)
    } catch {
      return false
    }
  }

  // ------------------------------------------------------------------ nginx

  /** True when the vhost search cannot run (no nginx, unreadable sites dir). */
  #findVhost() {
    const sitesDir = '/etc/nginx/sites-enabled'
    try {
      for (const name of fs.readdirSync(sitesDir).sort()) {
        const full = path.join(sitesDir, name)
        let content = ''
        try {
          content = fs.readFileSync(full, 'utf8')
        } catch {
          continue
        }
        if (content.includes(`proxy_pass http://127.0.0.1:${DSH_WEB_PORT}`)) return full
      }
    } catch (error) {
      warn('cannot read', sitesDir, '-', error.message)
      return null
    }
    warn('no nginx vhost proxying the DSH web UI (127.0.0.1:' + DSH_WEB_PORT + ') found')
    return null
  }

  // Runs as root via `sudo -n python3 -c <script> <vhost> <marker> <webPort>`.
  // Idempotent: exits reporting "present" when the marker location exists.
  // The presence check is exact-line (`location <marker>/ {`), so the legacy
  // `/browser` marker cannot false-match a `/browser/<short>` block.
  static NGINX_ADD_PY = [
    'import os',
    'import sys',
    'path, marker, web_port = sys.argv[1], sys.argv[2], sys.argv[3]',
    'src = open(path).read()',
    "if ('location %s/ {' % marker) in src:",
    "    print('present'); sys.exit(0)",
    "lines = src.split('\\n')",
    "idx443 = next((i for i, l in enumerate(lines) if 'listen 443' in l), None)",
    "idxloc = next((i for i, l in enumerate(lines) if idx443 is None or (i > idx443 and l.strip().startswith('location / {'))), len(lines))",
    'block = (',
    "    '    # browser-live: Neko virtual browser (managed by dsh-browser-live plugin)\\n'",
    "    '    location ' + marker + '/ {\\n'",
    "    '        proxy_pass http://127.0.0.1:' + web_port + ';\\n'",
    "    '        proxy_http_version 1.1;\\n'",
    "    '        proxy_set_header Host $host;\\n'",
    "    '        proxy_set_header X-Real-IP $remote_addr;\\n'",
    "    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\\n'",
    "    '        proxy_set_header X-Forwarded-Proto $scheme;\\n'",
    "    '        proxy_set_header Upgrade $http_upgrade;\\n'",
    "    '        proxy_set_header Connection \"upgrade\";\\n'",
    "    '        proxy_buffering off;\\n'",
    "    '        proxy_cache off;\\n'",
    "    '        proxy_read_timeout 3600s;\\n'",
    "    '        proxy_send_timeout 3600s;\\n'",
    "    '    }\\n'",
    "    '\\n'",
    ')',
    'backup_dir = "/etc/nginx/backups"',
    'os.makedirs(backup_dir, exist_ok=True)',
    'backup = os.path.join(backup_dir, path.rsplit("/", 1)[-1] + ".browser-live.bak")',
    'open(backup, "w").write(src)',
    'lines.insert(idxloc, block)',
    "open(path, 'w').write('\\n'.join(lines))",
    "print('patched')",
  ].join('\n')

  // Removes the block added above for one marker (comment line included when
  // directly above). Legacy slot-0 blocks are never removed by the pool; the
  // marker match is exact, so other locations are untouched.
  static NGINX_DROP_PY = [
    'import os',
    'import sys',
    'path, marker = sys.argv[1], sys.argv[2]',
    'src = open(path).read()',
    "lines = src.split('\\n')",
    "start = next((i for i, l in enumerate(lines) if l.strip() == 'location ' + marker + '/ {'), None)",
    'if start is None:',
    "    print('absent'); sys.exit(0)",
    'first = start',
    "if first > 0 and 'browser-live' in lines[first - 1]:",
    '    first -= 1',
    'end = start',
    "while end < len(lines) and lines[end].strip() != '}':",
    '    end += 1',
    'if end >= len(lines):',
    "    print('unterminated'); sys.exit(1)",
    'backup_dir = "/etc/nginx/backups"',
    'os.makedirs(backup_dir, exist_ok=True)',
    'backup = os.path.join(backup_dir, path.rsplit("/", 1)[-1] + ".browser-live.bak")',
    'open(backup, "w").write(src)',
    'del lines[first:end + 1]',
    "if first < len(lines) and first > 0 and lines[first].strip() == '' and lines[first - 1].strip() == '':",
    '    del lines[first]',
    "open(path, 'w').write('\\n'.join(lines))",
    "print('dropped')",
  ].join('\n')

  async #sudoNginx(script, vhost, ...rest) {
    try {
      const { stdout } = await run('sudo', ['-n', 'python3', '-c', script, vhost, ...rest], { timeout: 15_000 })
      return stdout.trim()
    } catch (error) {
      warn('nginx patch skipped (passwordless sudo unavailable?):', error.message)
      return null
    }
  }

  async #reloadNginx(vhost) {
    try {
      await run('sudo', ['-n', 'nginx', '-t'], { timeout: 15_000 })
      await run('sudo', ['-n', 'systemctl', 'reload', 'nginx'], { timeout: 15_000 })
      log('nginx: reloaded', vhost)
      return true
    } catch (error) {
      warn('nginx reload failed; restoring backup:', error.message)
      const backup = '/etc/nginx/backups/' + vhost.split('/').pop() + '.browser-live.bak'
      await run('sudo', ['-n', 'cp', backup, vhost], { timeout: 10_000 }).catch(() => undefined)
      return false
    }
  }

  async #ensureNginxLocation(publicPath, webPort) {
    const vhost = this.#findVhost()
    if (!vhost) return
    const outcome = await this.#sudoNginx(BrowserLiveService.NGINX_ADD_PY, vhost, publicPath, String(webPort))
    if (outcome === null || outcome === 'present') return
    await this.#reloadNginx(vhost)
  }

  async #dropNginxLocation(publicPath) {
    const vhost = this.#findVhost()
    if (!vhost) return
    const outcome = await this.#sudoNginx(BrowserLiveService.NGINX_DROP_PY, vhost, publicPath)
    if (outcome === 'dropped') await this.#reloadNginx(vhost)
  }

  // ------------------------------------------------------------ diagnostics

  /**
   * Readiness probe with a short TTL so route handlers can poll cheaply.
   * @param {string} sessionId - durable session id.
   * @returns {Promise<{ ready: boolean, viewerPath: string | null }>}
   */
  async sessionStatus(sessionId) {
    const entry = this.#map.sessions[sessionId]
    if (!entry) return { ready: false, viewerPath: null }
    const cached = this.#readyCache.get(sessionId)
    if (cached && Date.now() - cached.at < 2_000) return { ready: cached.ready, viewerPath: `${entry.publicPath}/` }
    const ready = (await containerState(entry.container)) === 'running' && (await cdpAlive(entry.cdpPort, 1_500))
    this.#readyCache.set(sessionId, { at: Date.now(), ready })
    return { ready, viewerPath: `${entry.publicPath}/` }
  }

  /** Host-side diagnostic snapshot (session ids are masked to their short). */
  status() {
    return {
      maxSessions: this.maxSessions,
      egressProxy: this.egressProxy === '' ? null : this.egressProxy,
      mapVersion: this.#map.version,
      retired: (this.#map.retired ?? []).map((item) => ({ container: item.container, retiredAt: new Date(item.retiredAt).toISOString() })),
      sessions: Object.entries(this.#map.sessions).map(([sessionId, entry]) => ({
        short: entry.short,
        slot: entry.slot,
        generation: entry.generation,
        state: entry.state,
        lastError: entry.lastError,
        container: entry.container,
        cdpPort: entry.cdpPort,
        webPort: entry.webPort,
        viewerPath: `${entry.publicPath}/`,
        downloadsDir: downloadsDir(entry.short),
        leased: this.leased(sessionId),
        createdAt: new Date(entry.createdAt).toISOString(),
        lastUsed: new Date(entry.lastUsed).toISOString(),
      })),
    }
  }

  /**
   * Boot-time adoption: keep map entries whose container is healthy, restart
   * entries whose container stopped, drop entries whose container vanished, and
   * recycle entries whose container is up but unreachable. Never blocks
   * activation for long; every step is best-effort.
   */
  async adoptExisting() {
    for (const [sessionId, entry] of Object.entries(this.#map.sessions)) {
      const state = await containerState(entry.container)
      // A half-finished reclaim is resumed rather than adopted: the entry keeps
      // its slot until the container is really gone.
      if (entry.state === 'deleting') {
        if (state === 'running' || state === 'stopped') {
          entry.state = 'active'
          delete entry.deletingSince
          this.#evict(sessionId, entry)
        } else {
          delete this.#map.sessions[sessionId]
          this.#writeMap()
        }
        continue
      }
      if (state === 'running') {
        let alive = await cdpAlive(entry.cdpPort)
        if (!alive) {
          // A container that is still booting can answer a moment later, and
          // recycling one that would have been fine only costs a rebuild.
          await sleep(3_000)
          alive = await cdpAlive(entry.cdpPort)
        }
        if (alive) {
          log('adopted existing container', entry.container, '(CDP OK on 127.0.0.1:' + entry.cdpPort + ')')
          await this.#ensureNginxLocation(entry.publicPath, entry.webPort)
          continue
        }
        // A container that is up with a dead CDP port is unusable, and once its
        // entry is gone nothing would ever collect it again (the pool only ever
        // touches mapped containers). Recycle it: the profile volume keeps the
        // browser state and the next ensure() rebuilds it from the image.
        log('map entry container', entry.container, 'is running but CDP is down; recycling it (profile volume kept)')
        await this.#stopContainer(entry.container).catch((error) => warn('adopt recycle:', error.message))
        void this.#dropNginxLocation(entry.publicPath)
        delete this.#map.sessions[sessionId]
        this.#writeMap()
        continue
      }
      if (state === 'stopped') {
        await run('docker', ['rm', '-f', entry.container], { timeout: 30_000 }).catch(() => undefined)
        log('dropped stale map entry', entry.container, '(container was stopped)')
      } else {
        log('dropped stale map entry', entry.container, '(container absent)')
      }
      void this.#dropNginxLocation(entry.publicPath)
      delete this.#map.sessions[sessionId]
      this.#writeMap()
    }
  }
}
