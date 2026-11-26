'use strict'
/* global document, ccPanel, ccKit, replyAction, moveOption, keepChoice, commentLength, replyFields, REPLY_MAX_COMMENT */
// The issue window (0.9.0, layout A). The host (dist/host.js, through the kit's makePage) sends this copy
// `cc-kit.init` (its access, the app's word, and its first side tab), then the issue (`cc-kit.state`:
// { key, summary, url, html, assets, reply }), or loading / failed. Its own messages:
//   { type: 'reply', v, own?, comment?, transitionId?, marker, asked, edited, busy, loaded, loadError,
//     status, tone, transitions, max, note }   the one Reply form of the issue (owner and write copies only)
//   { type: 'replyNote', kind, text }         a refused click of this copy; nothing was written
//   { type: 'select', tab }                   a draft or a Reply click: show that tab
// To the host: { type: 'replyOpen' } when Reply shows, { type: 'edit', comment, transitionId } on every change
// the person makes, { type: 'post', comment, transitionId } on the Post click, { type: 'reload' } (Try again),
// { type: 'browser' } (a move that needs fields: open it in Jira).
//
// Never innerHTML: the issue goes through the kit's renderer, every other text through textContent. Nothing is
// sent, posted or opened without a click (no Ctrl/Cmd+Enter for Post: the click is the decision), and an Ask
// answer never fills Reply (only a `reply` message from the host does: replylogic.replyFields).

const $ = (id) => document.getElementById(id)
const main = $('main')
const side = $('side')
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
  for (const k of kids) n.append(k)
  return n
}

let init = { access: 'read', tab: 'ask', features: ccKit.features() }
let mounted = []
let tabs = null
let reply = null // the Reply tab's parts, while drawn
let lastReply = null // the host's last form message (drawn again with each state)
let wanted = null // a tab the host asked for before the tabs were drawn

function reset() {
  for (const m of mounted) m.destroy()
  mounted = []
  tabs = null
  reply = null
  main.replaceChildren()
  side.replaceChildren()
  side.hidden = true
}

ccKit.connect({
  init(info) {
    init = info
  },
  loading() {
    reset()
    main.append(el('p', { class: 'muted' }, 'Loading…'))
  },
  failed(f) {
    reset()
    mounted.push(ccKit.mountError(main, { message: f.message, retry: f.retry }))
  },
  state(s) {
    draw(s)
  },
  message(m) {
    onHost(m)
  },
})

function draw(s) {
  reset()
  if (!s || typeof s !== 'object') return
  const assets = {}
  for (const a of Array.isArray(s.assets) ? s.assets : []) if (a && typeof a.id === 'string') assets[a.id] = a.dataUrl
  const doc = ccKit.renderDocument(main, { html: typeof s.html === 'string' ? s.html : '' }, { assets })
  mounted.push(doc)
  // Notes (D6: at the end of the issue): core's, on an app that has them; a read guest sees them read-only.
  const canWrite = init.access === 'owner' || init.access === 'write'
  const global = ccKit.mountGlobalNote(main, { canWrite })
  const notes = ccKit.mountNotes(main, { canWrite, rendered: doc })
  mounted.push(global, notes)

  // The side column: Ask (owner and write guests, an app with core's Ask) and Reply (the host's `reply` flag).
  const list = []
  let ask = null
  if (canWrite) {
    const pane = el('div')
    ask = ccKit.mountAsk(pane, { about: `About: ${s.key || 'this issue'}`, canContinue: init.access === 'owner' })
    mounted.push(ask)
    if (ask.el) list.push({ id: 'ask', label: 'Ask', panel: pane })
  }
  if (s.reply === true && canWrite) {
    const pane = el('div')
    reply = buildReply(pane, s)
    list.push({ id: 'reply', label: 'Reply', panel: pane })
  }
  if (list.length) {
    side.hidden = false
    const first = wanted || init.tab
    wanted = null
    tabs = ccKit.mountSideTabs(side, {
      tabs: list,
      selected: first,
      onSelect: (id) => {
        if (id === 'reply') ccPanel.post({ type: 'replyOpen' })
      },
    })
    mounted.push(tabs)
  }
  if (reply && lastReply) drawReply(lastReply)

  const actions = []
  if (canWrite && notes.el) actions.push({ id: 'note', label: 'Note', run: (sel) => notes.compose(sel) })
  if (ask && ask.el) {
    actions.push({
      id: 'ask',
      label: 'Ask about this',
      run: (sel) => {
        if (tabs) tabs.select('ask')
        ask.setQuote(sel.text)
        ask.focus()
      },
    })
  }
  if (actions.length) mounted.push(ccKit.mountSelectionMenu(doc, { actions }))
}

function onHost(m) {
  if (!m || typeof m !== 'object') return
  if (m.type === 'reply') {
    lastReply = m
    if (reply) drawReply(m)
  } else if (m.type === 'replyNote' && reply) {
    line(reply.message, typeof m.text === 'string' ? m.text : '', 'error')
  } else if (m.type === 'select' && typeof m.tab === 'string') {
    // The tabs' onSelect tells the host when Reply shows (replyOpen).
    if (tabs && tabs.selected() !== m.tab) tabs.select(m.tab)
    else if (!tabs) wanted = m.tab
  }
}

// ---- Reply ----

function line(n, text, kind) {
  n.textContent = text || ''
  n.hidden = !text
  n.className = `line${kind ? ` ${kind}` : ''}`
}

