/**
 * dsh-browser-live — session access coordinator.
 *
 * One place decides, for a browser operation, *whose login* the session is
 * allowed to use and applies it before the page's own scripts run. The rules
 * come from the P0 probes (docs/p0-capability-matrix.md):
 *
 *  - cookies belong to a host, and a restore must clear the host's previous jar
 *    first or two accounts end up mixed (G-1);
 *  - localStorage must be seeded before the first page script, and the seeding
 *    must stop as soon as it has happened (the init script cannot be removed, so
 *    a one-shot epoch marker cookie gates it and the script expires it);
 *  - a revoked account must never be restored from an old revision (epoch).
 *
 * A blank browser has no navigated page, so the first restore needs the target
 * URL of the operation that is about to run. The caller passes it in; falling
 * back to "whatever page happens to be open" is only correct for later calls.
 * The coordinator is inert unless a binding exists for that origin.
 */

/** Cookie name carrying the one-shot restore marker. */
export const RESTORE_MARKER_COOKIE = '__dsh_restore_marker'

/** Site policy key: with "every site allowed", the exact origin is the key. */
export function siteKeyForOrigin(url) {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** Normalize a URL or an origin string to an exact origin, or null. */
export function originOf(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const url = new URL(value)
    return url.origin === 'null' ? null : url.origin
  } catch {
    return null
  }
}

/**
 * Static origin → account bindings (the v1 admin table).
 *
 * A binding may also name the sites it owns state for:
 *  - `cookieDomains`: extra cookie domains this account may store (parent-domain
 *    cookies, SSO cookie hosts). Without it only the origin's exact host is
 *    accepted — no implicit "same registrable domain" widening.
 *  - `ssoOrigins`: extra origins whose localStorage belongs to this login.
 * @param {Array<{ origin: string, siteKey?: string, accountKey: string, cookieDomains?: string[], ssoOrigins?: string[] }>} entries - bindings.
 * @returns {{ forOrigin(origin: string): object | null, forAccount(accountKey: string): object | null, list(): object[] }} resolver.
 */
export function createOriginBindings(entries = []) {
  const table = new Map()
  const byAccount = new Map()
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.origin !== 'string' || typeof entry.accountKey !== 'string') continue
    const origin = originOf(entry.origin)
    if (origin === null) continue
    const binding = {
      origin,
      siteKey: typeof entry.siteKey === 'string' && entry.siteKey.length > 0 ? entry.siteKey : origin,
      accountKey: entry.accountKey,
      cookieDomains: normalizeDomains(entry.cookieDomains),
      ssoOrigins: normalizeOrigins(entry.ssoOrigins),
    }
    table.set(origin, binding)
    const list = byAccount.get(binding.accountKey) ?? []
    list.push(binding)
    byAccount.set(binding.accountKey, list)
  }
  return {
    forOrigin(origin) {
      return typeof origin === 'string' ? table.get(origin) ?? null : null
    },
    /** The single binding for an account name, or null when absent/ambiguous. */
    forAccount(accountKey) {
      if (typeof accountKey !== 'string') return null
      const list = byAccount.get(accountKey) ?? []
      return list.length === 1 ? list[0] : null
    },
    list: () => [...table.values()],
  }
}

function normalizeDomains(values) {
  if (!Array.isArray(values)) return []
  const domains = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const domain = value.trim().replace(/^\./, '').toLowerCase()
    if (domain.length === 0 || domain.includes('/') || domain.includes('\\')) continue
    if (!domains.includes(domain)) domains.push(domain)
  }
  return domains
}

function normalizeOrigins(values) {
  if (!Array.isArray(values)) return []
  const origins = []
  for (const value of values) {
    const origin = originOf(value)
    if (origin !== null && !origins.includes(origin)) origins.push(origin)
  }
  return origins
}

