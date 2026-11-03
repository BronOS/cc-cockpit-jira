'use strict'
// The row decisions of the Jira panel, kept free of the DOM so node:test can check them
// (test/rowlogic.test.js requires this file; the page loads it as a classic script before
// main.js, where these functions become globals).
//
// A row is one focusable element: a click on it or Enter / Space while it has the focus opens the
// issue; the arrow keys move between rows. Its other actions are small buttons shown while the
// row is hovered or has the focus inside it (Tab reaches them; they are in the DOM all the time,
// only faded out, so the keyboard can get to them).

/**
 * What a key press on a row does: 'open', 'next', 'prev', 'first', 'last', or null (let it be).
 * Only presses on the row itself count: Enter on one of its buttons is that button's click.
 *
 * @param {string} key KeyboardEvent.key
 * @param {boolean} onRow the event's target is the row element (not a button inside it)
 * @param {{ alt?: boolean, ctrl?: boolean, meta?: boolean }} [mods]
 */
function rowKeyAction(key, onRow, mods) {
  if (!onRow) return null
  if (mods && (mods.alt || mods.ctrl || mods.meta)) return null
  switch (key) {
    case 'Enter':
    case ' ':
      return 'open'
    case 'ArrowDown':
      return 'next'
    case 'ArrowUp':
      return 'prev'
    case 'Home':
      return 'first'
    case 'End':
      return 'last'
    default:
      return null
  }
}

/**
 * Whether a click opens the issue: anywhere on the row except its buttons and the triage chooser
 * (which act themselves), and not when the person was selecting text.
 */
function rowClickOpens(inControl, selecting) {
  return !inControl && !selecting
}

/**
 * The hover buttons of a row, in order: `{ action, label, title }`. `action` is the message type
 * the page posts (`wrong` only toggles the chooser in the page).
 *
 * The triage button is labelled with the verdict itself ("action ▾"), not "Wrong?": a new person
 * could not tell what was wrong; the label says what triage decided, the chooser asks the question.
 *
 * @param {{ unread: boolean, canUnread: boolean, lane: string, verdict?: { priority: string } }} r
 * @param {{ triageOn: boolean }} s
 */
function rowButtons(r, s) {
  const out = [{ action: 'browser', label: '↗', title: 'Open in the browser' }]
  if (r.unread) out.push({ action: 'read', label: 'Read', title: 'Mark read' })
  else if (r.canUnread) out.push({ action: 'unread', label: 'Unread', title: 'Mark unread' })
  if (s && s.triageOn && r.lane !== 'done') {
    const p = r.verdict && r.verdict.priority
    out.push({ action: 'wrong', label: p ? `${p} ▾` : 'triage ▾', title: p ? `Triage says ${p}: change how much this needs you` : 'Not triaged yet: say how much this needs you' })
  }
  out.push({ action: 'discuss', label: 'Discuss', title: 'Send the issue to the Claude tab you are looking at' })
  out.push({ action: 'newSession', label: 'New', title: 'Open a new Claude tab about this issue' })
  return out
}

/** The index the focus moves to for a move action over `count` rows from `at`; null to stay. */
function moveIndex(action, at, count) {
  if (!count) return null
  if (action === 'first') return 0
  if (action === 'last') return count - 1
  if (action === 'next') return at < count - 1 ? at + 1 : null
  if (action === 'prev') return at > 0 ? at - 1 : null
  return null
}

if (typeof module !== 'undefined' && module.exports) module.exports = { rowKeyAction, rowClickOpens, rowButtons, moveIndex }
