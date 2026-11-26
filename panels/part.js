'use strict'
/* global document, ccKit, ccPanel */
// The part page: { key, summary, status, tone, priority, type, assignee, url, canOpen } from the host (the kit's
// makePage; `canOpen` is the owner's copy, the app's word). Every text goes in through textContent. Open issue
// posts { type: 'open' } (the host opens the issue's window for the owner only); the link to Jira goes through
// the kit (the host opens only the URL it sent). Nothing is posted without a click.

const root = document.getElementById('part')
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
  for (const k of kids) n.append(k)
  return n
}
let mounted = null

function clear() {
  if (mounted) mounted.destroy()
  mounted = null
  root.replaceChildren()
}

ccKit.connect({
  loading() {
    clear()
    root.append(el('p', { class: 'muted' }, 'Loading…'))
  },
  failed(f) {
    clear()
    mounted = ccKit.mountError(root, { message: f.message, retry: f.retry })
  },
  state(s) {
    clear()
    if (!s || typeof s !== 'object') return
    const str = (v) => (typeof v === 'string' ? v : '')
    const status = el('span', { class: `lozenge${s.tone && s.tone !== 'neutral' ? ` lozenge-${s.tone}` : ''}` }, str(s.status))
    const facts = [str(s.type), str(s.priority) && `Priority ${str(s.priority)}`, str(s.assignee) ? `Assignee ${str(s.assignee)}` : 'Unassigned'].filter(Boolean).join(' · ')
    const actions = el('div', { class: 'actions' })
    if (s.canOpen === true) {
      const open = el('button', { type: 'button', class: 'primary' }, 'Open issue')
      open.addEventListener('click', () => ccPanel.post({ type: 'open' }))
      actions.append(open)
    }
    if (str(s.url)) {
      const link = el('button', { type: 'button', class: 'link' }, 'Open in Jira ↗')
      link.addEventListener('click', () => ccKit.postLink(str(s.url)))
      actions.append(link)
    }
    root.append(el('div', { class: 'row' }, el('span', { class: 'key' }, str(s.key)), status), el('h1', {}, str(s.summary)), el('p', { class: 'muted' }, facts), actions)
  },
})
