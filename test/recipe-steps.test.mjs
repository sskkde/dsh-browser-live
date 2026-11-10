/**
 * dsh-browser-live — recipe step contract tests.
 *
 * A step that does not fit its per-type contract must be rejected with the
 * step index, the offending field, and a way forward — before any page is
 * touched. These tests pin that behaviour, including the failure that used to
 * surface only mid-replay (`click` given `text` instead of `selector`).
 *
 * Run with `node --test "test/**\/*.test.mjs"`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_STEPS, STEP_CONTRACT, runRecipe, validateRecipeSteps } from '../lib/recipes.js'

const rejects = (steps, ...fragments) => {
  assert.throws(() => validateRecipeSteps(steps), (error) => {
    for (const fragment of fragments) assert.ok(error.message.includes(fragment), `missing ${JSON.stringify(fragment)} in:\n${error.message}`)
    return true
  })
}

test('a per-type step passes its contract', () => {
  assert.doesNotThrow(() => validateRecipeSteps([
    { type: 'wait', selector: '#app', condition: 'selector' },
    { type: 'click', selector: 'button[type=submit]' },
    { type: 'fill', selector: '#q', value: '小红书' },
    { type: 'press', key: 'Enter' },
    { type: 'assert', text: '搜索结果' },
    { type: 'scroll', deltaY: 400 },
    { type: 'extract', mode: 'text', selector: '.feed' },
    { type: 'screenshot', selector: '.qrcode' },
  ]))
  for (const spec of Object.values(STEP_CONTRACT)) assert.ok(Array.isArray(spec.allowed) && Array.isArray(spec.required))
})

test('click given text instead of selector is rejected with both facts and a way forward', () => {
  rejects(
    [{ type: 'click', text: '点击刷新' }],
    'recipe steps rejected before replay (2 problems)',
    'steps[0] (click): missing required "selector"',
    'steps[0] (click): "text" is not used by click (allowed: type, selector, timeoutMs)',
    'mcp__playwright-mcp__browser_click',
  )
})

test('click given both selector and text still rejects the unused field', () => {
  rejects([{ type: 'click', selector: '#refresh', text: '点击刷新' }], '"text" is not used by click')
})

test('unknown step type lists the known ones', () => {
  rejects([{ type: 'tap', selector: '#a' }], 'unknown step type "tap"', 'wait/click/fill')
})

test('missing value and empty selector are reported together', () => {
  rejects(
    [{ type: 'fill', selector: '   ' }],
    'missing required "value"',
    '"selector" must not be empty',
  )
})

test('assert needs a selector or text', () => {
  rejects([{ type: 'assert' }], 'steps[0] (assert): needs "selector" and/or "text"')
})

test('every problem carries its own step index', () => {
  rejects(
    [{ type: 'click', selector: '#ok' }, { type: 'click', text: 'x' }, { type: 'hover' }],
    'steps[1] (click)',
    'steps[2] (hover): missing required "selector"',
  )
})

test('a stray field the type does not read is rejected rather than ignored', () => {
  rejects([{ type: 'scroll', waitMs: 500 }], '"waitMs" is not used by scroll (allowed: type, selector, deltaY, timeoutMs)')
})

test('the steps array itself is bounded and non-empty', () => {
  rejects([], 'non-empty steps array')
  rejects(Array.from({ length: MAX_STEPS + 1 }, () => ({ type: 'screenshot' })), `at most ${MAX_STEPS} steps`)
  rejects([null], 'steps[0]: must be a step object')
})

test('runRecipe validates before it touches the page', async () => {
  const page = new Proxy({}, { get() { throw new Error('page must not be touched') } })
  await assert.rejects(() => runRecipe(page, [{ type: 'click', text: '点击刷新' }]), /missing required "selector"/)
})
