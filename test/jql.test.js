'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { assignedJql, doneJql, mentionedJql, projectKey } = require('../dist/lib/jql')

test('the assigned search is the design\'s', () => {
  assert.equal(assignedJql(), 'assignee = currentUser() AND statusCategory != Done ORDER BY priority ASC, updated DESC')
})

test('Done looks doneDays back, an integer whatever the setting holds', () => {
  assert.equal(doneJql(14), 'assignee = currentUser() AND statusCategory = Done AND statusCategoryChangedDate >= -14d ORDER BY statusCategoryChangedDate DESC')
  assert.match(doneJql('3; DROP'), /-1d/)
  assert.match(doneJql(9999), /-365d/)
  assert.match(doneJql(2.7), /-2d/)
})

test('Mentioned: quoted, upper-cased, deduplicated project keys; a key that is not one is dropped', () => {
  assert.equal(mentionedJql(['abc', 'OPS', 'ABC'], 7), 'project in ("ABC", "OPS") AND updated >= -7d AND (assignee != currentUser() OR assignee is EMPTY) ORDER BY updated DESC')
  assert.equal(mentionedJql(['ABC) OR (project is not EMPTY', 'X"Y'], 7), null)
  assert.match(mentionedJql(['ABC', 'A B'], 7), /project in \("ABC"\)/)
  assert.equal(mentionedJql([], 7), null)
})

test('projectKey', () => {
  assert.equal(projectKey(' ab_2 '), 'AB_2')
  assert.equal(projectKey('2AB'), null)
  assert.equal(projectKey(''), null)
})
