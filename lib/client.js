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
 *    turn, plus an invisible conversation.chat.turnTail entry that opens the
 *    tab once for the first turn that touched the browser — the ZCode-IAB
 *    "agent 操作时自动弹出" behavior.
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
  const firedTurns = new Map()
  const inflight = new Map()

  let pluginCtx = null

  /** Cordis identity; must match the bundle patch row id's plugin. */
  const name = 'browser-live'

  /** Services used: slots for tab seats, sidebarRight* for the pane, uiConversation for the trigger. */
  const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'uiConversation']

  /**
   * Mount the live-view tab and the auto-popup trigger.
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
   */
  function resolveViewerPath(sessionId) {
    if (!sessionId || inflight.has(sessionId)) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5_000)
    inflight.set(sessionId, controller)
    fetch(`${ROUTE}?session=${encodeURIComponent(sessionId)}`, { signal: controller.signal })
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
      }))
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
   * Invisible per-turn entry: renders nothing, opens the live tab once for
   * the first turn of this session that used a browser tool. The turn-tail
   * owner carries the definition-built value under turn.data.get(DEF_KIND)
   * (same channel ScheduleTurnCard reads).
   */
  function FocusTrigger(props) {
    const value = props?.turn?.data ? props.turn.data.get(DEF_KIND) : undefined
    const hits = value ? value.hits : 0
    const turn = props?.turn ? props.turn.turn : undefined
    const sessionId = props?.sessionId
    React.useEffect(() => {
      if (!hits || turn === null || turn === undefined || !sessionId || !pluginCtx) return
      const key = sessionId + '#' + turn
      if (firedTurns.has(key)) return
      firedTurns.set(key, Date.now())
      if (firedTurns.size > 100) {
        for (const [stale] of [...firedTurns].sort((a, b) => a[1] - b[1]).slice(0, firedTurns.size - 100)) {
          firedTurns.delete(stale)
        }
      }
      // Point the panel at this session's viewer before opening the tab.
      resolveViewerPath(sessionId)
      // Open after commit so the effect never re-enters the render pass.
      Promise.resolve().then(() => {
        try {
          pluginCtx.sidebarRight.openTab(KIND)
        } catch (error) {
          console.warn('[browser-live] openTab failed:', error)
        }
      })
    }, [hits, turn, sessionId])
    return null
  }

  module.exports = { name, inject, apply }
  return module.exports
} });
