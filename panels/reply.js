'use strict'
// The reply page. Messages from the host:
//   { type: 'issue', key, summary, status, tone, transitions, toolbar, max, fill?, keep? }
//       the issue as read just now; `fill` (a draft, or the empty form of a Reply click) replaces the
//       fields unless the person typed since the last fill, and is answered { type: 'filled', n, applied }
//   { type: 'loadError', message }         the read failed: the error and Try again
//   { type: 'collect', n }                 the toolbar's button was clicked: answer { type: 'values', n, comment, transitionId }
//   { type: 'busy', on }                   a write is under way: the fields are locked
//   { type: 'error', message }             a refusal or a failure; nothing more happened
//   { type: 'transitions', status, tone, transitions, keep, message }   the issue moved meanwhile: nothing was written
//   { type: 'result', steps, lines, clearComment, status, tone, transitions, keep }   a write that did not fully succeed
// To the host: { type: 'edit', comment, transitionId } on every change the person makes (it marks
// the page edited, so a new draft from ccc never replaces their words), { type: 'submit', ... } from
// this page's own button (only on an app without toolbar buttons), { type: 'browser' }, { type: 'reload' }.
//
// No keyboard shortcut sends (no Ctrl/Cmd+Enter): the click is the decision.

const $ = (id) => document.getElementById(id)
const comment = $('comment')
const move = $('move')

let toolbar = true
let max = REPLY_MAX_COMMENT
let dirty = false // the person typed or chose since the last fill
let busy = false
let drawn = false
let transitions = []

const post = (m) => ccPanel.post(m)

function show(which) {
  $('loading').hidden = which !== 'loading'
  $('failed').hidden = which !== 'failed'
  $('form').hidden = which !== 'form'
}

function ready() {
  if (drawn) return
  drawn = true
  if (typeof ccPanel.ready === 'function') ccPanel.ready()
}

function line(id, text, kind) {
  const n = $(id)
  n.textContent = text || ''
  n.hidden = !text
  if (kind) n.className = `line ${kind}`
}

function drawStatus(status, tone) {
  const n = $('status')
  n.textContent = status || ''
  n.hidden = !status
  n.className = `lozenge${tone && tone !== 'neutral' ? ` lozenge-${tone}` : ''}`
}

function drawTransitions(list, keep) {
  transitions = Array.isArray(list) ? list : []
  const keepOpt = document.createElement('option')
  keepOpt.value = ''
  keepOpt.textContent = 'Keep status'
  move.replaceChildren(keepOpt)
  for (const t of transitions) {
    const o = moveOption(t)
    const n = document.createElement('option')
    n.value = o.value
    n.textContent = o.text
    n.disabled = o.disabled
    move.append(n)
  }
  move.value = keepChoice(transitions, keep)
  $('needsFields').hidden = !transitions.some((t) => !t.enabled)
  $('noMoves').hidden = transitions.some((t) => t.enabled)
}

function drawSteps(steps) {
  const ul = $('steps')
  ul.replaceChildren()
  for (const s of steps || []) {
    const li = document.createElement('li')
    const mark = document.createElement('span')
    mark.className = `mark${s.ok ? '' : ' fail'}`
    mark.textContent = s.ok ? '✓' : '✗'
    const what = s.step === 'comment' ? (s.ok ? 'Comment posted' : `Comment not posted: ${s.message || ''}`) : s.ok ? `Moved to ${s.to}` : `Not moved${s.to ? ` to ${s.to}` : ''}: ${s.message || ''}`
    li.append(mark, document.createTextNode(what))
    ul.append(li)
  }
  ul.hidden = !ul.children.length
}

function refresh() {
  const n = commentLength(comment.value)
  const c = $('count')
  c.textContent = `${n.toLocaleString('en-US')} / ${max.toLocaleString('en-US')}`
  c.classList.toggle('over', n > max)
  const a = replyAction(comment.value, move.value)
  $('send').textContent = a.label
  $('send').disabled = a.disabled || busy
}

function edited() {
  dirty = true
  refresh()
  post({ type: 'edit', comment: comment.value, transitionId: move.value })
}

comment.addEventListener('input', edited)
move.addEventListener('change', edited)
$('send').addEventListener('click', () => {
  if (!busy) post({ type: 'submit', comment: comment.value, transitionId: move.value })
})
$('openJira').addEventListener('click', () => post({ type: 'browser' }))
$('retry').addEventListener('click', () => {
  show('loading')
  post({ type: 'reload' })
})

ccPanel.onMessage((m) => {
  if (!m || typeof m !== 'object') return
  switch (m.type) {
    case 'issue': {
      toolbar = m.toolbar !== false
      if (Number.isInteger(m.max) && m.max > 0) max = Math.min(m.max, REPLY_MAX_COMMENT)
      $('own').hidden = toolbar
      $('key').textContent = m.key || ''
      $('summary').textContent = m.summary || ''
      document.title = `Reply to ${m.key}`
      drawStatus(m.status, m.tone)
      const f = m.fill && typeof m.fill === 'object' ? m.fill : null
      // A fill over words the person typed since the last one (a draft racing their typing) is not
      // applied: their text stays and the host hears so.
      const apply = f && !(drawn && dirty)
      drawTransitions(m.transitions, apply ? f.transitionId : f ? move.value : m.keep)
      if (apply) {
        comment.value = typeof f.comment === 'string' ? f.comment : ''
        dirty = false
        line('marker', f.marker || '')
        line('asked', f.asked || '', 'info')
        line('message', '')
        drawSteps([])
      }
      if (f && Number.isInteger(f.n)) post({ type: 'filled', n: f.n, applied: Boolean(apply) })
      show('form')
      refresh()
      ready()
      return
    }
    case 'loadError':
      $('failedText').textContent = `Could not read ${m.key || 'the issue'} from Jira: ${m.message || ''}`
      // A page that already drew the issue keeps it (and the person's words); the error goes above.
      if (drawn && !$('form').hidden) line('message', $('failedText').textContent, 'error')
      else show('failed')
      ready()
      return
    case 'collect':
      if (Number.isInteger(m.n)) post({ type: 'values', n: m.n, comment: comment.value, transitionId: move.value })
      return
    case 'busy':
      busy = Boolean(m.on)
      comment.readOnly = busy
      move.disabled = busy
      if (busy) line('message', 'Writing to Jira…', 'info')
      else if ($('message').textContent === 'Writing to Jira…') line('message', '')
      refresh()
      return
    case 'error':
      line('message', m.message || 'Something went wrong; nothing was written.', 'error')
      return
    case 'transitions':
      drawStatus(m.status, m.tone)
      drawTransitions(m.transitions, m.keep)
      line('message', m.message || 'The issue changed meanwhile; nothing was written. Choose again.', 'error')
      refresh()
      return
    case 'result':
      // Not reached on a full success (the host closes the page); a posted comment is cleared, the
      // status choice stays for a retry.
      drawSteps(m.steps)
      if (m.clearComment) comment.value = ''
      if (typeof m.status === 'string') drawStatus(m.status, m.tone)
      if (Array.isArray(m.transitions)) drawTransitions(m.transitions, m.keep)
      line('message', '')
      refresh()
      return
  }
})
