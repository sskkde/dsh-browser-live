/**
 * dsh-browser-live — client half.
 *
 * Hand-written to the same contract the official tsdown client preset emits:
 * a CJS factory closure registered into the frozen module table
 * (window.__ModuleLoader__), `react` resolved from the platform seed table.
 *
 * Contributions (mirroring packages/client/ui-schedule):
 *  - a right-sidebar page tab ("browser-live") whose body is a same-origin
 *    iframe over the Neko viewer (<origin>/browser/),
 *  - a ConversationNodeDefinition that accumulates browser tool calls per
 *    turn, plus an invisible conversation.chat.turnTail entry that opens the
 *    tab once for the first turn that touched the browser — the ZCode-IAB
 *    "agent 操作时自动弹出" behavior.
 */

window.__ModuleLoader__.load({ id: 'dsh-browser-live', factory: (require) => {
  const module = { exports: {} }

  const React = require('react')
  const h = React.createElement

  const TAB_KEY = 'browser-live'
  const KIND = 'browser-live'
  const DEF_KIND = 'browser-live-focus'
  const TAIL_ID = 'browser-live-focus'
  const PUBLIC_PATH = '/browser/'
  const firedTurns = new Map()

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

  function BrowserLiveBody() {
    return h('iframe', {
      src: new URL(PUBLIC_PATH, window.location.origin).href,
      title: 'browser-live',
      style: { width: '100%', height: '100%', border: '0', background: '#101418' },
      allow: 'clipboard-read; clipboard-write',
    })
  }

  function BrowserLiveTitle() {
    return h(React.Fragment, null, '浏览器直播')
  }

  /**
   * Turn-scoped accumulator over browser tool calls. Mirrors
   * ui-schedule's scheduleTurnDefinition: turn/start opens the window, every
   * browser_* tool/call bumps the hit count, buildLocationData publishes a
   * turn location only for turns that actually touched the browser.
   */
  const browserLiveDefinition = {
    kind: DEF_KIND,
    match: (event) => {
      if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
      if (event.type === 'tool/call'
        && typeof event.data?.name === 'string'
        && event.data.name.startsWith('browser_')) {
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
    const turn = value ? value.turn : null
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
