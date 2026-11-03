'use strict'
// The Jira panel: lanes of issues as the host sends them (`{ type: 'state', ... }`), actions
// posted back as `{ type, key }`. The page keeps no data of its own (an opaque origin has no
// storage) except which row's Wrong? chooser is open. Every text from Jira goes in through
// textContent, never as markup: an issue summary is untrusted.
//
// A click on a row (or Enter on a focused row) opens the issue; the other actions are small
// buttons shown on hover or focus (rowlogic.js, loaded before this file, decides which).

let state = null
let wrongOpen = null // the key whose Wrong? chooser is shown

const $ = (id) => document.getElementById(id)

function el(tag, props, ...children) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k === 'onclick') n.addEventListener('click', v)
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children) if (c) n.append(c)
  return n
}

function button(label, onclick, title, cls) {
  return el('button', { type: 'button', title, class: cls, onclick: (ev) => { ev.stopPropagation(); onclick() } }, label)
}

const post = (type, extra) => ccPanel.post({ type, ...extra })

function ago(ms) {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

function notice(text, kind, extra) {
  const box = el('div', { class: `notice ${kind || ''}` })
  const body = el('div', { class: 'text' })
  body.textContent = text
  if (extra) body.append(extra)
  box.append(body)
  return box
}

function renderNotices() {
  const box = $('notices')
  box.replaceChildren()
  if (!state.ready) {
    const lines = [...state.missing, ...state.problems]
    box.append(notice(`Jira is not configured yet.\n${lines.join('\n')}`, 'info'))
    return
  }
  if (state.choose) {
    const tabs = el('div', { class: 'tabs' })
    for (const t of state.choose.tabs) tabs.append(button(t.label, () => post('discuss', { key: state.choose.key, tabId: t.tabId }), `status: ${t.status}`))
    tabs.append(button('Cancel', () => post('dismiss')))
    box.append(notice(`Discuss ${state.choose.key} in which Claude tab?`, 'info', tabs))
  }
  if (state.notice) {
    const n = notice(state.notice.text, state.notice.kind === 'error' ? '' : 'info')
    n.append(button('✕', () => post('dismiss'), 'Dismiss'))
    box.append(n)
  }
  if (state.error) box.append(notice(state.error))
  for (const [lane, msg] of Object.entries(state.laneErrors || {})) box.append(notice(`${lane}: ${msg}`))
  if (!state.triage.on) box.append(notice('Triage is off: the lanes are not sorted. Install and enable Jev triage (bronos.jev-triage) in this project.', 'info'))
  else if (state.triage.error) box.append(notice(`Triage: ${state.triage.error}`))
  if (state.deferred) box.append(notice(`${state.deferred} issues are still being read; the next polls bring them.`, 'info'))
}

function dot(verdict) {
  if (!verdict) return el('span', { class: 'dot none' })
  const low = typeof verdict.confidence === 'number' && verdict.confidence < 0.5
  const title = `${verdict.priority}${verdict.kind ? ` / ${verdict.kind}` : ''} (${verdict.by || '?'}${typeof verdict.confidence === 'number' ? `, ${verdict.confidence.toFixed(2)}` : ''})`
  return el('span', { class: `dot p-${verdict.priority}${low ? ' low' : ''}`, title })
}

function rowActions(r) {
  const a = el('div', { class: 'actions' })
  for (const b of rowButtons(r, { triageOn: state.triage.on })) {
    const onclick = b.action === 'wrong' ? () => { wrongOpen = wrongOpen === r.key ? null : r.key; render() } : () => post(b.action, { key: r.key })
    const n = button(b.label, onclick, b.title)
    n.dataset.action = b.action
    n.setAttribute('aria-label', `${b.title}: ${r.key}`)
    a.append(n)
  }
  return a
}

function openRow(key) {
  post('open', { key })
}

/** The rows in page order (for the arrow keys). */
function rowEls() {
  return [...document.querySelectorAll('li.row')]
}

function onRowKey(ev, r, li) {
  const act = rowKeyAction(ev.key, ev.target === li, { alt: ev.altKey, ctrl: ev.ctrlKey, meta: ev.metaKey })
  if (!act) return
  ev.preventDefault()
  if (act === 'open') return openRow(r.key)
  const rows = rowEls()
  const to = moveIndex(act, rows.indexOf(li), rows.length)
  if (to !== null) rows[to].focus()
}

function wrongBox(r) {
  const w = el('div', { class: 'wrong' })
  w.append(el('span', { class: 'muted', text: 'Should be:' }))
  for (const p of ['urgent', 'action', 'fyi', 'noise']) {
    w.append(button(p, () => { wrongOpen = null; post('wrong', { key: r.key, priority: p }) }, `Store a correction: ${p}`))
  }
  if (r.verdict && r.verdict.by === 'override') w.append(button('Undo', () => { wrongOpen = null; post('undoWrong', { key: r.key }) }, 'Forget your correction'))
  w.append(el('span', { class: 'muted', text: 'A note for the eval: Wrong? in the Jev triage panel.' }))
  return w
}

function renderRow(r) {
  const li = el('li', {
    class: `row${r.unread ? ' unread' : ''}`,
    tabindex: '0',
    'aria-label': `${r.key}: ${r.summary}${r.unread ? ' (unread)' : ''}. Enter opens it.`,
    title: `${r.summary}\nClick to open${state.annotate ? ' (notes, Discuss, New session)' : ''}`,
  })
  li.dataset.key = r.key
  li.addEventListener('click', (ev) => {
    const inControl = Boolean(ev.target.closest && ev.target.closest('button, .wrong'))
    const sel = window.getSelection && window.getSelection()
    if (rowClickOpens(inControl, Boolean(sel && !sel.isCollapsed && li.contains(sel.anchorNode)))) openRow(r.key)
  })
  li.addEventListener('keydown', (ev) => onRowKey(ev, r, li))
  const line = el('div', { class: 'line' })
  line.append(dot(r.verdict), el('span', { class: 'key', text: r.key }), el('span', { class: 'summary', text: r.summary }))
  if (r.unread) line.append(el('span', { class: 'new', text: r.newCount > 1 ? `${r.newCount} new` : 'new', title: 'Unread: activity of others since you last looked' }))
  li.append(line)
  const sub = el('div', { class: 'sub' })
  sub.append(el('span', { text: r.status }))
  if (r.priority) sub.append(el('span', { text: r.priority }))
  if (r.who) sub.append(el('span', { class: 'who', text: r.who }))
  li.append(sub)
  li.append(rowActions(r))
  if (wrongOpen === r.key) li.append(wrongBox(r))
  return li
}

function renderLanes() {
  const box = $('lanes')
  box.replaceChildren()
  if (!state.ready) return
  if (!state.lastPoll) {
    box.append(el('p', { class: 'empty', text: state.polling ? 'Reading your issues…' : 'No poll yet.' }))
    return
  }
  for (const lane of state.lanes) {
    const s = el('section')
    const unread = lane.id === 'done' ? 0 : lane.rows.filter((r) => r.unread).length
    const head = el('button', { type: 'button', class: 'lane-head', 'aria-expanded': String(!lane.collapsed), onclick: () => post('toggle', { lane: lane.id }) })
    head.append(el('span', { class: 'chev', text: lane.collapsed ? '▸' : '▾' }), el('span', { text: lane.title }), el('span', { class: 'count', text: `${lane.total}${unread ? ` · ${unread} new` : ''}` }))
    s.append(head)
    if (!lane.collapsed) {
      if (!lane.rows.length) s.append(el('p', { class: 'empty', text: 'Nothing here.' }))
      const ul = el('ul')
      for (const r of lane.rows) ul.append(renderRow(r))
      s.append(ul)
      if (lane.total > lane.rows.length) s.append(el('p', { class: 'empty', text: `${lane.total - lane.rows.length} more not shown.` }))
    }
    box.append(s)
  }
  if (!state.lanes.length) box.append(el('p', { class: 'empty', text: 'Every lane is off (the lanes setting).' }))
}

/**
 * Where the keyboard focus is, as `{ key, action }`, so a redraw (every state message replaces the
 * rows) can put it back: without this every poll would throw a keyboard user out of the list.
 */
function focusSpot() {
  const a = document.activeElement
  if (!a || a === document.body) return null
  const row = a.closest && a.closest('li.row')
  if (!row) return null
  return { key: row.dataset.key, action: a === row ? null : a.dataset.action || null }
}

function restoreFocus(spot) {
  if (!spot) return
  const row = rowEls().find((x) => x.dataset.key === spot.key)
  if (!row) return
  const target = spot.action ? row.querySelector(`button[data-action="${spot.action}"]`) : null
  ;(target || row).focus({ preventScroll: true })
}

function render() {
  if (!state) return
  const spot = focusSpot()
  const who = state.account ? ` · ${state.account}` : ''
  $('meta').textContent = state.ready ? `${state.polling ? 'polling… · ' : ''}${ago(state.lastPoll)}${who}` : ''
  $('meta').title = state.site || ''
  $('refresh').disabled = !state.ready || state.polling
  renderNotices()
  renderLanes()
  restoreFocus(spot)
}

ccPanel.onMessage((m) => {
  if (!m || m.type !== 'state') return
  state = m
  render()
})
$('refresh').addEventListener('click', () => post('refresh'))
// The "last poll" age goes stale while nothing arrives: redraw it once a minute.
setInterval(() => state && ($('meta').textContent = state.ready ? `${state.polling ? 'polling… · ' : ''}${ago(state.lastPoll)}${state.account ? ` · ${state.account}` : ''}` : ''), 60000)
post('hello')
