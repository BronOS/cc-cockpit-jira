'use strict'
// Writing to Jira (0.8.0, design "Writing to Jira"): the pure parts. The client (lib/client.js)
// sends; the host (dist/host.js) wires these to the issue window's Reply tab and
// `ccc jira update`.
//
// Why so little: a comment and a status change, nothing else (Left out: fields, assignee, mentions,
// restricted comments, a transition's own fields). Issue text reaches Claude (Discuss, `ccc jira
// show`, triage), so a description can say "close this ticket"; the `writes` setting, read on every
// call in the host, decides whether `ccc jira update` writes or only drafts for the person. Not a
// boundary (Claude runs as the person's OS user); it keeps a prompt-injected Claude from writing to
// Jira unseen.

const { cut, oneLine } = require('./util')

// Jira's own limit is 32,767 characters; a little below it so the ADF wrapping never tips it over.
const MAX_COMMENT = 32000
const MAX_TRANSITIONS = 50
const WRITE_MODES = ['draft', 'direct', 'off']

// Characters Jira's ADF validator refuses or that mean nothing in a comment: C0 controls but tab and
// newline, and DEL. Dropped rather than refused: they come from a terminal paste, not from intent.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/** The comment as the person or `ccc` gave it, normalised: CRLF to LF, controls dropped. */
function normaliseComment(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(CONTROL, '')
}

/**
 * Whether a comment can be posted: `{ text }` (normalised) or `{ error }`. Empty (only white space)
 * is not a comment; over MAX_COMMENT is refused before the call, never cut (a cut comment says
 * something the person did not write).
 */
function checkComment(text) {
  const t = normaliseComment(text)
  if (!t.trim()) return { error: 'the comment is empty' }
  if (t.length > MAX_COMMENT) return { error: `the comment is ${t.length} characters; at most ${MAX_COMMENT.toLocaleString('en-US')}` }
  return { text: t }
}

/**
 * Plain text as an ADF document: a blank line (white space only counts as blank) starts a
 * paragraph, a single newline is a hardBreak. Nothing is parsed as markup (an asterisk stays an
 * asterisk) and there are no mentions (they need account ids). Leading and trailing blank lines go;
 * spaces inside a line stay as typed.
 */
function commentAdf(text) {
  const t = normaliseComment(text)
  const content = []
  for (const block of t.split(/\n(?:[ \t]*\n)+/)) {
    const para = block.replace(/^\n+|\n+$/g, '')
    if (!para.trim()) continue
    const nodes = []
    para.split('\n').forEach((line, i) => {
      if (i > 0) nodes.push({ type: 'hardBreak' })
      // ADF refuses an empty text node.
      if (line) nodes.push({ type: 'text', text: line })
    })
    content.push({ type: 'paragraph', content: nodes })
  }
  return { type: 'doc', version: 1, content }
}

/** Jira's status category key as the lozenge tone the issue view uses (document.js statusTone). */
function toneOf(category) {
  if (category === 'done') return 'success'
  if (category === 'indeterminate') return 'info'
  return 'neutral'
}

/**
 * The transitions of `GET .../transitions?expand=transitions.fields` as kept: `{ id, name, to,
 * category, enabled, why }`, in Jira's order. A transition with a required field that has no
 * default (a resolution screen) is listed but disabled ("needs fields: open in Jira"): the plugin
 * sends only `{ transition: { id } }` and would get a 400. `isAvailable: false` (a condition fails)
 * is disabled too. The id goes into a request body only, but still digits only, as Jira makes them.
 */
