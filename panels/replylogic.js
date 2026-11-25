'use strict'
// The reply page's decisions, kept free of the DOM so node:test can check them (test/reply.test.js
// requires this file; panels/reply.html loads it as a classic script before reply.js, where these
// become globals). The host requires it too, for the label of the toolbar button: the page and the
// toolbar must never disagree on what the click does.
//
// One button, its label from the choice (design "The reply page"): Post comment, Move, or Post and
// move; disabled while nothing would happen. There is no keyboard shortcut for it (no Ctrl/Cmd+Enter):
// the click is the person's decision, and a chord typed out of habit in the comment box is not one.

// Jira's limit is 32,767; the host refuses past this before any call (dist/lib/write.js MAX_COMMENT,
// a suite checks the two are equal).
const REPLY_MAX_COMMENT = 32000

/** The comment's length as the host counts it (CRLF is one newline there). */
function commentLength(comment) {
  return typeof comment === 'string' ? comment.replace(/\r\n?/g, '\n').length : 0
}

/**
 * What the button does for the page's current values: `{ label, disabled, what }`, `what` one of
 * 'none', 'comment', 'move', 'both'. A comment of white space only is no comment; one past the limit
 * disables the button (the page says why under the box).
 */
function replyAction(comment, transitionId) {
  const c = typeof comment === 'string' && comment.trim() !== ''
  const t = typeof transitionId === 'string' && transitionId !== ''
  const tooLong = commentLength(comment) > REPLY_MAX_COMMENT
  if (c && t) return { label: 'Post and move', disabled: tooLong, what: 'both' }
  if (c) return { label: 'Post comment', disabled: tooLong, what: 'comment' }
  if (t) return { label: 'Move', disabled: false, what: 'move' }
  return { label: 'Post comment', disabled: true, what: 'none' }
}

/**
 * A transition as a "Move to" option: its name, the target status when it differs from the name, and
 * why it is disabled. `{ value, text, disabled }`.
 */
function moveOption(t) {
  const to = t.to && String(t.to).toLowerCase() !== String(t.name).toLowerCase() ? ` (to ${t.to})` : ''
  return { value: t.id, text: `${t.name}${to}${t.enabled ? '' : ` — ${t.why || 'not possible'}`}`, disabled: !t.enabled }
}

/** The choice to keep after the list was read again: the same id while it is still enabled, else Keep status (''). */
function keepChoice(transitions, transitionId) {
  return transitionId && transitions.some((t) => t.id === transitionId && t.enabled) ? transitionId : ''
}

if (typeof module !== 'undefined' && module.exports) module.exports = { REPLY_MAX_COMMENT, commentLength, replyAction, moveOption, keepChoice }
