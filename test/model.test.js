'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { compact, header, newestActivity } = require('../dist/lib/model')
const { parseTime } = require('../dist/lib/util')
const { fixture, ME } = require('./fakes')

test('parseTime reads Jira\'s offset without a colon', () => {
  assert.equal(parseTime('2026-11-01T10:15:00.000+0100'), Date.parse('2026-11-01T09:15:00Z'))
  assert.equal(parseTime('2026-11-01T10:15:00.000-0400'), Date.parse('2026-11-01T14:15:00Z'))
  assert.equal(parseTime('garbage'), 0)
  assert.equal(parseTime(undefined), 0)
})

test('compact keeps the header, the description text and the events oldest first', () => {
  const i = compact(fixture('issue-ABC-1.json'), ME)
  assert.equal(i.key, 'ABC-1')
  assert.equal(i.project, 'ABC')
  assert.equal(i.category, 'indeterminate')
  assert.equal(i.priority, 'High')
  assert.equal(i.assigneeId, ME)
  assert.match(i.description, /^Customers with EU cards/)
  assert.deepEqual(i.events.map((e) => [e.id, e.kind, e.mine]), [
    ['h500', 'change', true],
    ['c100', 'comment', true],
    ['h501', 'change', false],
    ['c101', 'comment', false],
  ])
})

test('only status, assignee and priority changes count; labels are dropped from the line', () => {
  const i = compact(fixture('issue-ABC-1.json'), ME)
  assert.equal(i.events.find((e) => e.id === 'h501').text, 'priority: Medium → High')
})

test('a comment mentioning the person carries mentionsMe; their own never does', () => {
  const i = compact(fixture('issue-ABC-1.json'), ME)
  const c = i.events.find((e) => e.id === 'c101')
  assert.equal(c.mentionsMe, true)
  assert.equal(c.text, '@Oleg Example can you check the 3DS flow today?')
  const raw = fixture('issue-ABC-1.json')
  raw.fields.comment.comments[0].body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: ME, text: '@Oleg' } }] }] }
  assert.equal(compact(raw, ME).events.find((e) => e.id === 'c100').mentionsMe, undefined)
})

test('a description mention is an event by the reporter at the creation, or by the last editor', () => {
  const raw = fixture('issue-XYZ-9.json')
  raw.fields.description = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'cc ' }, { type: 'mention', attrs: { id: ME, text: '@Oleg' } }] }] }
  let i = compact(raw, ME)
  let d = i.events.find((e) => e.kind === 'mention')
  assert.equal(d.by, 'Bob Jones')
  assert.equal(d.at, parseTime(raw.fields.created))
  raw.changelog.histories = [{ id: '9', author: { accountId: 'ann', displayName: 'Ann Smith' }, created: '2026-11-01T18:00:00.000+0000', items: [{ field: 'description', fromString: 'a', toString: 'b' }] }]
  i = compact(raw, ME)
  d = i.events.find((e) => e.kind === 'mention')
  assert.equal(d.by, 'Ann Smith')
  assert.equal(d.at, Date.parse('2026-11-01T18:00:00Z'))
})

test('an assignment to the person by someone else is marked', () => {
  const raw = fixture('issue-ABC-2.json')
  raw.changelog.histories = [{ id: '7', author: { accountId: 'ann', displayName: 'Ann' }, created: '2026-10-30T10:00:00.000+0000', items: [{ field: 'assignee', from: null, fromString: null, to: ME, toString: 'Oleg Example' }] }]
  const e = compact(raw, ME).events[0]
  assert.equal(e.assignedMe, true)
  assert.equal(e.text, 'assignee: - → Oleg Example')
  assert.equal(e.mine, false)
})

test('header from search fields; a null assignee and an uncategorised status', () => {
  const h = header('ABC-7', { summary: 's', status: { name: 'Triage', statusCategory: { key: 'undefined' } }, assignee: null, updated: '2026-10-31T08:00:00.000+0000' })
  assert.equal(h.category, 'new')
  assert.equal(h.assignee, '')
  assert.equal(h.project, 'ABC')
  assert.equal(newestActivity({ ...h, events: [] }), Date.parse('2026-10-31T08:00:00Z'))
})

test('long comments are cut in the cache size, kept in the full size', () => {
  const raw = fixture('issue-ABC-2.json')
  raw.fields.comment.comments = [{ id: '1', author: { accountId: 'x', displayName: 'X' }, created: '2026-10-30T10:00:00.000+0000', body: 'y'.repeat(10000) }]
  assert.ok(compact(raw, ME).events[0].text.length <= 3000)
  assert.equal(compact(raw, ME, 'full').events[0].text.length, 10000)
})