function parseTransitions(body) {
  const list = body && Array.isArray(body.transitions) ? body.transitions : []
  const out = []
  for (const t of list) {
    if (!t || typeof t !== 'object') continue
    const id = String(t.id == null ? '' : t.id)
    if (!/^[0-9]{1,10}$/.test(id)) continue
    const name = cut(oneLine(typeof t.name === 'string' ? t.name : ''), 100)
    if (!name) continue
    const to = t.to && typeof t.to === 'object' ? t.to : {}
    const toName = cut(oneLine(typeof to.name === 'string' ? to.name : ''), 100)
    const cat = to.statusCategory && typeof to.statusCategory.key === 'string' ? to.statusCategory.key : ''
    const fields = t.fields && typeof t.fields === 'object' ? t.fields : {}
    const needs = Object.entries(fields)
      .filter(([, f]) => f && typeof f === 'object' && f.required === true && f.hasDefaultValue !== true)
      .map(([k, f]) => cut(oneLine(typeof f.name === 'string' && f.name ? f.name : k), 60))
    const available = t.isAvailable !== false
    const enabled = available && needs.length === 0
    out.push({
      id,
      name,
      to: toName,
      category: cat === 'indeterminate' || cat === 'done' ? cat : 'new',
      enabled,
      why: !available ? 'not possible now' : needs.length ? 'needs fields: open in Jira' : '',
      ...(needs.length ? { needs: needs.slice(0, 10) } : {}),
    })
    if (out.length >= MAX_TRANSITIONS) break
  }
  return out
}

/** How a transition reads in a list: its name, the target status when that differs. */
function transitionText(t) {
  return t.to && t.to.toLowerCase() !== t.name.toLowerCase() ? `${t.name} (to ${t.to})` : t.name
}

/** The enabled transitions as one line for a message: `Start progress (to In Progress), Done`. */
function possibleText(transitions) {
  const ok = transitions.filter((t) => t.enabled)
  return ok.length ? ok.map(transitionText).join(', ') : 'none from this status'
}

/**
 * The transition `ccc jira update --status <name>` means: by transition name first, then by target
 * status name, case-insensitive, an enabled one winning. `{ transition }`, `{ disabled }` (it exists
 * but needs fields or a condition fails) or `{ none: true }`.
 */
function matchStatus(transitions, wanted) {
  const w = oneLine(wanted).toLowerCase()
  if (!w) return { none: true }
  const byName = transitions.filter((t) => t.name.toLowerCase() === w)
  const byTo = transitions.filter((t) => t.to.toLowerCase() === w)
  const hit = [...byName, ...byTo].find((t) => t.enabled)
  if (hit) return { transition: hit }
  const off = byName[0] || byTo[0]
  return off ? { disabled: off } : { none: true }
}

/** Why a status cannot be used, for the page's line and the CLI's answer. */
function statusProblem(match, wanted, transitions) {
  const asked = cut(oneLine(wanted), 100)
  if (match.disabled) return `"${asked}" is not possible from here (${transitionText(match.disabled)}: ${match.disabled.why}). Possible: ${possibleText(transitions)}.`
  return `no transition or status "${asked}" from the current status. Possible: ${possibleText(transitions)}.`
}

/** The `writes` setting as one of WRITE_MODES; anything unknown is the default, draft (it writes nothing by itself). */
function writeMode(value) {
  return WRITE_MODES.includes(value) ? value : 'draft'
}

const OFF_MESSAGE = 'writing is off for this project (setting: What ccc jira update does)'

/**
 * What `ccc jira update` does under the setting: `{ refuse }` with the message, or `{ mode }`
 * ('draft' or 'direct'). Read on every call (a settings change applies to the next call), whoever
 * the caller is: a Claude tab, the person's shell, a script.
 */
function updatePlan(mode, { comment, status }) {
  if (writeMode(mode) === 'off') return { refuse: OFF_MESSAGE }
  if (!status && !comment) return { usage: 'give a comment on stdin (-), a --status, or both' }
  return { mode: writeMode(mode) }
}

/**
 * A new draft (`ccc jira update` in draft mode) for an issue whose Reply form (host.js `forms`) may
 * exist: 'open' (none does), 'replace' (it does, nobody typed in it), or 'refuse' (a copy edited it,
 * or a Post is under way: their words are never overwritten by a draft).
 */
