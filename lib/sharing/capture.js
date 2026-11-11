/**
 * dsh-browser-live — shared-login capture scope.
 *
 * `browser_live_state save` must not publish "the whole browser": it captures
 * one account at one site. The site is the visible tab's exact origin; the
 * account comes from the operator's binding (or an explicit name that matches
 * it); cookies are accepted only for the origin host plus the binding's
 * explicit cookie domains, and localStorage only for the origin plus its
 * explicit SSO origins. Anything else is dropped and reported — never stored
 * under the first page's key.
 */

/** Normalize a cookie domain (leading dot removed, lower case). */
export function normalizeCookieDomain(domain) {
  return String(domain ?? '').replace(/^\./, '').toLowerCase()
}

/**
 * Select the part of the current browser state that belongs to one site.
 * @param {{ cookies: Array<object>, pages: Array<{ origin: string, localStorage: Array<{name: string, value: string}> }>, binding: object | null, origin: string, requestedAccount?: string | null }} input
 * @returns {{ accountKey: string, cookies: Array<object>, origins: Array<object>, droppedCookieDomains: string[], skippedOrigins: string[] }} capture plan.
 */
export function selectCapture({ cookies, pages, binding, origin, requestedAccount = null }) {
  let host
  try {
    host = new URL(origin).hostname.toLowerCase()
  } catch {
    throw new Error(`capture origin is invalid: ${origin}`)
  }
  if (binding !== null && requestedAccount !== null && requestedAccount !== binding.accountKey) {
    throw new Error(`account conflict: ${origin} is bound to "${binding.accountKey}", not "${requestedAccount}"; use another origin or update the admin binding`)
  }
  const accountKey = requestedAccount ?? binding?.accountKey ?? host
  const cookieHosts = new Set([host, ...(binding?.cookieDomains ?? [])])
  const allowedOrigins = new Set([origin, ...(binding?.ssoOrigins ?? [])])
  const keptCookies = []
  const droppedCookieDomains = new Set()
  for (const cookie of cookies ?? []) {
    if (cookie?.name === '__dsh_restore_marker') continue
    const domain = normalizeCookieDomain(cookie?.domain)
    if (cookieHosts.has(domain)) keptCookies.push(cookie)
    else droppedCookieDomains.add(domain || '(host-only)')
  }
  const keptOrigins = []
  const skippedOrigins = new Set()
  const seen = new Set()
  for (const page of pages ?? []) {
    if (typeof page?.origin !== 'string' || !page.origin.startsWith('http')) {
      skippedOrigins.add(String(page?.origin ?? '?'))
      continue
    }
    if (!allowedOrigins.has(page.origin)) {
      skippedOrigins.add(page.origin)
      continue
    }
    if (seen.has(page.origin)) continue
    seen.add(page.origin)
    keptOrigins.push({ origin: page.origin, localStorage: page.localStorage ?? [] })
  }
  return {
    accountKey,
    cookies: keptCookies,
    origins: keptOrigins,
    droppedCookieDomains: [...droppedCookieDomains],
    skippedOrigins: [...skippedOrigins],
  }
}
