/**
 * dsh-browser-live — trusted-scope resolver.
 *
 * The scope is the unit every sharing decision is made in. It is resolved from
 * the *host's* view of the caller (a live agent with a session id), never from
 * tool arguments: a model cannot name its own scope any more than it can name
 * its own identity.
 *
 * This deployment has no per-user identity (see docs/p0-capability-matrix.md
 * C15), so the only honest mode is a single administrator-listed group. That
 * includes subagents: they are ordinary live agents with their own session id,
 * and they are members because the operator said so — not because they share a
 * working directory with a member.
 */

/** The single scope this deployment defines. */
export const DEFAULT_SCOPE_ID = 'trusted-group'

/** Refusal raised when a caller cannot be resolved to an allowed scope. */
export class ScopeDeniedError extends Error {
  /**
   * @param {string} detail - why the caller has no scope, never echoing caller arguments.
   */
  constructor(detail) {
    super(`sharing scope denied: ${detail}`)
    this.name = 'ScopeDeniedError'
    this.code = 'SHARING_SCOPE_DENIED'
  }
}

/**
 * Build a scope resolver.
 *
 * @param {{ enabled?: boolean, scopeId?: string, allowCredentials?: boolean, members?: string[] | null }} [options] -
 *   `members: null` means every live agent (the operator's "all sessions and
 *   subagents" decision); an explicit list can narrow it later without changing
 *   the call sites.
 * @returns {{ scopeFor(agent: object | undefined): { scopeId: string, member: true, allowCredentials: boolean }, isMember(sessionId: string): boolean, describe(): object }} resolver.
 */
export function createScopeResolver(options = {}) {
  const enabled = options.enabled === true
  const scopeId = typeof options.scopeId === 'string' && options.scopeId.length > 0 ? options.scopeId : DEFAULT_SCOPE_ID
  const allowCredentials = options.allowCredentials !== false
  const explicit = Array.isArray(options.members) && options.members.length > 0 ? new Set(options.members.map(String)) : null

  const sessionIdOf = (agent) => {
    const id = agent?.session?.id
    return typeof id === 'string' && id.length > 0 ? id : null
  }

  const isMember = (sessionId) => {
    if (!enabled) return false
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    return explicit === null || explicit.has(sessionId)
  }

  const scopeFor = (agent) => {
    const sessionId = sessionIdOf(agent)
    if (!isMember(sessionId)) {
      throw new ScopeDeniedError(sessionId === null
        ? 'the caller is not a live session'
        : `session ${sessionId} is not in the trusted group`)
    }
    return { scopeId, member: true, allowCredentials }
  }

  return {
    scopeFor,
    isMember,
    describe: () => ({
      enabled,
      scopeId,
      allowCredentials,
      members: explicit === null ? 'all-sessions' : [...explicit],
    }),
  }
}