/** Seeding function values must survive the CDP boundary, so build it as a string. */
function buildInitScript(payload) {
  return `(() => { try {
    const payload = ${JSON.stringify(payload)};
    if (!payload || !payload.origins) return;
    const origin = window.location.origin;
    const entry = payload.origins[origin];
    const marker = '${RESTORE_MARKER_COOKIE}=' + payload.marker;
    if (String(document.cookie || '').split('; ').indexOf(marker) === -1) return;
    // Keys the previous account/revision seeded at this origin must not survive
    // a switch when the new snapshot does not contain them.
    for (const key of (payload.remove && payload.remove[origin]) || []) {
      window.localStorage.removeItem(key);
    }
    if (!entry) return;
    for (const key of Object.keys(entry)) {
      window.localStorage.setItem(key, entry[key]);
    }
    // One shot: a later navigation (or a logout inside this same operation) must
    // never get the snapshot written back. Delete the host-only form and the
    // domain form, because which one Chrome stored depends on how it was set.
    document.cookie = '${RESTORE_MARKER_COOKIE}=; path=/; max-age=0';
    try { document.cookie = '${RESTORE_MARKER_COOKIE}=; path=/; max-age=0; domain=' + window.location.hostname; } catch (_) {}
    try { document.cookie = '${RESTORE_MARKER_COOKIE}=; path=/; max-age=0; domain=.' + window.location.hostname; } catch (_) {}
  } catch (_) {} })()`
}

/** Cookies of one state that belong to the binding's allowed cookie domains. */
export function filterStateForBinding(state, binding, origin) {
  const host = (() => {
    try {
      return new URL(origin).hostname.toLowerCase()
    } catch {
      return null
    }
  })()
  const hosts = new Set([...(binding?.cookieDomains ?? []), ...(host === null ? [] : [host])])
  const allowedOrigins = new Set([origin, ...(binding?.ssoOrigins ?? [])])
  const cookies = []
  const droppedCookies = []
  for (const cookie of state?.cookies ?? []) {
    const domain = typeof cookie?.domain === 'string' ? cookie.domain.replace(/^\./, '').toLowerCase() : ''
    if (domain !== '' && hosts.has(domain)) cookies.push(cookie)
    else droppedCookies.push(domain || '(host-only)')
  }
  const origins = []
  const droppedOrigins = []
  for (const item of state?.origins ?? []) {
    if (allowedOrigins.has(item?.origin)) origins.push(item)
    else droppedOrigins.push(String(item?.origin ?? '?'))
  }
  return { cookies, origins, droppedCookies, droppedOrigins, allowedOrigins: [...allowedOrigins], cookieDomains: [...hosts] }
}

/**
 * Build a coordinator.
 * `journal` persists the per-session restore records (never cookie values) so
 * a restart does not lose the ability to clear an already-imported login when
 * the account is revoked later.
 * @param {{ scope: object, auth: object, audit?: object, bindings?: object | null, now?: () => number, journal?: { load(): object, save(records: object): void } | null }} options -
 *   `auth` is an AuthStore; `bindings` answers {@link createOriginBindings}'s interface.
 * @returns {object} coordinator.
 */
