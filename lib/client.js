/**
 * dsh-browser-live — client half.
 *
 * Hand-written to the same contract the official tsdown client preset emits:
 * a CJS factory closure registered into the frozen module table
 * (window.__ModuleLoader__), `react` resolved from the platform seed table.
 *
 * Contributions (mirroring packages/client/ui-schedule):
 *  - a right-sidebar page tab ("browser-live") whose body is a same-origin
 *    iframe over the session's Neko viewer (resolved per session via the
 *    /browser-live/session host route, legacy /browser/ as fallback),
 *  - a ConversationNodeDefinition that accumulates browser tool calls per
 *    turn, an invisible session-header watcher that opens the tab the moment
 *    the running turn's first browser tool call is appended (the ZCode-IAB
 *    "agent 操作时自动弹出" behavior), and an invisible
 *    conversation.chat.turnTail entry kept as the replay/reload fallback —
 *    a turn-tail footer only exists for completed turns, so it cannot carry
 *    the live trigger.
 *
 * Tool-name matching (issue 1 fix): provider tools are MCP-namespaced
 * (`mcp__playwright-mcp__browser_*`), and this plugin's own host tools are
 * `browser_live_*`; the matcher accepts all of them instead of only the plain
 * `browser_*` prefix the retired local provider happened to use.
 */

