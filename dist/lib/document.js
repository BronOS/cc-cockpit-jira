'use strict'
// The opened issue as one HTML document (the reviewer's HTML mode, and the plugin's own reader
// page): a header card (key and summary, then type, status, priority, people and dates), the
// description, the comments oldest first as cards (the ones after the person's seen mark get
// `.new`), and the attachments. Everything goes through adfhtml's escaping; this file writes only
// fixed markup around it, with the classes the reviewer's allow-list keeps (card, card-header,
// meta, new, status, lozenge, attachment-list).
//
// Size: the reviewer takes at most 2 MiB of html. A description over 1 MB of markup becomes its
// plain text (cut), and when the comments do not fit the oldest ones give way first, with a line
// that says how many are left out (the newest are what the discussion is about).

const { adfToHtml, textToHtml, esc } = require('./adfhtml')
const { attachmentsOf } = require('./model')
const { newEvents } = require('./seen')
const { adfToText } = require('./adf')
const { stamp, cut, parseTime } = require('./util')

const HTML_MAX_BYTES = 2000000 // below the reviewer's 2 MiB (2,097,152), counted in UTF-8 bytes
const DESCRIPTION_MAX_BYTES = 1000000

/** The attachment's address in Jira (the person's browser session opens it; no token here). */
function attachmentUrl(site, id) {
  return `${site}/rest/api/3/attachment/content/${encodeURIComponent(id)}`
}

/** `412 KB`, `3.1 MB`: an attachment's size for a person. */
function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const bytes = (s) => Buffer.byteLength(s, 'utf8')

/**
 * @param {object} o
 * @param {object} o.issue the kept issue (model.compact, `full`): header fields, events, attachments
 * @param {object|null} [o.raw] the issue as Jira sent it (ADF bodies); null for the cached copy,
 *   whose description and comments are plain text
 * @param {string} o.site
 * @param {number} [o.mark] the person's seen mark before this open
 * @param {string} [o.lane]
 * @param {Map<string, string>} [o.assets] attachment id -> asset id of the images downloaded
 * @param {string} [o.note] a line shown above the header (the cached copy's reason)
 * @returns {{ html: string, inlined: Set<string>, omittedComments: number }}
 */
function issueDocument(o) {
  const { issue, raw, site } = o
  const assets = o.assets || new Map()
  const attachments = raw ? attachmentsOf(raw) : issue.attachments || []
  const inlined = new Set()
  // ADF names an attachment by its file name (attrs.alt); with two of the same name the newest
  // wins (attachments are newest first).
  const byName = new Map()
  for (const a of attachments) if (!byName.has(a.name)) byName.set(a.name, a)
  const media = (attrs) => {
    const name = typeof attrs.alt === 'string' ? attrs.alt.trim() : ''
    const a = name ? byName.get(name) : null
    if (!a) return null
    const asset = assets.get(a.id)
    if (asset) {
      inlined.add(a.id)
      return { kind: 'image', assetId: asset, name: a.name }
    }
    return { kind: 'link', href: attachmentUrl(site, a.id), name: a.name }
  }
  const render = (body) => adfToHtml(body, { media, base: site })

  const parts = []
  if (o.note) parts.push(`<p><em>${esc(o.note)}</em></p>`)
  parts.push(headerCard(issue))

  // Description.
  parts.push('<h2>Description</h2>')
  const descBody = raw && raw.fields ? raw.fields.description : issue.description
  let desc = render(descBody)
  if (bytes(desc) > DESCRIPTION_MAX_BYTES) {
    const text = typeof descBody === 'string' ? descBody : adfToText(descBody)
    desc = `<p><em>The description is too long to show formatted; its text follows.</em></p>\n${textToHtml(cut(text, 300000))}`
  }
  parts.push(desc || '<p><em>No description.</em></p>')

  // Comments, oldest first; the new ones (others' since the mark) as the text marks them.
  const fresh = new Set(newEvents(issue, o.mark, o.lane === 'mentioned' ? 'any' : o.lane || 'any').map((e) => e.id))
  const comments = commentsOf(issue, raw).map((c) => {
    const isNew = fresh.has(`c${c.id}`)
    const head = `<div class="card-header"><strong>${esc(c.by)}</strong> · ${esc(stamp(c.at))}${isNew ? ' · <span class="lozenge">new</span>' : ''}</div>`
    return `<div class="card${isNew ? ' new' : ''}">${head}\n${render(c.body) || '<p><em>(empty comment)</em></p>'}</div>`
  })

  // Attachments: rendered after the comments have marked what they inline, but measured first.
  const tail = () => attachmentsHtml(attachments, assets, inlined, site)
  const fixed = bytes(parts.join('\n')) + bytes(tail()) + 2000
  let room = HTML_MAX_BYTES - fixed
  const kept = []
  for (let i = comments.length - 1; i >= 0; i--) {
    const b = bytes(comments[i]) + 1
    if (b > room) break
    room -= b
    kept.unshift(comments[i])
  }
  const omitted = comments.length - kept.length
  if (comments.length) {
    parts.push(`<h2>Comments (${comments.length})</h2>`)
    if (omitted) parts.push(`<p><em>${omitted} earlier comment${omitted === 1 ? ' is' : 's are'} not shown here (too long together); the issue in Jira has ${omitted === 1 ? 'it' : 'them'}.</em></p>`)
    parts.push(...kept)
  }
  // An image only an omitted comment showed is listed with the attachments again.
  if (omitted) {
    inlined.clear()
    const again = parts.join('\n')
    for (const [id, asset] of assets) if (again.includes(`data-asset="${asset}"`)) inlined.add(id)
  }
  const att = tail()
  if (att) parts.push(att)
  return { html: parts.join('\n'), inlined, omittedComments: omitted }
}