export function createCoordinator({ scope, auth, audit = null, bindings = null, now = () => Date.now(), journal = null }) {
  if (scope === undefined || typeof scope.scopeFor !== 'function') throw new TypeError('createCoordinator requires a scope resolver')
  if (auth === undefined || typeof auth.current !== 'function') throw new TypeError('createCoordinator requires an AuthStore')
  const restored = new Map()
  if (journal !== null && typeof journal.load === 'function') {
    try {
      const saved = journal.load()
      if (saved !== null && typeof saved === 'object') {
        for (const [sessionId, record] of Object.entries(saved)) {
          if (record !== null && typeof record === 'object' && typeof record.instanceKey === 'string') restored.set(sessionId, record)
        }
      }
    } catch {
      // A corrupt journal only costs the post-restart cleanup; never fail mount.
    }
  }
  const persist = () => {
    if (journal === null || typeof journal.save !== 'function') return
    try {
      journal.save(Object.fromEntries(restored))
    } catch {
      // persistence is best-effort; the in-memory record still works
    }
  }

  /** All domains a restored snapshot touched, so a switch can clear them. */
  const cookieDomains = (state) => {
    const domains = new Set()
    for (const cookie of state?.cookies ?? []) {
      if (typeof cookie?.domain === 'string' && cookie.domain.length > 0) domains.add(cookie.domain.replace(/^\./, ''))
    }
    return domains
  }

  const pageOrigin = (context) => {
    const pages = typeof context?.pages === 'function' ? context.pages() : []
    for (const page of [...pages].reverse()) {
      const url = page?.url?.() ?? 'about:blank'
      const origin = originOf(url)
      if (origin !== null) return origin
    }
    return null
  }

  const targetOriginOf = ({ targetUrl, targetOrigin }) => originOf(targetOrigin) ?? originOf(targetUrl)

  /** Remove the localStorage keys a previous restore seeded (same or other account). */
  const clearSeededKeys = async (context, keysByOrigin) => {
    const pending = []
    for (const [origin, keys] of Object.entries(keysByOrigin ?? {})) {
      if (!Array.isArray(keys) || keys.length === 0) continue
      const page = (context.pages?.() ?? []).find((candidate) => originOf(candidate?.url?.() ?? '') === origin)
      if (page === undefined) {
        pending.push(origin)
        continue
      }
      await page.evaluate((names) => {
        for (const name of names) window.localStorage.removeItem(name)
      }, keys).catch(() => pending.push(origin))
    }
    return pending
  }

  const mergeKeyMaps = (...maps) => {
    const merged = {}
    for (const map of maps) {
      for (const [origin, keys] of Object.entries(map ?? {})) {
        if (!Array.isArray(keys) || keys.length === 0) continue
        merged[origin] = [...new Set([...(merged[origin] ?? []), ...keys])]
      }
    }
    return merged
  }

  /** The localStorage keys one state seeds, per origin. */
  const originsOf = (state) => state?.origins ?? []

  return {
    /**
     * Apply the bound login before an operation runs. Idempotent per browser
     * instance: repeating it for the same container generation does nothing.
     * @param {{ agent: object, sessionId: string, context: object, entry: object, force?: boolean, accountKey?: string | null, targetUrl?: string | null, targetOrigin?: string | null }} input - the caller and its live browser; `targetUrl` is the URL this operation is about to open (required for a blank instance).
     * @returns {Promise<object>} outcome.
     */
    async prepare({ agent, sessionId, context, entry, force = false, accountKey = null, targetUrl = null, targetOrigin = null }) {
      const { scopeId, allowCredentials } = scope.scopeFor(agent)
      if (bindings === null) return { restored: false, reason: 'no-bindings-configured' }
      if (allowCredentials !== true) return { restored: false, reason: 'credentials-withheld' }
      let origin = targetOriginOf({ targetUrl, targetOrigin }) ?? pageOrigin(context)
      const explicit = typeof accountKey === 'string' && accountKey.length > 0
      // An explicit account may name its origin when the browser is still blank,
      // but only through an admin binding: tool arguments are not policy.
      if (origin === null && explicit && typeof bindings.forAccount === 'function') {
        origin = bindings.forAccount(accountKey)?.origin ?? null
      }
      if (origin === null) return { restored: false, reason: 'no-target-origin' }
      const originBinding = bindings.forOrigin(origin)
      let binding
      if (explicit) {
        if (originBinding !== null) {
          if (originBinding.accountKey !== accountKey) {
            return { restored: false, reason: 'account-not-bound', siteKey: originBinding.siteKey, accountKey }
          }
          binding = originBinding
        } else {
          const byAccount = typeof bindings.forAccount === 'function' ? bindings.forAccount(accountKey) : null
          if (byAccount === null || byAccount.origin !== origin) return { restored: false, reason: 'no-binding-for-origin' }
          binding = byAccount
        }
      } else {
        binding = originBinding
        if (binding === null) return { restored: false, reason: 'no-binding-for-origin' }
      }

      const instanceKey = `${entry?.container ?? '?'}:${entry?.generation ?? 0}`
      const previous = restored.get(sessionId)
      const record = await auth.current({ scopeId, siteKey: binding.siteKey, accountKey: binding.accountKey })
      const epoch = await auth.epochOf({ scopeId, siteKey: binding.siteKey, accountKey: binding.accountKey })
      if (record === null) {
        if (previous !== undefined && previous.epoch < epoch) {
          // Revoked (or its head invalidated) after this instance imported it:
          // clear what was imported instead of leaving the old login active.
          for (const domain of previous.domains ?? []) await context.clearCookies({ domain }).catch(() => undefined)
          await context.clearCookies({ name: RESTORE_MARKER_COOKIE }).catch(() => undefined)
          const pending = await clearSeededKeys(context, mergeKeyMaps(previous.localStorageKeys, previous.pendingCleanupKeys))
          if (pending.length > 0) {
            previous.pendingCleanup = pending
            persist()
          } else {
            restored.delete(sessionId)
            persist()
          }
          if (audit) await audit.record({ scopeId, action: 'auth.restore', actorSessionId: sessionId, subject: binding, outcome: 'denied', detail: { reason: 'revoked-active-instance' } })
          return { restored: false, reason: 'revoked', siteKey: binding.siteKey, accountKey: binding.accountKey }
        }
        if (epoch > 0) {
          if (audit) await audit.record({ scopeId, action: 'auth.restore', actorSessionId: sessionId, subject: binding, outcome: 'denied', detail: { reason: 'revoked' } })
          return { restored: false, reason: 'revoked', siteKey: binding.siteKey, accountKey: binding.accountKey }
        }
        return { restored: false, reason: 'no-stored-revision', siteKey: binding.siteKey, accountKey: binding.accountKey }
      }
      if (record.epoch < epoch) {
        if (audit) await audit.record({ scopeId, action: 'auth.restore', actorSessionId: sessionId, subject: binding, outcome: 'denied', detail: { reason: 'revoked' } })
        return { restored: false, reason: 'revoked', siteKey: binding.siteKey, accountKey: binding.accountKey }
      }
      if (force !== true && previous !== undefined && previous.instanceKey === instanceKey) {
        // This instance already imported a revision. A newer head published by
        // another session must NOT silently switch account/state here: the
        // instance keeps what it has until an explicit `load` or a rebuild.
        if (previous.pendingSeed !== true) {
          await context.clearCookies({ name: RESTORE_MARKER_COOKIE }).catch(() => undefined)
        }
        return { restored: false, reason: 'already-restored', revision: previous.revision, epoch: previous.epoch }
      }

      const scoped = filterStateForBinding(record.state, binding, origin)
      // Clear the jar for every domain this account touches — including the
      // domains of the revision this session restored before — so switching
      // accounts cannot leave the previous account's other cookies behind.
      const domains = new Set([...scoped.cookies.map((cookie) => String(cookie.domain ?? '').replace(/^\./, '')).filter(Boolean), ...(previous?.domains ?? [])])
      for (const domain of domains) {
        await context.clearCookies({ domain })
      }
      await context.clearCookies({ name: RESTORE_MARKER_COOKIE }).catch(() => undefined)
      // Switching account or revision: the previous snapshot's seeded keys must
      // not survive a "only fill missing keys" seeding, or old values win.
      const previousKeys = mergeKeyMaps(previous?.localStorageKeys, previous?.pendingCleanupKeys)
      const removalPending = previous === undefined ? [] : await clearSeededKeys(context, previousKeys)
      if (scoped.cookies.length > 0) await context.addCookies(scoped.cookies)

      const origins = {}
      for (const item of scoped.origins) {
        const pairs = {}
        for (const pair of item.localStorage ?? []) pairs[pair.name] = pair.value
        if (Object.keys(pairs).length > 0) origins[item.origin] = pairs
      }
      // Seed pages that are already open at the snapshot origin directly: an
      // init script only runs on a new document, and an operation that does not
      // navigate would otherwise clear its marker without ever seeding.
      const pendingOrigins = []
      for (const [pageOrigin, pairs] of Object.entries(origins)) {
        const open = (context.pages?.() ?? []).find((candidate) => originOf(candidate?.url?.() ?? '') === pageOrigin)
        if (open === undefined) {
          pendingOrigins.push(pageOrigin)
          continue
        }
        await open.evaluate((values) => {
          for (const [key, value] of Object.entries(values)) window.localStorage.setItem(key, value)
        }, pairs).catch(() => {
          pendingOrigins.push(pageOrigin)
        })
      }
      // A marker cookie is host-scoped, so every origin that still needs seeding
      // gets its own marker (including explicitly allowed SSO origins). The value
      // carries the revision as well as the epoch: two revisions can share an
      // epoch, and an older script must not consume the newer marker.
      const marker = `${record.epoch}:${record.revision}`
      // Old-origin keys that could not be removed (no page open) need a marker
      // too; otherwise a later navigation there would never run the removal.
      const markerHosts = new Set([...pendingOrigins, ...removalPending].map((value) => new URL(value).hostname))
      for (const markerHost of markerHosts) {
        await context.addCookies([{ name: RESTORE_MARKER_COOKIE, value: marker, domain: markerHost, path: '/' }])
      }
      // Playwright 1.63 cannot remove an init script. Each restore therefore adds
      // one keyed to the revision it seeds: older scripts are harmless (their
      // marker value no longer exists) and a refresh gets a new one.
      const removeKeys = {}
      for (const [previousOrigin, keys] of Object.entries(previousKeys)) {
        if (Array.isArray(keys) && keys.length > 0) removeKeys[previousOrigin] = keys
      }
      const pendingCleanupKeys = {}
      for (const pendingOrigin of removalPending) {
        const keys = previousKeys[pendingOrigin]
        if (Array.isArray(keys) && keys.length > 0) pendingCleanupKeys[pendingOrigin] = keys
      }
      if ((Object.keys(origins).length > 0 || Object.keys(removeKeys).length > 0) && typeof context.addInitScript === 'function') {
        await context.addInitScript({ content: buildInitScript({ marker, origins, remove: removeKeys }) })
      }
      restored.set(sessionId, {
        instanceKey,
        revision: record.revision,
        epoch,
        domains: [...domains],
        origin,
        siteKey: binding.siteKey,
        accountKey: binding.accountKey,
        localStorageOrigins: Object.keys(origins),
        localStorageKeys: Object.fromEntries(Object.entries(origins).map(([key, value]) => [key, Object.keys(value)])),
        pendingCleanupKeys,
        pendingSeed: pendingOrigins.length > 0 || removalPending.length > 0,
      })
      persist()
      if (audit) {
        await audit.record({
          scopeId,
          action: 'auth.restore',
          actorSessionId: sessionId,
          subject: { origin, siteKey: binding.siteKey, accountKey: binding.accountKey },
          detail: { revision: record.revision, epoch, domains: domains.size, droppedCookies: scoped.droppedCookies.length, droppedOrigins: scoped.droppedOrigins.length },
        })
      }
      return {
        restored: true,
        siteKey: binding.siteKey,
        accountKey: binding.accountKey,
        revision: record.revision,
        epoch,
        skippedOrigins: scoped.droppedOrigins,
      }
    },

    /**
     * Close a restore: the marker cookie goes away, so the init script stops
     * seeding localStorage on later navigations.
     * @param {{ context: object, sessionId?: string }} input - the context used by the operation.
     * @returns {Promise<void>} resolves once the marker is cleared.
     */
    async finish({ context, sessionId }) {
      const record = typeof sessionId === 'string' ? restored.get(sessionId) : undefined
      // A marker that has not been consumed by a navigation is kept: the next
      // navigation still has to seed that origin. Once every origin was seeded
      // (or the init script consumed its marker), clearing is a no-op.
      if (record?.pendingSeed === true) return
      try {
        await context.clearCookies({ name: RESTORE_MARKER_COOKIE })
      } catch {
        // a context torn down mid-operation has nothing to clear
      }
      if (record !== undefined) {
        record.pendingSeed = false
        persist()
      }
    },

    /**
     * Whether this session's browser may need a restore at all. Cheap: no I/O,
     * no attach. Used to skip the CDP round-trip on every MCP tool call.
     * @param {{ sessionId: string, entry: object }} input - session and its map entry.
     * @returns {boolean} true when the instance is unknown or changed.
     */
    needsPrepare({ sessionId, entry }) {
      const previous = restored.get(sessionId)
      if (previous === undefined) return true
      return previous.instanceKey !== `${entry?.container ?? '?'}:${entry?.generation ?? 0}`
    },

    /**
     * Restore for a session the caller cannot hand a context for (the MCP
     * path): attach to the container over CDP, restore, detach. The MCP server
     * is a separate CDP client, so the attach is additive, never disruptive.
     * @param {{ agent: object, sessionId: string, entry: object, attach: (endpoint: string) => Promise<object>, targetUrl?: string | null, targetOrigin?: string | null, force?: boolean }} input
     * @returns {Promise<object>} the prepare outcome, or `{ restored: false, reason }`.
     */
    async prepareForBrowser({ agent, sessionId, entry, attach, targetUrl = null, targetOrigin = null, force = false }) {
      const browser = await attach(`http://127.0.0.1:${entry.cdpPort}`)
      try {
        const context = browser.contexts()[0]
        if (!context) return { restored: false, reason: 'no-context' }
        return await this.prepare({ agent, sessionId, context, entry, targetUrl, targetOrigin, force })
      } finally {
        await browser.close().catch(() => undefined)
      }
    },

    /**
     * Undo a shared restore in a live browser after the account was revoked:
     * clear the cookies, the localStorage keys this coordinator seeded, and the
     * marker, then forget the record. Used by `browser_live_state forget`; the
     * caller supplies the attach function and the live entry.
     * @param {{ sessionId: string, entry: object, attach: (endpoint: string) => Promise<object> }} input
     * @returns {Promise<{ cleared: boolean, reason?: string }>} outcome.
     */
    async clearRestored({ sessionId, entry, attach }) {
      const previous = restored.get(sessionId)
      if (previous === undefined) return { cleared: false, reason: 'not-restored' }
      // No map entry means the container (and its profile-backed browser) is
      // gone; there is no live instance left to clear. A `deleting` entry is
      // NOT the same thing: reclaim may have failed and the container may still
      // be running, so keep the record for a later retry.
      if (entry === null || entry === undefined) {
        restored.delete(sessionId)
        persist()
        return { cleared: false, reason: 'browser-not-live' }
      }
      if (entry.state === 'deleting') {
        return { cleared: false, reason: 'browser-reclaiming' }
      }
      const browser = await attach(`http://127.0.0.1:${entry.cdpPort}`)
      try {
        const context = browser.contexts()[0]
        if (!context) return { cleared: false, reason: 'no-context' }
        for (const domain of previous.domains ?? []) await context.clearCookies({ domain }).catch(() => undefined)
        await context.clearCookies({ name: RESTORE_MARKER_COOKIE }).catch(() => undefined)
        const pendingOrigins = []
        const allKeys = mergeKeyMaps(previous.localStorageKeys, previous.pendingCleanupKeys)
        for (const origin of Object.keys(allKeys)) {
          const page = (context.pages?.() ?? []).find((candidate) => originOf(candidate?.url?.() ?? '') === origin)
          if (page === undefined) {
            pendingOrigins.push(origin)
            continue
          }
          await page.evaluate((names) => {
            for (const name of names) window.localStorage.removeItem(name)
          }, allKeys[origin]).catch(() => pendingOrigins.push(origin))
        }
        if (pendingOrigins.length > 0) {
          // Cookies are gone, but the origin's localStorage cannot be cleared
          // without a page there. Keep the journal so a later call can finish,
          // and report the truth instead of a false success.
          previous.pendingCleanup = pendingOrigins
          previous.pendingCleanupKeys = Object.fromEntries(pendingOrigins.map((origin) => [origin, allKeys[origin]]))
          persist()
          return { cleared: false, reason: 'localstorage-origin-not-open', pendingOrigins, cookiesCleared: true }
        }
        restored.delete(sessionId)
        persist()
        return { cleared: true }
      } finally {
        await browser.close().catch(() => undefined)
      }
    },

    /** What this coordinator currently believes per session (diagnostics). */
    status() {
      return {
        sessions: [...restored].map(([sessionId, value]) => ({ sessionId, ...value, domains: value.domains.length, now: now() })),
      }
    },

    /** The restore record for one session, if any. */
    restoredFor(sessionId) {
      return restored.get(sessionId) ?? null
    },

    /** Drop the record of one session without touching its browser. */
    forgetSession(sessionId) {
      restored.delete(sessionId)
      persist()
    },
  }
}
