'use strict'
// Atlassian Document Format (Jira REST v3's description and comment bodies) to plain text, and
// the mention scan. JQL cannot search mentions (they are accountIds inside ADF), so the plugin
// reads the bodies itself (design "Fetching").
//
// The text is what a person (the reviewer overlay, `ccc jira show`) and Claude read, and what Jev
// classifies: lists keep their bullets and numbers, code blocks their fences, links their URL,
// mentions read `@Name`. Media (images, files) becomes a short placeholder: v1 has no attachments.

const MAX_DEPTH = 64 // a hostile or broken document cannot blow the stack

/** Plain text of an ADF document (or of a v2-style string body, returned as is). */
function adfToText(doc) {
  if (doc == null) return ''
  if (typeof doc === 'string') return doc.trim()
  const text = blocks(Array.isArray(doc.content) ? doc.content : [doc], 0)
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Block nodes separated by a blank line. */
function blocks(nodes, depth) {
  const out = []
  for (const n of nodes || []) {
    const t = block(n, depth)
    if (t !== '') out.push(t)
  }
  return out.join('\n\n')
}

function block(n, depth) {
  if (!n || typeof n !== 'object' || depth > MAX_DEPTH) return ''
  const c = Array.isArray(n.content) ? n.content : []
  const a = n.attrs || {}
  switch (n.type) {
    case 'paragraph':
      return inline(c, depth)
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(a.level) || 1))
      return `${'#'.repeat(level)} ${inline(c, depth)}`
    }
    case 'bulletList':
      return list(c, depth, () => '- ')
    case 'orderedList': {
      const start = Number.isInteger(a.order) ? a.order : 1
      return list(c, depth, (i) => `${start + i}. `)
    }
    case 'taskList':
      return list(c, depth, (i, item) => ((item.attrs || {}).state === 'DONE' ? '[x] ' : '[ ] '))
    case 'decisionList':
      return list(c, depth, () => 'Decision: ')
    case 'listItem':
    case 'taskItem':
    case 'decisionItem':
      return itemBody(n, depth)
    case 'codeBlock': {
      const lang = typeof a.language === 'string' && /^[\w+#.-]{1,20}$/.test(a.language) ? a.language : ''
      const code = c.map((t) => (t && typeof t.text === 'string' ? t.text : '')).join('')
      return '```' + lang + '\n' + code.replace(/\n+$/, '') + '\n```'
    }
    case 'blockquote':
      return prefix(blocks(c, depth + 1), '> ')
    case 'rule':
      return '---'
    case 'panel': {
      const kind = typeof a.panelType === 'string' ? a.panelType : 'info'
      return prefix(blocks(c, depth + 1), `[${kind}] `, '  ')
    }
    case 'expand':
    case 'nestedExpand': {
      const title = typeof a.title === 'string' && a.title ? a.title : 'Details'
      return `${title}:\n${prefix(blocks(c, depth + 1), '  ')}`
    }
    case 'table':
      return c.map((row) => tableRow(row, depth)).filter(Boolean).join('\n')
    case 'mediaSingle':
    case 'mediaGroup':
      return c.map((m) => media(m)).filter(Boolean).join('\n')
    case 'media':
      return media(n)
    case 'blockCard':
    case 'embedCard':
      return typeof a.url === 'string' ? a.url : ''
    default:
      // An unknown block: its children as blocks, or as inline text when they are inline.
      if (c.length && c.every((x) => x && INLINE.has(x.type))) return inline(c, depth)
      return blocks(c, depth + 1)
  }
}

const INLINE = new Set(['text', 'hardBreak', 'mention', 'emoji', 'inlineCard', 'status', 'date', 'placeholder', 'mediaInline'])

/** A list's items with their marker; nested lists and further paragraphs indented under them. */
function list(items, depth, marker) {
  return items
    .map((item, i) => {
      const body = block(item, depth + 1)
      const m = marker(i, item || {})
      return m + body.split('\n').join('\n' + ' '.repeat(m.length))
    })
    .join('\n')
}

/** A list item's content: its first paragraph on the marker's line, the rest below it. */
function itemBody(n, depth) {
  const c = Array.isArray(n.content) ? n.content : []
  // taskItem and decisionItem hold inline nodes directly.
  if (c.every((x) => x && INLINE.has(x.type))) return inline(c, depth)
  return c
    .map((x) => block(x, depth + 1))
    .filter((t) => t !== '')
    .join('\n')
}

function tableRow(row, depth) {
  if (!row || !Array.isArray(row.content)) return ''
  return '| ' + row.content.map((cell) => blocks(cell && cell.content, depth + 1).replace(/\n+/g, ' ')).join(' | ') + ' |'
}

function media(m) {
  if (!m || typeof m !== 'object') return ''
  const a = m.attrs || {}
  const name = typeof a.alt === 'string' && a.alt ? a.alt : typeof a.name === 'string' && a.name ? a.name : ''
  return name ? `[attachment: ${name}]` : '[attachment]'
}

function prefix(text, first, rest = first) {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? first : rest) + line)
    .join('\n')
}

/** Inline nodes as one run of text. */
function inline(nodes, depth) {
  let out = ''
  for (const n of nodes || []) {
    if (!n || typeof n !== 'object' || depth > MAX_DEPTH) continue
    const a = n.attrs || {}
    switch (n.type) {
      case 'text':
        out += marks(typeof n.text === 'string' ? n.text : '', n.marks)
        break
      case 'hardBreak':
        out += '\n'
        break
      case 'mention':
        out += mentionText(a)
        break
      case 'emoji':
        out += typeof a.text === 'string' && a.text ? a.text : typeof a.shortName === 'string' ? a.shortName : ''
        break
      case 'inlineCard':
        out += typeof a.url === 'string' ? a.url : ''
        break
      case 'status':
        out += typeof a.text === 'string' ? `[${a.text}]` : ''
        break
      case 'date': {
        const ms = Number(a.timestamp)
        out += Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : ''
        break
      }
      case 'mediaInline':
        out += media(n)
        break
      default:
        if (Array.isArray(n.content)) out += inline(n.content, depth + 1)
    }
  }
  return out
}

/** A text node's marks that change the plain text: code as `x`, a link as `text (url)`. */
function marks(text, list) {
  let t = text
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || typeof m !== 'object') continue
    if (m.type === 'code') t = '`' + t + '`'
    if (m.type === 'link') {
      const href = m.attrs && typeof m.attrs.href === 'string' ? m.attrs.href : ''
      if (href && href !== text) t = `${t} (${href})`
    }
  }
  return t
}

/** `@Name`: Jira keeps the shown text (with its @) in attrs.text; an empty one falls back to the id. */
function mentionText(a) {
  const t = typeof a.text === 'string' ? a.text.trim() : ''
  if (t) return t.startsWith('@') ? t : `@${t}`
  return typeof a.id === 'string' ? `@${a.id}` : '@someone'
}

/** The accountIds mentioned anywhere in an ADF document, each once. */
function mentionIds(doc) {
  const out = new Set()
  const walk = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > MAX_DEPTH) return
    if (Array.isArray(n)) {
      for (const x of n) walk(x, depth + 1)
      return
    }
    if (n.type === 'mention' && n.attrs && typeof n.attrs.id === 'string') out.add(n.attrs.id)
    if (Array.isArray(n.content)) walk(n.content, depth + 1)
  }
  walk(doc, 0)
  return [...out]
}

module.exports = { adfToText, mentionIds }