function headerCard(i) {
  const meta = []
  if (i.type) meta.push(esc(i.type))
  if (i.status) meta.push(`<span class="status lozenge">${esc(i.status)}</span>`)
  if (i.priority) meta.push(`Priority: ${esc(i.priority)}`)
  meta.push(`Assignee: ${esc(i.assignee || 'unassigned')}`)
  if (i.reporter) meta.push(`Reporter: ${esc(i.reporter)}`)
  if (i.created) meta.push(`Created ${esc(stamp(i.created))}`)
  if (i.updatedAt) meta.push(`Updated ${esc(stamp(i.updatedAt))}`)
  return `<div class="card"><h1>${esc(i.key)}: ${esc(i.summary || '')}</h1>\n<div class="meta">${meta.join(' · ')}</div></div>`
}

/** `{ id, by, at, body }` oldest first: ADF bodies from the raw issue, else the kept text. */
function commentsOf(issue, raw) {
  const list = raw && raw.fields && raw.fields.comment && Array.isArray(raw.fields.comment.comments) ? raw.fields.comment.comments : null
  if (list) {
    return list
      .filter((c) => c && c.id != null)
      .map((c) => ({ id: String(c.id), by: (c.author && c.author.displayName) || 'someone', at: parseTime(c.created), body: c.body }))
      .sort((x, y) => x.at - y.at)
  }
  return (issue.events || []).filter((e) => e.kind === 'comment').map((e) => ({ id: e.id.slice(1), by: e.by, at: e.at, body: e.text }))
}

/**
 * The Attachments section, newest first: an image inlined above is its name and size; an image
 * downloaded but not referenced in the text shows here; every other attachment (and an image
 * that is not downloaded: too big, past the count, late) is an https link to it in Jira.
 */
function attachmentsHtml(attachments, assets, inlined, site) {
  if (!attachments.length) return ''
  const items = attachments.map((a) => {
    const size = fmtSize(a.size)
    const meta = [size, a.by].filter(Boolean).map(esc).join(' · ')
    const asset = assets.get(a.id)
    if (asset && inlined.has(a.id)) return `<li>${esc(a.name)}${meta ? ` · ${meta}` : ''} (shown above)</li>`
    if (asset) return `<li><figure><img data-asset="${esc(asset)}" alt="${esc(a.name)}" title="${esc(a.name)}"><figcaption>${esc(a.name)}${meta ? ` · ${meta}` : ''}</figcaption></figure></li>`
    return `<li><a href="${esc(attachmentUrl(site, a.id))}">${esc(a.name)}</a>${meta ? ` · ${meta}` : ''}</li>`
  })
  return `<h2>Attachments (${attachments.length})</h2>\n<ul class="attachment-list">${items.join('')}</ul>`
}

module.exports = { issueDocument, attachmentUrl, fmtSize, HTML_MAX_BYTES }
