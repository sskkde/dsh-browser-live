/**
 * P0 G-1 probe: origin and account isolation while restoring a shared login.
 *
 * Run manually: `node scripts/p0-auth-isolation.mjs` (needs a local Chrome at
 * /usr/bin/google-chrome). It starts a throwaway HTTP server on 127.0.0.1:38917
 * — the same port is also reachable as `localhost`, which is a different origin
 * and therefore a different cookie host — and asserts:
 *
 *  1. a cookie for one host is never sent to the other;
 *  2. two accounts on one host cannot coexist (same cookie name overwrites),
 *     so a restore that only adds would silently keep the previous account's
 *     other cookies;
 *  3. restore must clear the target host's cookies first, then add, and only
 *     then does the jar belong to one account;
 *  4. localStorage is per origin, so seeding account B does not touch host A.
 *
 * This is a probe, not a test suite: it prints PASS/FAIL per case and exits
 * non-zero when anything fails.
 */

import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const PORT = 38917
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`)
}

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><script>window.__seen = { cookie: document.cookie, ls: localStorage.getItem('acct'), href: location.href }</script><h1>${req.headers.cookie ?? ''}</h1>`)
})
await new Promise((resolve) => server.listen(PORT, '0.0.0.0', resolve))

const profile = mkdtempSync(join(tmpdir(), 'p0-iso-'))
const context = await chromium.launchPersistentContext(profile, {
  executablePath: '/usr/bin/google-chrome',
  headless: true,
})
const page = context.pages()[0] ?? await context.newPage()
const visit = async (host) => {
  await page.goto(`http://${host}:${PORT}/`, { waitUntil: 'load' })
  return page.evaluate(() => window.__seen)
}
const jar = async () => (await context.cookies()).filter((c) => c.name.startsWith('acct_') || c.name === 'sessionid' || c.name === 'profile')

// 1. origin isolation: one cookie per host, never crossed
await context.addCookies([
  { name: 'acct_host', value: 'LOOPBACK', domain: '127.0.0.1', path: '/' },
  { name: 'acct_host', value: 'LOCALHOST', domain: 'localhost', path: '/' },
])
const atLoopback = await visit('127.0.0.1')
const atLocalhost = await visit('localhost')
check('cookie for 127.0.0.1 is not sent to localhost', !atLocalhost.cookie.includes('LOOPBACK'), atLocalhost.cookie)
check('cookie for localhost is not sent to 127.0.0.1', !atLoopback.cookie.includes('LOCALHOST'), atLoopback.cookie)
check('each origin sees its own cookie', atLoopback.cookie.includes('LOOPBACK') && atLocalhost.cookie.includes('LOCALHOST'))

// 2. two accounts cannot coexist: adding account B leaves account A's other cookies
await context.addCookies([
  { name: 'sessionid', value: 'ACCOUNT_A', domain: 'localhost', path: '/' },
  { name: 'profile', value: 'A_PROFILE', domain: 'localhost', path: '/' },
])
await context.addCookies([{ name: 'sessionid', value: 'ACCOUNT_B', domain: 'localhost', path: '/' }])
const mixed = await visit('localhost')
check('adding only sessionid leaves the previous account\'s profile cookie behind', mixed.cookie.includes('A_PROFILE') && mixed.cookie.includes('ACCOUNT_B'), mixed.cookie)

// 3. the correct restore: clear the host's cookies, then add exactly one account
await context.clearCookies({ domain: 'localhost' })
await context.addCookies([
  { name: 'sessionid', value: 'ACCOUNT_B', domain: 'localhost', path: '/' },
  { name: 'profile', value: 'B_PROFILE', domain: 'localhost', path: '/' },
])
const clean = await visit('localhost')
check('after clear+add the jar belongs to account B only', clean.cookie.includes('ACCOUNT_B') && clean.cookie.includes('B_PROFILE') && !clean.cookie.includes('ACCOUNT_A') && !clean.cookie.includes('A_PROFILE'), clean.cookie)

// 4. localStorage is per origin: seeding one host must not touch the other
await page.evaluate(() => localStorage.setItem('acct', 'B_LOCALSTORAGE'))
const other = await visit('127.0.0.1')
check('localStorage written for localhost is not visible on 127.0.0.1', other.ls === null, other.ls)

// 5. clearing one host must not clear the other
check('clearing localhost kept the 127.0.0.1 cookie', (await jar()).some((c) => c.domain === '127.0.0.1'), await jar())

await context.close()
server.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
