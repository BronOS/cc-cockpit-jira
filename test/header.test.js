'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { headerSpec } = require('../dist/lib/header')

const NOW = Date.parse('2026-11-03T12:00:00Z')

test('the header: last poll and account, Refresh enabled', () => {
  const h = headerSpec({ ready: true, polling: false, lastPoll: NOW - 5 * 60000, account: 'Ann Smith' }, NOW)
  assert.equal(h.meta, '5 min ago · Ann Smith')
  assert.deepEqual(h.actions, [{ id: 'refresh', icon: 'refresh', title: 'Poll Jira now', busy: false, disabled: false }])
})

test('while polling the text says so and the icon is busy', () => {
  const h = headerSpec({ ready: true, polling: true, lastPoll: 0, account: '' }, NOW)
  assert.equal(h.meta, 'polling… · never')
  assert.equal(h.actions[0].busy, true)
})

test('not configured: no text, Refresh disabled and not busy', () => {
  const h = headerSpec({ ready: false, polling: true, lastPoll: 0, account: 'x' }, NOW)
  assert.equal(h.meta, '')
  assert.equal(h.actions[0].disabled, true)
  assert.equal(h.actions[0].busy, false)
})

test('a long account name is cut to the app limit of 120 characters', () => {
  const h = headerSpec({ ready: true, polling: false, lastPoll: NOW, account: 'x'.repeat(300) }, NOW)
  assert.equal(h.meta.length, 120)
  assert.ok(h.meta.endsWith('…'))
})
