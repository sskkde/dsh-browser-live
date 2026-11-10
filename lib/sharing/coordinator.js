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
 *    must stop on the next navigation (the init script cannot be removed, so a
 *    one-shot epoch marker cookie gates it);
 *  - a revoked account must never be restored from an old revision (epoch).
 *
 * The coordinator is inert unless a binding exists for the page's origin.
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

/**
 * Static origin → account bindings (the v1 admin table).
 * @param {Array<{ origin: string, siteKey?: string, accountKey: string }>} entries - bindings.
 * @returns {{ forOrigin(origin: string): { siteKey: string, accountKey: string } | null }} resolver.
 */
export function createOriginBindings(entries = []) {
  const table = new Map()
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.origin !== 'string' || typeof entry.accountKey !== 'string') continue
    table.set(entry.origin, { siteKey: entry.siteKey ?? entry.origin, accountKey: entry.accountKey })
  }
  return {
    forOrigin(origin) {
      return typeof origin === 'string' ? table.get(origin) ?? null : null
    },
  }
}

/** Seeding function values must survive the CDP boundary, so build it as a string. */
function buildInitScript(payload) {
  return `(() => { try {
    const payload = ${JSON.stringify(payload)};
    if (!payload || !payload.origins) return;
    const entry = payload.origins[window.location.origin];
    if (!entry) return;
    const marker = '${RESTORE_MARKER_COOKIE}=' + payload.epoch;
    if (String(document.cookie || '').split('; ').indexOf(marker) === -1) return;
    for (const key of Object.keys(entry)) {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, entry[key]);
    }
  } catch (_) {} })()`
}

/**
 * Build a coordinator.
 * @param {{ scope: object, auth: object, audit?: object, bindings?: object | null, now?: () => number }} options -
 *   `auth` is an AuthStore; `bindings` answers {@link createOriginBindings}'s interface.
 * @returns {{ prepare(input: object): Promise<object>, finish(input: object): Promise<void>, status(): object, restoredFor(sessionId: string): object | null }} coordinator.
 */
export function createCoordinator({ scope, auth, audit = null, bindings = null, now = () => Date.now() }) {
  if (scope === undefined || typeof scope.scopeFor !== 'function') throw new TypeError('createCoordinator requires a scope resolver')
  if (auth === undefined || typeof auth.current !== 'function') throw new TypeError('createCoordinator requires an AuthStore')
  const restored = new Map()
  const instrumented = new WeakSet()

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
      if (url.startsWith('http://') || url.startsWith('https://')) return new URL(url).origin
    }
    return null
  }

  return {
    /**
     * Apply the bound login before an operation runs. Idempotent per browser
     * instance: repeating it for the same container generation does nothing.
     * @param {{ agent: object, sessionId: string, context: object, entry: object }} input - the caller and its live browser.
     * @returns {Promise<{ restored: boolean, reason?: string, siteKey?: string, accountKey?: string, revision?: string, epoch?: number }>} outcome.
     */
    async prepare({ agent, sessionId, context, entry }) {
      const { scopeId, allowCredentials } = scope.scopeFor(agent)
      if (bindings === null) return { restored: false, reason: 'no-bindings-configured' }
      if (allowCredentials !== true) return { restored: false, reason: 'credentials-withheld' }
      const origin = pageOrigin(context)
      if (origin === null) return { restored: false, reason: 'no-navigated-page' }
      const binding = bindings.forOrigin(origin)
      if (binding === null) return { restored: false, reason: 'no-binding-for-origin' }

      const instanceKey = `${entry?.container ?? '?'}:${entry?.generation ?? 0}`
      const previous = restored.get(sessionId)
      const record = await auth.current({ scopeId, siteKey: binding.siteKey, accountKey: binding.accountKey })
      if (record === null) return { restored: false, reason: 'no-stored-revision', siteKey: binding.siteKey, accountKey: binding.accountKey }
      const epoch = await auth.epochOf({ scopeId, siteKey: binding.siteKey, accountKey: binding.accountKey })
      if (record.epoch < epoch) {
        if (audit) await audit.record({ scopeId, action: 'auth.restore', actorSessionId: sessionId, subject: binding, outcome: 'denied', detail: { reason: 'revoked' } })
        return { restored: false, reason: 'revoked', siteKey: binding.siteKey, accountKey: binding.accountKey }
      }
      if (previous !== undefined && previous.instanceKey === instanceKey && previous.revision === record.revision) {
        // A later call on the same instance: the first navigation has happened,
        // so retire the one-shot marker and stop seeding localStorage.
        await context.clearCookies({ name: RESTORE_MARKER_COOKIE }).catch(() => undefined)
        return { restored: false, reason: 'already-restored', revision: record.revision, epoch }
      }

      // Clear the jar for every domain this account touches — including the
      // domains of the revision this session restored before — so switching
      // accounts cannot leave the previous account's other cookies behind.
      const domains = new Set([...cookieDomains(record.state), ...(previous?.domains ?? [])])
      for (const domain of domains) {
        await context.clearCookies({ domain })
      }
      if (record.state?.cookies?.length > 0) await context.addCookies(record.state.cookies)

      const host = new URL(origin).hostname
      await context.addCookies([{ name: RESTORE_MARKER_COOKIE, value: String(record.epoch), domain: host, path: '/' }])
      const origins = {}
      for (const item of record.state?.origins ?? []) {
        const pairs = {}
        for (const pair of item.localStorage ?? []) pairs[pair.name] = pair.value
        if (Object.keys(pairs).length > 0) origins[item.origin] = pairs
      }
      if (Object.keys(origins).length > 0 && typeof context.addInitScript === 'function' && !instrumented.has(context)) {
        await context.addInitScript({ content: buildInitScript({ epoch: record.epoch, origins }) })
        instrumented.add(context)
      }
      restored.set(sessionId, { instanceKey, revision: record.revision, epoch, domains: [...domains], origin })
      if (audit) {
        await audit.record({
          scopeId,
          action: 'auth.restore',
          actorSessionId: sessionId,
          subject: { origin, siteKey: binding.siteKey, accountKey: binding.accountKey },
          detail: { revision: record.revision, epoch, domains: domains.size },
        })
      }
      return { restored: true, siteKey: binding.siteKey, accountKey: binding.accountKey, revision: record.revision, epoch }
    },

    /**
     * Close a restore: the marker cookie goes away, so the init script stops
     * seeding localStorage on later navigations.
     * @param {{ context: object }} input - the context used by the operation.
     * @returns {Promise<void>} resolves once the marker is cleared.
     */
    async finish({ context }) {
      try {
        await context.clearCookies({ name: RESTORE_MARKER_COOKIE })
      } catch {
        // a context torn down mid-operation has nothing to clear
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
     * @param {{ agent: object, sessionId: string, entry: object, attach: (endpoint: string) => Promise<object> }} input - attach is `chromium.connectOverCDP`.
     * @returns {Promise<object>} the prepare outcome, or `{ restored: false, reason }`.
     */
    async prepareForBrowser({ agent, sessionId, entry, attach }) {
      const browser = await attach(`http://127.0.0.1:${entry.cdpPort}`)
      try {
        const context = browser.contexts()[0]
        if (!context) return { restored: false, reason: 'no-context' }
        return await this.prepare({ agent, sessionId, context, entry })
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
  }
}
