'use strict'
// The panel's row decisions (panels/rowlogic.js, loaded by the page as a classic script).
const test = require('node:test')
const assert = require('node:assert/strict')
const { rowKeyAction, rowClickOpens, rowButtons, moveIndex } = require('../panels/rowlogic')

test('Enter or Space on a focused row opens it; on a button inside it they are the button\'s own', () => {
  assert.equal(rowKeyAction('Enter', true), 'open')
  assert.equal(rowKeyAction(' ', true), 'open')
  assert.equal(rowKeyAction('Enter', false), null)
  assert.equal(rowKeyAction(' ', false), null)
  assert.equal(rowKeyAction('Enter', true, { meta: true }), null, 'a shortcut with a modifier is left alone')
  assert.equal(rowKeyAction('a', true), null)
})

test('the arrow keys, Home and End move between rows', () => {
  assert.equal(rowKeyAction('ArrowDown', true), 'next')
  assert.equal(rowKeyAction('ArrowUp', true), 'prev')
  assert.equal(rowKeyAction('Home', true), 'first')
  assert.equal(rowKeyAction('End', true), 'last')
  assert.equal(moveIndex('next', 0, 3), 1)
  assert.equal(moveIndex('next', 2, 3), null)
  assert.equal(moveIndex('prev', 0, 3), null)
  assert.equal(moveIndex('prev', 2, 3), 1)
  assert.equal(moveIndex('first', 2, 3), 0)
  assert.equal(moveIndex('last', 0, 3), 2)
  assert.equal(moveIndex('next', 0, 0), null)
})

test('a click opens unless it was on a control or the person selected text', () => {
  assert.equal(rowClickOpens(false, false), true)
  assert.equal(rowClickOpens(true, false), false)
  assert.equal(rowClickOpens(false, true), false)
})

test('the hover buttons: ↗, read or unread, Wrong? (triage on, not Done), Discuss, New', () => {
  const ids = (r, s) => rowButtons(r, s).map((b) => b.action)
  assert.deepEqual(ids({ unread: true, canUnread: true, lane: 'inProgress' }, { triageOn: true }), ['browser', 'read', 'wrong', 'discuss', 'newSession'])
  assert.deepEqual(ids({ unread: false, canUnread: true, lane: 'backlog' }, { triageOn: false }), ['browser', 'unread', 'discuss', 'newSession'])
  assert.deepEqual(ids({ unread: false, canUnread: false, lane: 'done' }, { triageOn: true }), ['browser', 'discuss', 'newSession'])
  for (const b of rowButtons({ unread: true, lane: 'x' }, { triageOn: true })) assert.ok(b.label && b.title, 'every button has a label and a title')
  assert.ok(!rowButtons({ unread: true, lane: 'x' }, { triageOn: true }).some((b) => b.action === 'open'), 'Open is the row itself')
})