window.__ModuleLoader__.load({ id: 'dsh-browser-live', factory: (require) => {
  const module = { exports: {} }

  const React = require('react')
  const h = React.createElement

  const TAB_KEY = 'dsh-browser-live'
  const KIND = 'browser-live'
  const DEF_KIND = 'browser-live-focus'
  const TAIL_ID = 'browser-live-focus'
  const PUBLIC_PATH = '/browser/'
  const ROUTE = '/browser-live/session'
  /** Display name the embedded viewer logs in with; empty disables auto-login. */
  const VIEWER_NAME = 'DSH'
  const firedTurns = new Map()
  const inflight = new Map()

  let pluginCtx = null

  /** Cordis identity; must match the bundle patch row id's plugin. */
  const name = 'browser-live'

  /**
   * Services used: slots for tab seats, sidebarRight* for the pane,
   * uiConversation for the trigger, sessions for the live event feed.
   */
  const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'uiConversation', 'sessions']

  /**
   * Mount the live-view tab and both auto-popup triggers.
   * @param {object} ctx - client root context with the injected services.
   */
  function apply(ctx) {
    pluginCtx = ctx

    ctx.effect(() => ctx.sidebarRightTabs.register({
      id: 'dsh-browser-live',
      kind: KIND,
      title: () => '浏览器直播',
    }), 'browser-live: tab type')

    ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_KEY,
    }, BrowserLiveBody))

    ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: TAB_KEY,
    }, BrowserLiveTitle))

    ctx.uiConversation.events.register(browserLiveDefinition)

    // Live trigger: the session header is resident for the on-screen session,
    // so a browser tool call opens the panel while the turn is still running.
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: TAIL_ID + '-live',
      order: 100,
      inject: (sessionId) => ({ sessionId }),
    }, LiveFocusTrigger))

    // Replay fallback: a reload rebuilds completed-turn footers, and this
    // keeps the panel opening for the last turn that touched the browser.
    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
      name: 'conversation.chat.turnTail',
      id: TAIL_ID,
      order: 40,
      inject: (sessionId) => ({ sessionId }),
    }, FocusTrigger))
  }

  // ------------------------------------------------------------- viewer path

  /** Active viewer state; every subscribed component re-renders on change. */
  const viewerState = { sessionId: null, path: PUBLIC_PATH, ready: false }
  const viewerListeners = new Set()

  function readViewer() {
    return viewerState
  }

  function setViewer(next) {
    Object.assign(viewerState, next)
    for (const listener of [...viewerListeners]) {
      try {
        listener(readViewer())
      } catch (error) {
        console.warn('[browser-live] viewer listener failed:', error)
      }
    }
  }

  /**
   * Resolve one session's viewer path from the host route and publish it.
   * Falls back to the legacy shared viewer when the route is unavailable.
   * @param {string} sessionId - session whose viewer path should be resolved.
   * @returns {Promise<void>} settles after the viewer state has been published
   *   (or the request timed out); callers may open the panel in its `then`.
   */
  function resolveViewerPath(sessionId) {
    if (!sessionId) return Promise.resolve()
    const pending = inflight.get(sessionId)
    if (pending !== undefined) return pending
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5_000)
    const task = fetch(`${ROUTE}?session=${encodeURIComponent(sessionId)}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (body && typeof body.viewerPath === 'string' && body.viewerPath.length > 0) {
          setViewer({ sessionId, path: body.viewerPath, ready: body.ready === true })
        } else if (viewerState.sessionId !== sessionId) {
          setViewer({ sessionId, path: PUBLIC_PATH, ready: false })
        }
      })
      .catch(() => {
        if (viewerState.sessionId !== sessionId) setViewer({ sessionId, path: PUBLIC_PATH, ready: false })
      })
      .finally(() => {
        clearTimeout(timer)
        inflight.delete(sessionId)
      })
    inflight.set(sessionId, task)
    return task
  }

  function BrowserLiveBody() {
    const [viewer, setLocalViewer] = React.useState(readViewer)
    React.useEffect(() => {
      const listener = (next) => setLocalViewer({ ...next })
      viewerListeners.add(listener)
      return () => viewerListeners.delete(listener)
    }, [])
    // While the session's container is starting, re-check readiness until the
    // host reports the CDP endpoint up (banner disappears on the first pass).
    React.useEffect(() => {
      if (viewer.ready || viewer.sessionId === null) return undefined
      const timer = setInterval(() => resolveViewerPath(viewer.sessionId), 5_000)
      return () => clearInterval(timer)
    }, [viewer.ready, viewer.sessionId])
    return h(React.Fragment, null,
      !viewer.ready && viewer.sessionId !== null
        ? h('div', { style: styles.banner }, '浏览器会话启动中…(首次启动约需十几秒)')
        : null,
      h('iframe', {
        key: viewer.path,
        src: new URL(viewer.path, window.location.origin).href,
        title: 'browser-live',
        style: { width: '100%', height: '100%', border: '0', background: '#101418' },
        allow: 'clipboard-read; clipboard-write',
        onLoad: (event) => autoLoginViewer(event && event.currentTarget ? event.currentTarget : null),
      }))
  }

  /**
   * Skip the Neko login gate inside the viewer frame.
   *
   * Neko's frontend has no URL or token login: even with the server's noauth
   * member provider the page boots into a "Please Log In" form (display name +
   * password), and every panel open reloads that page. The panel iframe is
   * same-origin (DSH proxies the viewer under its own host), so the parent may
   * drive the app's own Vuex action with a fixed display name — no typing, no
   * click, and no focus change. A DOM submit fallback covers frontend builds
   * without the accessor, and an unreachable/foreign document is left alone.
   * @param {HTMLIFrameElement | null} frame - the live-view iframe element.
   */
  function autoLoginViewer(frame) {
    if (!frame || VIEWER_NAME === '') return
    let attempts = 0
    const tick = () => {
      let doc
      try {
        doc = frame.contentDocument
      } catch {
        return // cross-origin viewer: the panel must not touch it
      }
      if (!doc) return
      const root = doc.getElementById('neko')
      const vue = root ? root.__vue__ : undefined
      const state = vue && vue.$store ? vue.$store.state : undefined
      if (state && state.connected === true) return
      let form = doc.querySelector('form.message')
      if (!form) {
        form = [...doc.querySelectorAll('form')].find((candidate) => candidate.querySelector('input[type="password"]')) || null
      }
      if (!form) {
        if (attempts++ < 40) setTimeout(tick, 250)
        return
      }
      const name = form.querySelector('input[type="text"]')
      if (!name) {
        if (attempts++ < 40) setTimeout(tick, 250)
        return
      }
      const giveKeyboardBack = () => {
        // Neko autofocuses the display-name field, which pulls keyboard focus
        // into the frame; hand it back once the login form is gone.
        try {
          if (doc.hasFocus()) frame.blur()
        } catch {}
      }
      if (vue && vue.$accessor && typeof vue.$accessor.login === 'function') {
        // Hide the form while the login settles so the panel never flashes
        // "Please Log In"; a rejected login (password-protected server) puts
        // it back for the user to type into.
        try {
          form.style.visibility = 'hidden'
        } catch {}
        const restore = () => {
          try {
            form.style.visibility = ''
          } catch {}
        }
        try {
          Promise.resolve(vue.$accessor.login({ displayname: VIEWER_NAME, password: '' }))
            .then(giveKeyboardBack, restore)
          return
        } catch {
          restore()
        }
      }
      try {
        name.value = VIEWER_NAME
        name.dispatchEvent(new (frame.contentWindow.Event)('input', { bubbles: true }))
        const submit = form.querySelector('button[type="submit"]')
        if (submit) submit.click()
        giveKeyboardBack()
      } catch {}
    }
    setTimeout(tick, 200)
  }

  const styles = {
    banner: {
      padding: '4px 12px',
      fontSize: '12px',
      color: '#eab308',
      background: 'rgba(234, 179, 8, 0.08)',
      borderBottom: '1px solid rgba(234, 179, 8, 0.25)',
    },
  }

  function BrowserLiveTitle() {
    return h(React.Fragment, null, '浏览器直播')
  }

  /**
   * A tool call is browser work when it is one of this plugin's browser_live_*
   * tools, the retired local provider's plain browser_* tools, or any
   * MCP-namespaced provider tool of the form mcp__<server>__browser_*.
   */
  function isBrowserToolName(name) {
    if (name.startsWith('browser_')) return true
    return /^mcp__[A-Za-z0-9_-]+__browser_/.test(name)
  }

  /**
   * Turn-scoped accumulator over browser tool calls. Mirrors
   * ui-schedule's scheduleTurnDefinition: turn/start opens the window, every
   * browser tool/call bumps the hit count, buildLocationData publishes a
   * turn location only for turns that actually touched the browser.
   */
  const browserLiveDefinition = {
    kind: DEF_KIND,
    match: (event) => {
      if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
      if (event.type === 'tool/call'
        && typeof event.data?.name === 'string'
        && isBrowserToolName(event.data.name)) {
        return { id: String(event.data.turn), role: 'update' }
      }
      return null
    },
    start: (_context, match) => ({ turn: match.event.data.turn, hits: 0 }),
    update: (context, match) => (
      match.event.type === 'tool/call'
        ? { ...context.state, hits: context.state.hits + 1 }
        : context.state
    ),
    buildLocationData: (context, scope, previous) => {
      if (scope !== 'turn' || context.state === undefined || context.state.hits === 0) return null
      if (previous?.kind === 'turn'
        && previous.turn === context.state.turn
        && previous.key === DEF_KIND
        && previous.value.hits === context.state.hits) return previous
      return { kind: 'turn', turn: context.state.turn, key: DEF_KIND, value: { hits: context.state.hits } }
    },
  }

  /**
   * Open the live tab once per session turn that touched the browser.
   *
   * The viewer path is resolved first so the panel's iframe starts on this
   * session's viewer instead of flashing the legacy `/browser/` fallback; a
   * failed or slow resolution still opens the tab.
   * @param {string} sessionId - session whose panel should open.
   * @param {number} turn - turn that made the browser call (dedupe identity).
   */
  function openLivePanel(sessionId, turn) {
    if (!sessionId || turn === null || turn === undefined || !pluginCtx) return
    const key = sessionId + '#' + turn
    if (firedTurns.has(key)) return
    firedTurns.set(key, Date.now())
    if (firedTurns.size > 100) {
      for (const [stale] of [...firedTurns].sort((a, b) => a[1] - b[1]).slice(0, firedTurns.size - 100)) {
        firedTurns.delete(stale)
      }
    }
    // Settle the viewer first, then open outside the running effect pass.
    Promise.resolve()
      .then(() => resolveViewerPath(sessionId))
      .catch(() => undefined)
      .then(() => {
        try {
          pluginCtx.sidebarRight.openTab(KIND)
        } catch (error) {
          console.warn('[browser-live] openTab failed:', error)
        }
      })
  }

  /**
   * Replay fallback: the completed-turn footer carries the definition-built
   * value under turn.data.get(DEF_KIND) (same channel ScheduleTurnCard reads).
   * It only mounts after turn/end, so the live opener above is the normal path.
   */
  function FocusTrigger(props) {
    const value = props?.turn?.data ? props.turn.data.get(DEF_KIND) : undefined
    const hits = value ? value.hits : 0
    const turn = props?.turn ? props.turn.turn : undefined
    const sessionId = props?.sessionId
    React.useEffect(() => {
      if (!hits || turn === null || turn === undefined || !sessionId) return
      openLivePanel(sessionId, turn)
    }, [hits, turn, sessionId])
    return null
  }

  /**
   * Live trigger: renders nothing, subscribes to the on-screen session's event
   * feed and opens the panel as soon as a running turn appends its first
   * browser tool call. A `tool/call` event is appended before the tool runs,
   * so the panel appears while the agent is still driving the browser.
   *
   * The subscription only follows the live tail: history replayed by a reload
   * is the turnTail fallback's job, so a page refresh does not double-fire.
   * Mounting mid-turn (the user switches to the running session) still scans
   * the loaded window for a browser call in a still-open turn.
   */
  function LiveFocusTrigger(props) {
    const sessionId = props?.sessionId
    React.useEffect(() => {
      if (!sessionId || !pluginCtx) return undefined
      const sessions = pluginCtx.sessions
      let binding
      try {
        binding = sessions && typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined
      } catch (error) {
        console.warn('[browser-live] session binding lookup failed:', error)
        return undefined
      }
      const source = binding ? binding.eventSource : undefined
      if (!source || typeof source.subscribe !== 'function') return undefined

      const inspect = (entries) => {
        for (const entry of entries ?? []) {
          const event = entry ? entry.event : undefined
          if (!event || event.type !== 'tool/call') continue
          const toolName = event.data ? event.data.name : undefined
          if (typeof toolName === 'string' && isBrowserToolName(toolName)) {
            openLivePanel(sessionId, event.data.turn)
          }
        }
      }

      const scanOpenTurn = () => {
        const window = source.getSnapshot()
        const entries = window && window.entries ? window.entries : []
        let latestTurn
        const closed = new Set()
        for (const entry of entries) {
          const event = entry ? entry.event : undefined
          if (!event) continue
          if (event.type === 'turn/end') closed.add(event.data.turn)
          else if (event.type === 'tool/call'
            && typeof event.data?.name === 'string'
            && isBrowserToolName(event.data.name)) latestTurn = event.data.turn
        }
        if (latestTurn !== undefined && !closed.has(latestTurn)) openLivePanel(sessionId, latestTurn)
      }

      const stop = source.subscribe(() => {
        const window = source.getSnapshot()
        const change = window ? window.change : undefined
        if (!change) return
        if (change.kind === 'append') inspect(change.entries)
        else if (change.kind === 'replace') scanOpenTurn()
      })
      scanOpenTurn()
      return stop
    }, [sessionId])
    return null
  }

  module.exports = { name, inject, apply }
  return module.exports
} });
