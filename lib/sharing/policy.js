/**
 * dsh-browser-live — sharing policy: one classification for every browser tool
 * call, whichever path it came through.
 *
 * The three paths a model can reach the session browser through are:
 *
 *  - native    `browser_live_*` host tools (lib/tools.js);
 *  - direct    `mcp__playwright-mcp__browser_*` tools published per session;
 *  - indirect  `mcp__playwright-mcp__browser_gateway_call`, whose *inner* tool
 *              name lives in `arguments.tool` and must be classified too, or a
 *              caller could reach credential tools by wrapping them.
 *
 * A call is described as a plain object so the policy is testable without a
 * harness, a browser or a scope store.
 */

/** Prefix of the per-session Playwright MCP tools. */
export const MCP_TOOL_PREFIX = 'mcp__playwright-mcp__'

/** Gateway meta tools; `browser_gateway_call` must not be able to nest one. */
export const GATEWAY_META_TOOLS = Object.freeze(['browser_gateway_call', 'browser_gateway_enable', 'browser_gateway_groups'])

/**
 * Tools that read or write credentials (cookies, storage, storage state).
 * Sharing policy treats these as privileged even inside an allowed scope.
 */
export const CREDENTIAL_TOOL_NAMES = new Set([
  'browser_cookie_list',
  'browser_cookie_get',
  'browser_cookie_set',
  'browser_cookie_delete',
  'browser_cookie_clear',
  'browser_storage_state',
  'browser_set_storage_state',
  'browser_localstorage_list',
  'browser_localstorage_get',
  'browser_localstorage_set',
  'browser_localstorage_delete',
  'browser_localstorage_clear',
  'browser_sessionstorage_list',
  'browser_sessionstorage_get',
  'browser_sessionstorage_set',
  'browser_sessionstorage_delete',
  'browser_sessionstorage_clear',
  'browser_live_state',
])

/** Why a call was refused by the sharing policy. */
export class SharingDeniedError extends Error {
  /**
   * @param {string} reason - machine-readable refusal code.
   * @param {string} detail - human-readable explanation, never containing secrets.
   */
  constructor(reason, detail) {
    super(`sharing policy denied: ${detail}`)
    this.name = 'SharingDeniedError'
    this.code = 'SHARING_DENIED'
    this.reason = reason
  }
}

/**
 * Describe one tool call for the policy layer.
 * @param {string} name - the tool name the registry dispatched.
 * @param {unknown} args - the call arguments as the model sent them.
 * @returns {{ kind: 'native' | 'mcp' | 'gateway' | 'other', innerTool: string | null, innerArgs: object, credential: boolean, malformed: string | null }} classification.
 */
export function classifyToolCall(name, args) {
  const call = { kind: 'other', innerTool: typeof name === 'string' ? name : null, innerArgs: {}, credential: false, malformed: null }
  if (typeof name !== 'string' || name.length === 0) {
    call.malformed = 'tool name is not a string'
    return call
  }
  const objectArgs = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {}
  if (name.startsWith(MCP_TOOL_PREFIX)) {
    const inner = name.slice(MCP_TOOL_PREFIX.length)
    if (inner === 'browser_gateway_call') {
      call.kind = 'gateway'
      const tool = objectArgs.tool
      if (typeof tool !== 'string' || tool.length === 0) {
        call.innerTool = null
        call.malformed = 'browser_gateway_call requires an inner "tool" string'
        return call
      }
      if (GATEWAY_META_TOOLS.includes(tool)) {
        call.innerTool = tool
        call.malformed = `browser_gateway_call cannot nest the gateway meta tool ${JSON.stringify(tool)}`
        return call
      }
      const innerArgs = objectArgs.arguments
      call.innerTool = tool
      call.innerArgs = innerArgs !== null && typeof innerArgs === 'object' && !Array.isArray(innerArgs) ? innerArgs : {}
      call.credential = CREDENTIAL_TOOL_NAMES.has(tool)
      return call
    }
    call.kind = 'mcp'
    call.innerTool = inner
    call.innerArgs = objectArgs
    call.credential = CREDENTIAL_TOOL_NAMES.has(inner)
    return call
  }
  if (name.startsWith('browser_live_')) {
    call.kind = 'native'
    call.innerArgs = objectArgs
    call.credential = CREDENTIAL_TOOL_NAMES.has(name)
    return call
  }
  return call
}

/**
 * Decide whether a classified call may run in the caller's scope.
 *
 * Membership comes from the scope resolver (never from the tool arguments), and
 * credential access is a separate grant inside a scope: an allowed scope member
 * without `allowCredentials` may browse and capture, but not read or write
 * stored credentials.
 * @param {ReturnType<typeof classifyToolCall>} call - classification from {@link classifyToolCall}.
 * @param {{ member?: boolean, allowCredentials?: boolean }} grant - the caller's effective grant.
 * @returns {{ allowed: true }} when the call may proceed.
 * @throws {SharingDeniedError} when it may not.
 */
export function authorizeCall(call, grant = {}) {
  if (call === null || typeof call !== 'object') throw new SharingDeniedError('invalid-call', 'call could not be classified')
  if (call.malformed !== null) {
    throw new SharingDeniedError('malformed-call', `${call.malformed}`)
  }
  if (call.kind === 'other') return { allowed: true }
  if (grant.member !== true) {
    throw new SharingDeniedError('not-a-member', `this session is not in a trusted sharing scope (tool ${JSON.stringify(call.innerTool)})`)
  }
  if (call.credential && grant.allowCredentials !== true) {
    throw new SharingDeniedError('credentials-not-granted', `credential access is not granted for this session (tool ${JSON.stringify(call.innerTool)})`)
  }
  return { allowed: true }
}
