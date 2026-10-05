/**
 * dsh-browser-live — declarative recipe replay for `browser_live_recipe`.
 *
 * A bounded subset of the retired `@anweat/dsh-browser` recipe engine: at most
 * 25 steps of wait / click / fill / type / press / select / check / hover /
 * scroll / extract / assert / screenshot against one Playwright page. Steps run
 * in order; the first failure stops the replay and reports the step index.
 */

export const MAX_STEPS = 25

const EXTRACT_MODES = new Set(['text', 'html', 'links', 'attribute'])

/**
 * Execute one recipe against a page.
 * @param {import('playwright-core').Page} page - the page to drive.
 * @param {Array<object>} steps - declared steps (validated shape).
 * @param {{ screenshotDir?: string, screenshotName?: string }} [hints]
 * @returns {Promise<{ steps: Array<object>, extracts: object, screenshots: string[] }>}
 */
export async function runRecipe(page, steps, hints = {}) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('recipe requires a non-empty steps array')
  if (steps.length > MAX_STEPS) throw new Error(`recipe supports at most ${MAX_STEPS} steps (got ${steps.length})`)

  const results = []
  const extracts = {}
  const screenshots = []

  for (const [index, step] of steps.entries()) {
    try {
      results.push(await runStep(page, step, index, { extracts, screenshots, hints }))
    } catch (error) {
      const head = results.slice(-3)
      throw new Error(`recipe step ${index + 1} (${step.type}) failed: ${error.message.split('\n')[0]}; recent steps: ${JSON.stringify(head)}`)
    }
  }
  return { steps: results, extracts, screenshots }
}

async function runStep(page, step, index, sink) {
  const timeoutMs = boundedTimeout(step.timeoutMs, 30_000)
  const locator = step.selector ? page.locator(step.selector).first() : null
  const record = { step: index + 1, type: step.type }
  switch (step.type) {
    case 'wait': {
      if (step.selector && step.condition !== 'time') {
        await page.locator(step.selector).first().waitFor({ state: 'visible', timeout: timeoutMs })
        record.waitedFor = step.selector
      } else {
        const ms = boundedTimeout(step.waitMs ?? 1_000, 30_000)
        await page.waitForTimeout(ms)
        record.waitedMs = ms
      }
      break
    }
    case 'click': {
      requireSelector(step)
      await locator.click({ timeout: timeoutMs })
      break
    }
    case 'fill': {
      requireSelector(step)
      if (typeof step.value !== 'string') throw new Error('fill requires a string value')
      await locator.fill(step.value, { timeout: timeoutMs })
      break
    }
    case 'type': {
      requireSelector(step)
      if (typeof step.value !== 'string') throw new Error('type requires a string value')
      await locator.pressSequentially(step.value, { timeout: timeoutMs })
      break
    }
    case 'press': {
      if (typeof step.key !== 'string' || step.key.length === 0) throw new Error('press requires a key')
      if (step.selector) await locator.press(step.key, { timeout: timeoutMs })
      else await page.keyboard.press(step.key)
      record.key = step.key
      break
    }
    case 'select': {
      requireSelector(step)
      if (!Array.isArray(step.value) && typeof step.value !== 'string') throw new Error('select requires value (string or array)')
      const selected = await locator.selectOption(step.value, { timeout: timeoutMs })
      record.selected = selected
      break
    }
    case 'check': {
      requireSelector(step)
      if (step.checked === false) await locator.uncheck({ timeout: timeoutMs })
      else await locator.check({ timeout: timeoutMs })
      break
    }
    case 'hover': {
      requireSelector(step)
      await locator.hover({ timeout: timeoutMs })
      break
    }
    case 'scroll': {
      const deltaY = Number.isFinite(step.deltaY) ? step.deltaY : 600
      if (step.selector) await locator.hover({ timeout: timeoutMs })
      await page.mouse.wheel(0, deltaY)
      record.deltaY = deltaY
      break
    }
    case 'extract': {
      const mode = EXTRACT_MODES.has(step.mode) ? step.mode : 'text'
      const key = step.attribute || mode + (step.selector ? `:${step.selector}` : ':page')
      sink.extracts[key] = await extract(page, step, mode, timeoutMs)
      record.extracted = key
      break
    }
    case 'assert': {
      if (step.selector) {
        const state = step.condition === 'text' ? 'visible' : 'attached'
        const target = page.locator(step.selector).first()
        await target.waitFor({ state, timeout: timeoutMs })
        if (typeof step.text === 'string' && step.text.length > 0) {
          const body = await target.innerText({ timeout: timeoutMs })
          if (!body.includes(step.text)) throw new Error(`element ${step.selector} does not contain ${JSON.stringify(step.text)}`)
        }
        record.asserted = step.selector
      } else if (typeof step.text === 'string' && step.text.length > 0) {
        await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs })
        const body = await page.evaluate(() => document.body?.innerText || '')
        if (!body.includes(step.text)) throw new Error(`page does not contain ${JSON.stringify(step.text)}`)
        record.assertedText = step.text
      } else {
        throw new Error('assert requires a selector and/or text')
      }
      break
    }
    case 'screenshot': {
      if (!sink.hints.screenshotDir) throw new Error('screenshot steps require a screenshotDir hint')
      const path = joinPath(sink.hints.screenshotDir, `${sink.hints.screenshotName || 'recipe'}-${index + 1}.png`)
      if (step.selector) await page.locator(step.selector).first().screenshot({ path, timeout: timeoutMs })
      else await page.screenshot({ path, fullPage: true, timeout: timeoutMs })
      sink.screenshots.push(path)
      record.screenshotPath = path
      break
    }
    default:
      throw new Error(`unknown step type ${JSON.stringify(step.type)}`)
  }
  return record
}

function requireSelector(step) {
  if (typeof step.selector !== 'string' || step.selector.length === 0) {
    throw new Error(`${step.type} requires a selector`)
  }
}

function boundedTimeout(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.min(value, 60_000) : fallback
}

async function extract(page, step, mode, timeoutMs) {
  const limit = Number.isFinite(step.limit) && step.limit > 0 ? Math.min(Math.floor(step.limit), 2_000) : 200
  if (mode === 'attribute') {
    if (typeof step.attribute !== 'string') throw new Error('extract mode "attribute" requires an attribute name')
    requireSelector(step)
    const values = await page.locator(step.selector).all()
    const out = []
    for (const [i, loc] of values.entries()) {
      if (i >= limit) break
      out.push(await loc.getAttribute(step.attribute, { timeout: timeoutMs }))
    }
    return out
  }
  if (mode === 'links') {
    return page.evaluate((cap) => {
      const out = []
      for (const a of document.querySelectorAll('a[href]')) {
        let href
        try {
          href = new URL(a.getAttribute('href'), location.href).href
        } catch {
          continue
        }
        if (!/^https?:/i.test(href)) continue
        out.push({ href, text: (a.innerText || '').trim().slice(0, 120) || undefined })
        if (out.length >= cap) break
      }
      return out
    }, limit)
  }
  if (step.selector) {
    const loc = page.locator(step.selector).first()
    const value = mode === 'html' ? await loc.innerHTML({ timeout: timeoutMs }) : await loc.innerText({ timeout: timeoutMs })
    return value.slice(0, 50_000)
  }
  const body = mode === 'html'
    ? await page.evaluate(() => document.documentElement.outerHTML)
    : await page.evaluate(() => document.body?.innerText || '')
  return body.slice(0, 50_000)
}

function joinPath(dir, name) {
  return dir.endsWith('/') ? dir + name : dir + '/' + name
}
