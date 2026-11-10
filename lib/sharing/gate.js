/**
 * dsh-browser-live — sharing gate.
 *
 * One `tools/execute` listener in front of every browser tool call. It resolves
 * the caller's scope from the live agent (never from arguments), classifies the
 * call across all three paths (native tools, direct MCP tools, and
 * `browser_gateway_call` wrapping an inner tool), and refuses anything outside
 * the grant before the provider or the tool body runs.
 *
 * The gate is inert until sharing is enabled: with `enabled: false` the scope
 * resolver rejects everyone, so a mis-wired activation fails closed rather than
 * silently sharing.
 */

import { authorizeCall, classifyToolCall } from './policy.js'
import { ScopeDeniedError } from './scope.js'

/**
 * Build the `tools/execute` listener.
 * @param {{ resolver: { scopeFor(agent: object | undefined): { scopeId: string, allowCredentials: boolean }, isMember(sessionId: string): boolean } }} options - scope resolver.
 * @returns {(exec: { name: string, arguments: unknown, agent?: object }, next: () => Promise<unknown>) => Promise<unknown>} the listener.
 */
export function createSharingGate({ resolver }) {
  if (resolver === undefined || typeof resolver.scopeFor !== 'function') {
    throw new TypeError('createSharingGate requires a scope resolver')
  }
  return async function sharingGate(exec, next) {
    const call = classifyToolCall(exec?.name, exec?.arguments)
    if (call.kind === 'other') return next()
    let grant
    try {
      grant = resolver.scopeFor(exec?.agent)
    } catch (error) {
      if (error instanceof ScopeDeniedError) throw error
      throw new ScopeDeniedError(error instanceof Error ? error.message : String(error))
    }
    authorizeCall(call, grant)
    return next()
  }
}

/**
 * Register the gate on a plugin context.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ resolver: object }} options - same options as {@link createSharingGate}.
 * @returns {() => void} dispose function.
 */
export function installSharingGate(ctx, options) {
  return ctx.on('tools/execute', createSharingGate(options), { prepend: true })
}