function draftDecision(page) {
  if (!page) return 'open'
  if (page.edited || page.busy) return 'refuse'
  return 'replace'
}

/**
 * Whether a click or a page message may write: the owner, or a write guest. `from` is the app's
 * word (the connection main bound, never the page). Fail closed (0.9.0): a missing `from` refuses,
 * as does one without a known access; 0.9.0 needs an app that sends it (overlays in every view).
 */
function mayWrite(from) {
  return Boolean(from) && typeof from === 'object' && (from.access === 'owner' || from.access === 'write')
}

/** Jira's `{ key, fields }` header (client.issueHeader) as `{ status, category }`. */
function statusOfHead(head) {
  const st = head && head.fields && head.fields.status
  return { status: st && typeof st.name === 'string' ? st.name : '', category: (st && st.statusCategory && st.statusCategory.key) || '' }
}

const sameStatus = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

/**
 * One write: the comment, then the transition (so a comment explaining a move is never missing
 * after it), each step reported on its own.
 *
 * - With a transition the transitions and the status are read first (the transitions skipped when
 *   `fresh` ones are given, read just now by the caller): when the chosen transition is gone or
 *   disabled, or the status is not the one the person saw (`expectStatus`), nothing is written, the
 *   comment neither (`moved: true`, with the fresh list).
 * - After a posted comment, both are read again right before the move (review R1-3): a comment can
 *   move the issue itself (an automation rule sending it to Blocked), and the saved move would
 *   override that. Changed: the comment is reported posted and the move is refused.
 * - `guard()` runs right before each POST (review R1-2): a message there (writing switched off, the
 *   site, account or token changed while the reads were under way) stops the write at that point.
 *
 * @param {object} o
 * @param {{ comment: Function, transitions: Function, transition: Function, issueHeader?: Function }} o.client
 * @param {string} o.key
 * @param {string} [o.comment] checked by checkComment already
 * @param {string} [o.transitionId]
 * @param {string} [o.expectStatus] the status the page showed
 * @param {object[]} [o.fresh] transitions read by the caller for this very write
 * @param {() => string|null} [o.guard] why not to send now, or null
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{ ok: boolean, steps: { step: 'comment'|'transition', ok: boolean, message?: string, to?: string }[], moved?: boolean, transitions?: object[], status?: string, category?: string, error?: string }>}
 */
