'use strict'
// Atlassian Document Format to HTML, for the reviewer's HTML mode (cc-cockpit 0.8.0) and the
// plugin's own reader page.
//
// Safe by construction: the output is built from the ADF tree, never from Jira's rendered HTML,
// every text and attribute value is escaped, and only the tags and classes the reviewer's
// allow-list keeps are written (h1-h6, p, br, hr, ul, ol, li, pre, code, blockquote, table parts,
// a, img, strong, em, s, u, sub, sup, span, div, details/summary, figure/figcaption; the classes
// jira-panel*, mention, status, lozenge). No style attribute, no id, no event attribute ever. A
// link keeps its href only when it is http(s) or mailto; an image is never a remote address: it
// is `data-asset="<id>"` naming an asset the caller downloaded, or a link instead.
//
// Media (images, files) is resolved by the caller (`o.media`): ADF names a media-services file
// (`attrs.id`, a uuid that is not the REST attachment id) and its file name (`attrs.alt`), so the
// document builder matches it to the issue's attachments by name.

const MAX_DEPTH = 64 // a hostile or broken document cannot blow the stack

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Text or an attribute value, escaped for HTML (quotes too, so it is safe inside "..."). */
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESC[c])
}

/**
 * The href a link may keep: an absolute http(s) or mailto address (a relative one is resolved
 * against `base`, the site), normalised by URL; null for javascript:, data:, file: and the rest.
 */
function safeHref(href, base) {
  if (typeof href !== 'string') return null
  const s = href.trim()
  if (!s || s.length > 4096) return null
  let u
  try {
    u = base ? new URL(s, base) : new URL(s)
  } catch {
    return null
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') return u.username || u.password ? null : u.href
  if (u.protocol === 'mailto:') return u.href
  return null
}

/** Plain text (a v2 body, or the cached copy's text) as paragraphs with line breaks. */
function textToHtml(text) {
  const t = String(text == null ? '' : text).trim()
  if (!t) return ''
  return t
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}

const PANELS = { info: 'info', note: 'note', warning: 'warning', error: 'error', success: 'success', tip: 'success' }

const INLINE = new Set(['text', 'hardBreak', 'mention', 'emoji', 'inlineCard', 'status', 'date', 'placeholder', 'mediaInline'])

/**
 * HTML of an ADF document (or of a plain-text body).
 *
 * @param {object|string|null} doc
 * @param {object} [o]
 * @param {(attrs: object) => ({ kind: 'image', assetId: string, name: string } | { kind: 'link', href: string, name: string } | null)} [o.media]
 *   how a media node shows: an inlined image, a link to the attachment, or (null) its name as text
 * @param {string} [o.base] the site, for relative links
 * @param {number} [o.headingShift] added to heading levels (default 1: the document's h1 is the issue)
 */
function adfToHtml(doc, o = {}) {
  if (doc == null) return ''
  if (typeof doc === 'string') return textToHtml(doc)
  if (typeof doc !== 'object') return ''
  const c = { media: typeof o.media === 'function' ? o.media : () => null, base: o.base, shift: Number.isInteger(o.headingShift) ? o.headingShift : 1 }
  return blocks(Array.isArray(doc.content) ? doc.content : [doc], 0, c)
}

function blocks(nodes, depth, c) {
  const out = []
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const h = block(n, depth, c)
    if (h !== '') out.push(h)
  }
  return out.join('\n')
}