function buildReply(pane, s) {
  const r = {}
  r.loading = el('p', { class: 'muted' }, 'Reading the issue…')
  r.failed = el('p', { class: 'line error', hidden: '' })
  r.retry = el('button', { type: 'button', hidden: '' }, 'Try again')
  r.status = el('span', { class: 'lozenge' })
  r.marker = el('p', { class: 'marker', hidden: '' })
  r.asked = el('p', { class: 'line info', hidden: '' })
  r.message = el('p', { class: 'line', hidden: '' })
  r.steps = el('ul', { class: 'steps', hidden: '' })
  r.move = el('select', { id: 'move' })
  r.openJira = el('button', { type: 'button', class: 'link' }, 'open it in Jira')
  r.needsFields = el('span', { class: 'help', hidden: '' }, 'A move marked "needs fields" asks for more than a status (a resolution, a field): ', r.openJira, '.')
  r.noMoves = el('span', { class: 'help', hidden: '' }, 'No status change is possible from here.')
  r.comment = el('textarea', { id: 'comment', class: 'reply', spellcheck: 'true', placeholder: 'Plain text. A blank line starts a new paragraph.' })
  r.count = el('span', { class: 'count' })
  r.send = el('button', { type: 'button', class: 'primary', disabled: '' }, 'Post comment')
  r.form = el(
    'div',
    { hidden: '' },
    el('div', { class: 'head' }, el('span', { class: 'muted' }, s.key || ''), r.status),
    r.marker,
    r.asked,
    r.message,
    r.steps,
    el('div', { class: 'field' }, el('label', { for: 'move' }, 'Move to'), r.move, r.needsFields, r.noMoves),
    el('div', { class: 'field' }, el('label', { for: 'comment' }, 'Comment'), r.comment, el('span', { class: 'help' }, 'Plain text: a blank line starts a paragraph, no formatting and no mentions. ', r.count)),
    el('div', { class: 'actions' }, r.send)
  )
  pane.append(r.loading, r.failed, r.retry, r.form)
  r.max = REPLY_MAX_COMMENT
  r.busy = false
  r.transitions = []
  const edited = () => {
    refresh(r)
    ccPanel.post({ type: 'edit', comment: r.comment.value, transitionId: r.move.value })
  }
  r.comment.addEventListener('input', edited)
  r.move.addEventListener('change', edited)
  r.send.addEventListener('click', () => {
    if (!r.busy) ccPanel.post({ type: 'post', comment: r.comment.value, transitionId: r.move.value })
  })
  r.openJira.addEventListener('click', () => ccPanel.post({ type: 'browser' }))
  r.retry.addEventListener('click', () => {
    r.loading.hidden = false
    r.failed.hidden = true
    r.retry.hidden = true
    ccPanel.post({ type: 'reload' })
  })
  return r
}

function drawTransitions(r, list, keep) {
  r.transitions = Array.isArray(list) ? list : []
  const keepOpt = el('option', { value: '' }, 'Keep status')
  r.move.replaceChildren(keepOpt)
  for (const t of r.transitions) {
    const o = moveOption(t)
    const n = el('option', { value: o.value }, o.text)
    n.disabled = o.disabled
    r.move.append(n)
  }
  r.move.value = keepChoice(r.transitions, keep)
  r.needsFields.hidden = !r.transitions.some((t) => !t.enabled)
  r.noMoves.hidden = r.transitions.some((t) => t.enabled)
}

function drawSteps(r, steps) {
  r.steps.replaceChildren()
  for (const s of Array.isArray(steps) ? steps : []) {
    const mark = el('span', { class: 'mark' }, s.ok ? '✓' : '✗')
    const what = s.step === 'comment' ? (s.ok ? 'Comment posted' : `Comment not posted: ${s.message || ''}`) : s.ok ? `Moved to ${s.to}` : `Not moved${s.to ? ` to ${s.to}` : ''}: ${s.message || ''}`
    r.steps.append(el('li', {}, mark, what))
  }
  r.steps.hidden = !r.steps.children.length
}

function refresh(r) {
  const n = commentLength(r.comment.value)
  r.count.textContent = `${n.toLocaleString('en-US')} / ${r.max.toLocaleString('en-US')}`
  r.count.classList.toggle('over', n > r.max)
  const a = replyAction(r.comment.value, r.move.value)
  r.send.textContent = a.label
  r.send.disabled = a.disabled || r.busy
}

function drawReply(m) {
  const r = reply
  if (Number.isInteger(m.max) && m.max > 0) r.max = Math.min(m.max, REPLY_MAX_COMMENT)
  if (m.loadError && !m.loaded) {
    r.loading.hidden = true
    line(r.failed, `Could not read the issue from Jira: ${m.loadError}`, 'error')
    r.retry.hidden = false
    r.form.hidden = true
    return
  }
  if (!m.loaded) return
  r.loading.hidden = true
  r.failed.hidden = true
  r.retry.hidden = true
  r.form.hidden = false
  r.status.textContent = m.status || ''
  r.status.className = `lozenge${m.tone && m.tone !== 'neutral' ? ` lozenge-${m.tone}` : ''}`
  const f = replyFields(m)
  drawTransitions(r, m.transitions, f ? f.transitionId : r.move.value)
  if (f && r.comment.value !== f.comment) r.comment.value = f.comment
  // "✎ Draft from Claude": a framed line with a bold word, set as text.
  r.marker.replaceChildren()
  if (m.marker) r.marker.append(el('strong', {}, '✎ '), m.marker)
  r.marker.hidden = !m.marker
  line(r.asked, m.asked || '', 'info')
  const note = m.note && typeof m.note === 'object' ? m.note : null
  line(r.message, note ? note.text : m.loadError ? `Could not read the issue from Jira: ${m.loadError}` : '', note && note.kind === 'info' ? 'info' : 'error')
  drawSteps(r, note && note.steps)
  r.busy = m.busy === true
  r.comment.readOnly = r.busy
  r.move.disabled = r.busy
  refresh(r)
}
