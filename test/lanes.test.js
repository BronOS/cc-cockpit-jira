'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { statusLane, sortRows } = require('../dist/lib/lanes')

const onHold = new Set(['waiting', 'blocked'])

test('lanes from the status category; onHoldStatuses win, any letter case', () => {
  assert.equal(statusLane({ category: 'new', status: 'To Do' }, onHold), 'backlog')
  assert.equal(statusLane({ category: 'indeterminate', status: 'In Progress' }, onHold), 'inProgress')
  assert.equal(statusLane({ category: 'indeterminate', status: 'Waiting' }, onHold), 'onHold')
  assert.equal(statusLane({ category: 'new', status: ' BLOCKED ' }, onHold), 'onHold')
  assert.equal(statusLane({ category: 'done', status: 'Waiting' }, onHold), 'done')
  assert.equal(statusLane({ category: 'indeterminate', status: 'Waiting' }, new Set()), 'inProgress')
})

test('order: triage priority (urgent, action, fyi, noise, none), then the newest activity', () => {
  const row = (key, priority, at) => ({ issue: { key, events: [{ at }] }, verdict: priority ? { priority } : null })
  const rows = [row('A-1', 'noise', 9), row('A-2', 'fyi', 1), row('A-3', 'urgent', 1), row('A-4', 'fyi', 5), row('A-5', null, 99), row('A-6', 'action', 0)]
  assert.deepEqual(sortRows(rows).map((r) => r.issue.key), ['A-3', 'A-6', 'A-4', 'A-2', 'A-1', 'A-5'])
})

test('without triage: the newest activity first', () => {
  const row = (key, at) => ({ issue: { key, events: [], updatedAt: at }, verdict: null })
  assert.deepEqual(sortRows([row('A-1', 1), row('A-2', 3), row('A-3', 2)]).map((r) => r.issue.key), ['A-2', 'A-3', 'A-1'])
})