function block(n, depth, c) {
  if (!n || typeof n !== 'object' || depth > MAX_DEPTH) return ''
  const kids = Array.isArray(n.content) ? n.content : []
  const a = n.attrs && typeof n.attrs === 'object' ? n.attrs : {}
  switch (n.type) {
    case 'paragraph': {
      const h = inline(kids, depth, c)
      return h ? `<p>${h}</p>` : ''
    }
    case 'heading': {
      const level = Math.min(6, Math.max(1, (Number(a.level) || 1) + c.shift))
      return `<h${level}>${inline(kids, depth, c)}</h${level}>`
    }
    case 'bulletList':
      return `<ul>${items(kids, depth, c, () => '')}</ul>`
    case 'orderedList':
      // No `start` attribute (not on the allow-list): a list starting at 3 shows from 1.
      return `<ol>${items(kids, depth, c, () => '')}</ol>`
    case 'taskList':
      return `<ul>${items(kids, depth, c, (item) => ((item.attrs || {}).state === 'DONE' ? '☑ ' : '☐ '))}</ul>`
    case 'decisionList':
      return `<ul>${items(kids, depth, c, () => 'Decision: ')}</ul>`
    case 'listItem':
    case 'taskItem':
    case 'decisionItem':
      return `<li>${itemBody(n, depth, c)}</li>`
    case 'codeBlock': {
      const code = kids.map((t) => (t && typeof t.text === 'string' ? t.text : '')).join('')
      return `<pre><code>${esc(code.replace(/\n+$/, ''))}</code></pre>`
    }
    case 'blockquote':
      return `<blockquote>${blocks(kids, depth + 1, c)}</blockquote>`
    case 'rule':
      return '<hr>'
    case 'panel': {
      const kind = PANELS[typeof a.panelType === 'string' ? a.panelType : ''] || 'info'
      return `<div class="jira-panel jira-panel-${kind}">${blocks(kids, depth + 1, c)}</div>`
    }
    case 'expand':
    case 'nestedExpand': {
      const title = typeof a.title === 'string' && a.title.trim() ? a.title : 'Details'
      return `<details><summary>${esc(title)}</summary>${blocks(kids, depth + 1, c)}</details>`
    }
    case 'table':
      return table(kids, depth, c)
    case 'mediaSingle': {
      const media = kids.filter((x) => x && (x.type === 'media' || x.type === 'mediaInline'))
      const caption = kids.find((x) => x && x.type === 'caption')
      const cap = caption ? inline(caption.content, depth + 1, c) : ''
      const shown = media.map((m) => mediaHtml(m, c))
      if (!shown.length) return ''
      if (shown.some((s) => s.image)) return `<figure>${shown.map((s) => s.html).join('')}${cap ? `<figcaption>${cap}</figcaption>` : ''}</figure>`
      return `<p>${shown.map((s) => s.html).join(' ')}${cap ? ` (${cap})` : ''}</p>`
    }
    case 'mediaGroup':
      return kids
        .map((m) => mediaHtml(m, c))
        .map((s) => (s.image ? `<figure>${s.html}</figure>` : `<p>${s.html}</p>`))
        .join('\n')
    case 'media': {
      const s = mediaHtml(n, c)
      return s.image ? `<figure>${s.html}</figure>` : `<p>${s.html}</p>`
    }
    case 'blockCard':
    case 'embedCard': {
      const h = cardLink(a.url, c)
      return h ? `<p>${h}</p>` : ''
    }
    default: {
      // An unknown block: its children as blocks, or as one paragraph when they are inline.
      if (kids.length && kids.every((x) => x && INLINE.has(x.type))) {
        const h = inline(kids, depth, c)
        return h ? `<p>${h}</p>` : ''
      }
      return blocks(kids, depth + 1, c)
    }
  }
}

function items(list, depth, c, marker) {
  return list
    .filter((x) => x && typeof x === 'object')
    .map((item) => {
      if (item.type === 'listItem' || item.type === 'taskItem' || item.type === 'decisionItem') {
        return `<li>${esc(marker(item))}${itemBody(item, depth + 1, c)}</li>`
      }
      // A nested taskList sits right inside its parent taskList: an item of its own.
      return `<li>${block(item, depth + 1, c)}</li>`
    })
    .join('')
}

/** A list item's content: inline nodes as they are (task and decision items), else its blocks. */
function itemBody(n, depth, c) {
  const kids = Array.isArray(n.content) ? n.content : []
  if (kids.every((x) => x && INLINE.has(x.type))) return inline(kids, depth, c)
  // A single paragraph needs no <p> inside the <li> (tighter lists, as Jira shows them).
  if (kids.length === 1 && kids[0] && kids[0].type === 'paragraph') return inline(kids[0].content, depth + 1, c)
  return blocks(kids, depth + 1, c)
}

function table(rows, depth, c) {
  const trs = rows.filter((r) => r && r.type === 'tableRow' && Array.isArray(r.content))
  if (!trs.length) return ''
  const rowHtml = (r) => `<tr>${r.content.map((cell) => tableCell(cell, depth, c)).join('')}</tr>`
  const isHead = (r) => r.content.length > 0 && r.content.every((cell) => cell && cell.type === 'tableHeader')
  const head = isHead(trs[0]) ? `<thead>${rowHtml(trs[0])}</thead>` : ''
  const body = (head ? trs.slice(1) : trs).map(rowHtml).join('')
  return `<table>${head}${body ? `<tbody>${body}</tbody>` : ''}</table>`
}

