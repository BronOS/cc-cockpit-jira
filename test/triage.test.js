'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { hintFor, triageText, triageItem, priorityName } = require('../dist/lib/triage')
const { compact } = require('../dist/lib/model')
const { fixture, ME } = require('./fakes')

test('hints and floors: the old connector\'s rules', () => {
  assert.deepEqual(hintFor('done', true, 'Highest'), { hint: { priority: 'noise' } })
  assert.deepEqual(hintFor('inProgress', false, 'Highest'), { hint: { priority: 'action' } })
  assert.deepEqual(hintFor('onHold', false, 'High'), { hint: { priority: 'noise' } })
  assert.deepEqual(hintFor('backlog', false, 'Critical'), { hint: { priority: 'noise' } })
  assert.deepEqual(hintFor('backlog', true, 'High'), { hint: { priority: 'urgent' } })
  assert.deepEqual(hintFor('onHold', true, '1-Critical'), { hint: { priority: 'urgent' } })
  assert.deepEqual(hintFor('inProgress', true, 'Medium'), { floor: 'action' })
  assert.deepEqual(hintFor('onHold', true, 'Low'), { floor: 'fyi' })
  assert.deepEqual(hintFor('backlog', true, ''), { floor: 'fyi' })
  assert.deepEqual(hintFor('mentioned', true, 'Highest'), { floor: 'fyi' })
  assert.deepEqual(hintFor('mentioned', false, 'Low'), { floor: 'fyi' })
})

test('priorityName strips a numeric scheme prefix', () => {
  assert.equal(priorityName('2-High'), 'high')
  assert.equal(priorityName(' 1 - Critical'), 'critical')
  assert.equal(priorityName('Highest'), 'highest')
})

const abc1 = () => compact(fixture('issue-ABC-1.json'), ME)

test('full text: header, people, description, new activity marked new, earlier as context', () => {
  const mark = Date.parse('2026-10-31T12:00:00Z') // after Ann's priority change, before her comment
  const t = triageText(abc1(), { mode: 'full', lane: 'inProgress', mark })
  const lines = t.split('\n')
  assert.equal(lines[0], 'Jira ABC-1 (Bug, In Progress, High) in ABC: Checkout fails for EU cards')
  assert.equal(lines[1], 'Reported by Ann Smith; assigned to the person (you).')
  assert.match(t, /\nDescription:\nCustomers with EU cards get `PAYMENT_DECLINED`/)
  assert.match(t, /\nEarlier \(context only\):\n- Oleg Example changed status: To Do → In Progress[^\n]*\n- Oleg Example commented[^\n]*: Looking into it\.\n- Ann Smith changed priority: Medium → High/)
  assert.match(t, /\nNew since the person last looked \(1\):\n- Ann Smith commented \([^)]*\): @Oleg Example can you check the 3DS flow today\?$/)
})

test('nothing new says so', () => {
  const t = triageText(abc1(), { mode: 'full', lane: 'inProgress', mark: Date.now() })
  assert.match(t, /Nothing new since the person last looked\.$/)
})

test('summary mode: the first line only, no description or comments', () => {
  const t = triageText(abc1(), { mode: 'summary', lane: 'inProgress', mark: 0 })
  assert.equal(t, 'Jira ABC-1 (Bug, In Progress, High) in ABC: Checkout fails for EU cards')
})

test('a Mentioned issue says who mentioned the person and who it is assigned to', () => {
  const t = triageText(compact(fixture('issue-XYZ-9.json'), ME), { mode: 'full', lane: 'mentioned' })
  assert.match(t, /Reported by Bob Jones; assigned to Bob Jones\.\nThe person is not assigned; Bob Jones mentioned them in it\./)
})

test('the item: id, text, fields as short strings, hint or floor', () => {
  const unread = triageItem({ issue: abc1(), lane: 'inProgress', unread: true, mark: 0 }, 'full')
  assert.equal(unread.id, 'ABC-1')
  assert.deepEqual(unread.fields, { project: 'ABC', status: 'In Progress', type: 'Bug', priority: 'High', lane: 'inProgress', assignee: 'Oleg Example', reporter: 'Ann Smith' })
  assert.deepEqual(unread.hint, { priority: 'urgent' })
  assert.equal(unread.floor, undefined)
  const read = triageItem({ issue: abc1(), lane: 'inProgress', unread: false, mark: Date.now() }, 'summary')
  assert.deepEqual(read.hint, { priority: 'action' })
  assert.ok(!read.text.includes('\n'))
  const m = triageItem({ issue: compact(fixture('issue-XYZ-9.json'), ME), lane: 'mentioned', unread: true }, 'full')
  assert.equal(m.hint, undefined)
  assert.equal(m.floor, 'fyi')
})

test('the text stays far below jev-triage\'s 200,000 characters on a huge issue', () => {
  const raw = fixture('issue-ABC-1.json')
  for (let n = 0; n < 400; n++) raw.fields.comment.comments.push({ id: String(1000 + n), author: { accountId: 'x', displayName: 'X' }, created: '2026-11-02T08:00:00.000+0000', body: 'z'.repeat(5000) })
  const t = triageText(compact(raw, ME), { mode: 'full', lane: 'inProgress' })
  assert.ok(t.length < 20000, String(t.length))
})
