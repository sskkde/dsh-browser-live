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
 * Pure, so the reclaim policy is testable without a context. The legacy shared
 * slot is never selected: slot 0's container is shared infrastructure that is
 * never stopped, so releasing its entry reclaims nothing that the LRU path
 * cannot already reclaim.
 *
 * @param {Record<string, object>} sessions - the session map.
 * @param {number} now - current epoch ms.
 * @param {number} ttlMs - idle budget; `<= 0` disables the sweep.
 * @returns {string[]} ids the sweeper may release.
 */
export function expiredSessions(sessions, now, ttlMs) {
  if (!(ttlMs > 0)) return []
  return Object.entries(sessions)
    .filter(([, entry]) => entry.legacy !== true && now - entry.lastUsed > ttlMs)
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
      if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
        return { version: 1, sessions: parsed.sessions }
      }
    } catch {
      // missing or unreadable map: start empty
    }
    return { version: 1, sessions: {} }
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
   * Reserve a slot for the session without starting anything. Idempotent; when
   * the pool is full the least-recently-used session is evicted (its container
   * stop and nginx cleanup run in the background). Every call announces the
   * owning session on `browserLive/allocated` so the provider can hand the slot
   * back when that activation ends — whichever tool path allocated it.
   * @param {string} sessionId - durable session id (`agent.session.id`).
   * @returns {object} the session's map entry.
   */
  allocate(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('browserLive.allocate requires a session id')
    }
    const existing = this.#map.sessions[sessionId]
    if (existing) {
      existing.lastUsed = Date.now()
      this.#writeMap()
      this.#announceAllocation(sessionId, existing)
      return existing
    }
    const used = new Set(Object.values(this.#map.sessions).map((entry) => entry.slot))
    let slot = slotsFor(this.maxSessions).find((candidate) => !used.has(candidate))
    if (slot === undefined) {
      const oldest = Object.entries(this.#map.sessions)
        .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0]
      warn('pool full (' + this.maxSessions + '); evicting least-recently-used session', oldest[1].short)
      this.#evict(oldest[0], oldest[1])
      slot = oldest[1].slot
    }
    const legacy = slot === LEGACY.slot
    let short = legacy ? '' : sessionShort(sessionId)
    for (let attempt = 1; !legacy && Object.values(this.#map.sessions).some((e) => e.short === short); attempt++) {
      short = sessionShort(sessionId, attempt)
    }
    const entry = {
      slot,
      legacy,
      short,
      container: legacy ? LEGACY.container : `neko-${short}`,
      volume: legacy ? LEGACY.volume : `neko-profile-${short}`,
      cdpPort: legacy ? LEGACY.cdpPort : LEGACY.cdpPort + slot,
      webPort: legacy ? LEGACY.webPort : LEGACY.webPort + 2 * slot,
      udpMux: legacy ? 52100 : 52100 + slot,
      tcpMux: legacy ? 52101 : 52101 + slot,
      publicPath: legacy ? LEGACY.publicPath : `/browser/${short}`,
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

  #evict(sessionId, entry) {
    delete this.#map.sessions[sessionId]
    this.#readyCache.delete(sessionId)
    this.#writeMap()
    if (!entry.legacy) {
      void this.#stopContainer(entry.container).catch((error) => warn('evict:', error.message))
      void this.#dropNginxLocation(entry.publicPath)
    }
  }

  /**
   * Explicitly release a session's container (slot 0's legacy container is
   * shared infrastructure and is left running).
   * @param {string} sessionId - durable session id.
   */
  release(sessionId) {
    const entry = this.#map.sessions[sessionId]
    if (!entry) return
    log('releasing session', sessionId, '(' + entry.container + ')')
    this.#evict(sessionId, entry)
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
      if (this.#agentBusy(sessionId)) {
        log('idle sweep: keeping', entry.container, '(agent is running)')
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
    if (entry.legacy) {
      await this.#ensureLegacyNginx()
    } else {
      await this.#ensureNginxLocation(entry.publicPath, entry.webPort)
    }
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
    if (entry.legacy) {
      // Slot 0 keeps the pre-concurrency env file verbatim (path prefix, bind,
      // mux ports, passwords all baked in) so adoption stays byte-compatible.
    } else {
      args.push(
        '-e', `NEKO_WEBRTC_UDPMUX=${entry.udpMux}`,
        '-e', `NEKO_WEBRTC_TCPMUX=${entry.tcpMux}`,
        '-e', `NEKO_SERVER_PATH_PREFIX=${entry.publicPath}`,
        '-e', 'NEKO_SERVER_PROXY=true',
        '-e', `NEKO_SERVER_BIND=127.0.0.1:${entry.webPort}`,
        // X11 abstract sockets live in the network namespace, which host
        // networking shares: the image's baked-in DISPLAY=:99 would collide
        // with the legacy container's X server, so give each slot its own.
        '-e', `DISPLAY=:${900 + entry.slot * 10}.0`,
      )
    }
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
    'backup = path + ".browser-live.bak"',
    'open(backup, "w").write(src)',
    'lines.insert(idxloc, block)',
    "open(path, 'w').write('\\n'.join(lines))",
    "print('patched')",
  ].join('\n')

  // Removes the block added above for one marker (comment line included when
  // directly above). Legacy slot-0 blocks are never removed by the pool; the
  // marker match is exact, so other locations are untouched.
  static NGINX_DROP_PY = [
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
    'backup = path + ".browser-live.bak"',
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
      await run('sudo', ['-n', 'cp', vhost + '.browser-live.bak', vhost], { timeout: 10_000 }).catch(() => undefined)
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

  /** Slot 0 reuses the deployment's original single-container nginx block. */
  async #ensureLegacyNginx() {
    await this.#ensureNginxLocation(LEGACY.publicPath, LEGACY.webPort)
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
      sessions: Object.values(this.#map.sessions).map((entry) => ({
        short: entry.short,
        slot: entry.slot,
        legacy: entry.legacy,
        container: entry.container,
        cdpPort: entry.cdpPort,
        webPort: entry.webPort,
        viewerPath: `${entry.publicPath}/`,
        downloadsDir: downloadsDir(entry.short),
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
          if (!entry.legacy) await this.#ensureNginxLocation(entry.publicPath, entry.webPort)
          else await this.#ensureLegacyNginx()
          continue
        }
        // A container that is up with a dead CDP port is unusable, and once its
        // entry is gone nothing would ever collect it again (the pool only ever
        // touches mapped containers). Recycle it: the profile volume keeps the
        // browser state and the next ensure() rebuilds it from the image.
        log('map entry container', entry.container, 'is running but CDP is down; recycling it (profile volume kept)')
        if (!entry.legacy) {
          await this.#stopContainer(entry.container).catch((error) => warn('adopt recycle:', error.message))
          void this.#dropNginxLocation(entry.publicPath)
        }
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
      if (!entry.legacy) void this.#dropNginxLocation(entry.publicPath)
      delete this.#map.sessions[sessionId]
      this.#writeMap()
    }
  }
}