async function performWrite(o) {
  const { client, key, comment, transitionId, signal } = o
  const guard = () => (o.guard ? o.guard() : null)
  const steps = []
  let chosen = null
  let transitions = null
  let status
  let category
  const readBoth = (useFresh) =>
    Promise.all([useFresh && o.fresh ? o.fresh : client.transitions(key, signal), client.issueHeader ? client.issueHeader(key, signal) : null])
  if (transitionId) {
    try {
      const [list, head] = await readBoth(true)
      transitions = list
      if (head) ({ status, category } = statusOfHead(head))
    } catch (e) {
      return { ok: false, steps, error: `could not read the possible moves again, so nothing was written: ${msg(e)}` }
    }
    chosen = transitions.find((t) => t.id === transitionId && t.enabled) || null
    const statusMoved = status !== undefined && o.expectStatus !== undefined && !sameStatus(status, o.expectStatus)
    if (!chosen || statusMoved) {
      return { ok: false, steps, moved: true, transitions, ...(status !== undefined ? { status, category } : {}), error: `${key} changed meanwhile${statusMoved ? ` (its status is now ${status})` : ''}: that move is not possible any more, so nothing was written. Choose again.` }
    }
  }
  const target = chosen ? chosen.to || chosen.name : ''
  if (comment) {
    const stop = guard()
    if (stop) return { ok: false, steps, error: `${stop}; nothing was written` }
    try {
      // The guard again inside the client, after its token-kind read (review R2-2).
      await client.comment(key, comment, signal, { guard: o.guard })
      steps.push({ step: 'comment', ok: true })
    } catch (e) {
      if (e && e.kind === 'stopped') return { ok: false, steps, error: `${e.message}; nothing was written` }
      steps.push({ step: 'comment', ok: false, message: msg(e) })
      // No move after a failed comment: the comment that explains it would be missing.
      if (chosen) steps.push({ step: 'transition', ok: false, message: 'not tried: the comment failed' })
      return { ok: false, steps, ...(transitions ? { transitions } : {}) }
    }
    if (chosen) {
      let changed = ''
      try {
        const [list, head] = await readBoth(false)
        transitions = list
        const before = status
        if (head) ({ status, category } = statusOfHead(head))
        if (before !== undefined && status !== undefined && !sameStatus(status, before)) changed = `${key} changed after the comment (its status is now ${status})`
        else if (!list.some((t) => t.id === chosen.id && t.enabled)) changed = `${key} changed after the comment (that move is not possible any more)`
      } catch (e) {
        changed = `could not check ${key} again after the comment: ${msg(e)}`
      }
      if (changed) {
        steps.push({ step: 'transition', ok: false, message: `${changed}; the move was not made`, to: target })
        return { ok: false, steps, transitions, ...(status !== undefined ? { status, category } : {}) }
      }
    }
  }
  if (chosen) {
    const stop = guard()
    if (stop) {
      if (!steps.length) return { ok: false, steps, transitions, error: `${stop}; nothing was written` }
      steps.push({ step: 'transition', ok: false, message: `not tried: ${stop}`, to: target })
      return { ok: false, steps, transitions }
    }
    try {
      await client.transition(key, chosen.id, signal, { guard: o.guard })
      steps.push({ step: 'transition', ok: true, to: target })
    } catch (e) {
      if (e && e.kind === 'stopped' && !steps.length) return { ok: false, steps, transitions, error: `${e.message}; nothing was written` }
      steps.push({ step: 'transition', ok: false, message: e && e.kind === 'stopped' ? `not tried: ${e.message}` : msg(e), to: target })
    }
  }
  return { ok: steps.length > 0 && steps.every((s) => s.ok), steps, ...(transitions ? { transitions } : {}), ...(status !== undefined ? { status, category } : {}) }
}

function msg(e) {
  return e && e.message ? e.message : String(e)
}

/** The steps as lines for `ccc` and the panel's notice: `ABC-1: comment posted`. */
function stepLines(key, steps) {
  return steps.map((s) => {
    if (s.step === 'comment') return s.ok ? `${key}: comment posted` : `${key}: comment not posted: ${s.message}`
    return s.ok ? `${key}: moved to ${s.to}` : `${key}: not moved${s.to ? ` to ${s.to}` : ''}: ${s.message}`
  })
}

/**
 * Who prepared a draft, for the page's marker: "Draft from Claude (<tab name>)" when the caller was a
 * Claude tab (`CliCall.tabId`, set by the app from the caller's session token, never its arguments),
 * else "Draft from ccc" (a shell, a script, or a Claude that dropped its token: never "the person").
 * `tab` is that tab's SessionInfo when this window lists it (its name, else Claude's title).
 */
function draftMarker(tabId, tab) {
  if (!tabId) return 'Draft from ccc'
  const name = cut(oneLine((tab && (tab.name || tab.title)) || ''), 60)
  return name ? `Draft from Claude (${name})` : 'Draft from Claude'
}

module.exports = {
  MAX_COMMENT,
  WRITE_MODES,
  OFF_MESSAGE,
  normaliseComment,
  checkComment,
  commentAdf,
  toneOf,
  parseTransitions,
  transitionText,
  possibleText,
  matchStatus,
  statusProblem,
  writeMode,
  updatePlan,
  draftDecision,
  mayWrite,
  performWrite,
  stepLines,
  draftMarker,
}
