/** Shared `[browser-live]`-prefixed console helpers. */

export function log(...args) {
  console.log('[browser-live]', ...args)
}

export function warn(...args) {
  console.warn('[browser-live]', ...args)
}