function tableCell(cell, depth, c) {
  if (!cell || typeof cell !== 'object') return '<td></td>'
  const tag = cell.type === 'tableHeader' ? 'th' : 'td'
  const a = cell.attrs && typeof cell.attrs === 'object' ? cell.attrs : {}
  let attrs = ''
  for (const k of ['colspan', 'rowspan']) {
    const v = Number(a[k])
    if (Number.isInteger(v) && v > 1 && v <= 1000) attrs += ` ${k}="${v}"`
  }
  const kids = Array.isArray(cell.content) ? cell.content : []
  // A cell of one paragraph: its text alone, like Jira's table cells.
  const inner = kids.length === 1 && kids[0] && kids[0].type === 'paragraph' ? inline(kids[0].content, depth + 1, c) : blocks(kids, depth + 1, c)
  return `<${tag}${attrs}>${inner}</${tag}>`
}

/** A media node: `{ html, image }`. External media is a link, never a remote <img>. */
function mediaHtml(m, c) {
  const a = m && m.attrs && typeof m.attrs === 'object' ? m.attrs : {}
  const name = mediaName(a)
  if (a.type === 'external') {
    const href = safeHref(a.url, c.base)
    return { html: href ? `<a href="${esc(href)}">${esc(`image: ${name || href}`)}</a>` : esc(`[image: ${name || 'external'}]`), image: false }
  }
  const r = c.media(a)
  if (r && r.kind === 'image' && typeof r.assetId === 'string' && r.assetId) {
    const label = r.name || name || 'image'
    return { html: `<img data-asset="${esc(r.assetId)}" alt="${esc(label)}" title="${esc(label)}">`, image: true }
  }
  if (r && r.kind === 'link') {
    const href = safeHref(r.href, c.base)
    const label = r.name || name || 'attachment'
    if (href) return { html: `<a href="${esc(href)}">${esc(label)}</a>`, image: false }
  }
  return { html: esc(name ? `[attachment: ${name}]` : '[attachment]'), image: false }
}

function mediaName(a) {
  if (typeof a.alt === 'string' && a.alt.trim()) return a.alt.trim()
  if (typeof a.name === 'string' && a.name.trim()) return a.name.trim()
  return ''
}

function cardLink(url, c) {
  const href = safeHref(url, c.base)
  return href ? `<a href="${esc(href)}">${esc(href)}</a>` : typeof url === 'string' ? esc(url) : ''
}

/** Inline nodes as one run of HTML. */
function inline(nodes, depth, c) {
  let out = ''
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n || typeof n !== 'object' || depth > MAX_DEPTH) continue
    const a = n.attrs && typeof n.attrs === 'object' ? n.attrs : {}
    switch (n.type) {
      case 'text':
        out += marks(typeof n.text === 'string' ? n.text : '', n.marks, c)
        break
      case 'hardBreak':
        out += '<br>'
        break
      case 'mention':
        out += `<span class="mention">${esc(mentionText(a))}</span>`
        break
      case 'emoji':
        out += esc(typeof a.text === 'string' && a.text ? a.text : typeof a.shortName === 'string' ? a.shortName : '')
        break
      case 'inlineCard':
        out += cardLink(a.url, c)
        break
      case 'status':
        out += typeof a.text === 'string' && a.text ? `<span class="status lozenge">${esc(a.text)}</span>` : ''
        break
      case 'date': {
        const ms = Number(a.timestamp)
        out += Number.isFinite(ms) ? esc(new Date(ms).toISOString().slice(0, 10)) : ''
        break
      }
      case 'mediaInline':
        out += mediaHtml(n, c).html
        break
      case 'placeholder':
        break
      default:
        if (Array.isArray(n.content)) out += inline(n.content, depth + 1, c)
    }
  }
  return out
}

const WRAP = { strong: 'strong', em: 'em', strike: 's', underline: 'u', code: 'code' }

/**
 * A text node with its marks. The link goes outermost so the whole styled run is the link;
 * colours and alignment (textColor, backgroundColor) are dropped: no style attribute.
 */
function marks(text, list, c) {
  let h = esc(text)
  let href = null
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || typeof m !== 'object') continue
    if (WRAP[m.type]) h = `<${WRAP[m.type]}>${h}</${WRAP[m.type]}>`
    else if (m.type === 'subsup') {
      const t = m.attrs && m.attrs.type === 'sup' ? 'sup' : 'sub'
      h = `<${t}>${h}</${t}>`
    } else if (m.type === 'link') href = safeHref(m.attrs && m.attrs.href, c.base)
  }
  return href ? `<a href="${esc(href)}">${h}</a>` : h
}

/** `@Name`: Jira keeps the shown text (with its @) in attrs.text; an empty one falls back to the id. */
function mentionText(a) {
  const t = typeof a.text === 'string' ? a.text.trim() : ''
  if (t) return t.startsWith('@') ? t : `@${t}`
  return typeof a.id === 'string' ? `@${a.id}` : '@someone'
}

module.exports = { adfToHtml, textToHtml, esc, safeHref }
