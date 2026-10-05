/**
 * dsh-browser-live — builtin read-only page scripts for `browser_live_script`.
 *
 * Mirrors the four high-frequency builtin scripts the retired
 * `@anweat/dsh-browser` exposed (article-clean / links / jsonld / forms). Each
 * entry is a self-contained function evaluated inside the page via
 * `page.evaluate`; the SHA-256 recorded in tool results is taken over the
 * function source, so callers can pin exactly what ran.
 */

import crypto from 'node:crypto'

function articleClean() {
  const visible = (el) => {
    if (!el || !(el instanceof Element)) return false
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const score = (el) => {
    const text = el.innerText || ''
    const links = el.querySelectorAll('a').length
    const density = text.length > 0 ? links / Math.max(1, text.length / 100) : 0
    return text.length - density * 200 + (el.querySelectorAll('p').length * 25)
  }
  const candidates = [
    ...document.querySelectorAll('article, main, [role="main"], .post, .article, .content, #content, #main'),
  ].filter(visible)
  let best = candidates.sort((a, b) => score(b) - score(a))[0] || document.body
  const headings = [...best.querySelectorAll('h1')].map((h) => h.innerText.trim()).filter(Boolean)
  const title = headings[0] || document.title
  const paragraphs = [...best.querySelectorAll('p, li, pre, blockquote')]
    .map((p) => p.innerText.trim())
    .filter((t) => t.length > 0)
  const fallback = paragraphs.length === 0 ? (best.innerText || '').trim() : ''
  const text = (paragraphs.length > 0 ? paragraphs.join('\n\n') : fallback).slice(0, 50_000)
  return {
    url: location.href,
    title,
    byline: (document.querySelector('[rel="author"], .byline, .author')?.innerText || '').trim().slice(0, 200) || undefined,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    text,
  }
}

function links() {
  const seen = new Set()
  const out = []
  for (const a of document.querySelectorAll('a[href]')) {
    let href
    try {
      href = new URL(a.getAttribute('href'), location.href).href
    } catch {
      continue
    }
    if (!/^https?:/i.test(href) || seen.has(href)) continue
    seen.add(href)
    out.push({ href, text: (a.innerText || '').trim().slice(0, 120) || undefined })
    if (out.length >= 500) break
  }
  return { url: location.href, count: out.length, links: out }
}

function jsonld() {
  const blocks = []
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      blocks.push(JSON.parse(el.textContent || ''))
    } catch {
      blocks.push({ _unparseable: (el.textContent || '').slice(0, 2_000) })
    }
  }
  const microdata = [...document.querySelectorAll('[itemtype]')].slice(0, 50).map((el) => ({
    type: el.getAttribute('itemtype'),
    props: Object.fromEntries([...el.querySelectorAll('[itemprop]')].slice(0, 50).map((p) => [p.getAttribute('itemprop'), (p.getAttribute('content') || p.innerText || '').trim().slice(0, 500)])),
  }))
  return { url: location.href, jsonld: blocks, microdata }
}

function forms() {
  const labelFor = (field) => {
    if (field.id) {
      const label = document.querySelector(`label[for="${CSS.escape(field.id)}"]`)
      if (label) return label.innerText.trim().slice(0, 120)
    }
    const wrapped = field.closest('label')
    return wrapped ? wrapped.innerText.trim().slice(0, 120) : undefined
  }
  const describe = (field) => {
    const base = {
      name: field.name || undefined,
      id: field.id || undefined,
      type: field instanceof HTMLTextAreaElement ? 'textarea' : (field.type || undefined),
      label: labelFor(field),
      required: field.required || undefined,
      placeholder: field.placeholder || undefined,
      value: (field instanceof HTMLInputElement && ['checkbox', 'radio', 'password'].includes(field.type)) ? undefined : String(field.value ?? '').slice(0, 200) || undefined,
    }
    if (field instanceof HTMLSelectElement) {
      base.options = [...field.options].slice(0, 50).map((o) => o.value || o.text)
    }
    return base
  }
  const forms = [...document.querySelectorAll('form')].slice(0, 50).map((form) => ({
    name: form.name || undefined,
    id: form.id || undefined,
    action: form.action || undefined,
    method: (form.method || 'get').toUpperCase(),
    fields: [...form.querySelectorAll('input, textarea, select')].slice(0, 100).map(describe),
  }))
  const orphans = [...document.querySelectorAll('input, textarea, select')]
    .filter((f) => !f.closest('form'))
    .slice(0, 50)
    .map(describe)
  return { url: location.href, forms, orphanFields: orphans.length > 0 ? orphans : undefined }
}

/** name → { description, capabilities, run() } — `run` executes in the page. */
export const builtinScripts = {
  'article-clean': {
    description: 'Extract the main readable article text (title, byline, word count, trimmed body).',
    capabilities: ['text'],
    run: articleClean,
  },
  'links': {
    description: 'List same-page HTTP(S) links (deduplicated, capped at 500) with their visible text.',
    capabilities: ['text'],
    run: links,
  },
  'jsonld': {
    description: 'Collect JSON-LD blocks and a bounded microdata projection for structured-data inspection.',
    capabilities: ['text'],
    run: jsonld,
  },
  'forms': {
    description: 'Inventory forms and standalone fields (names, types, labels, options, current values).',
    capabilities: ['text'],
    run: forms,
  },
}

export function scriptCatalog() {
  return Object.entries(builtinScripts).map(([name, script]) => ({
    name,
    description: script.description,
    capabilities: script.capabilities,
    sha256: scriptSha256(name),
  }))
}

export function scriptSha256(name) {
  const script = builtinScripts[name]
  return crypto.createHash('sha256').update(String(script.run)).digest('hex')
}
