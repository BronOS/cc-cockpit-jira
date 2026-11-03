'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const S = require('../dist/lib/seen')
const { compact } = require('../dist/lib/model')
const { fixture, ME } = require('./fakes')

const abc1 = () => compact(fixture('issue-ABC-1.json'), ME)
const ANN_COMMENT = Date.parse('2026-11-01T09:15:00Z')

test('never marked: every event of others is new; the person\'s own never are', () => {
  const ev = S.newEvents(abc1(), undefined, 'inProgress')
  assert.deepEqual(ev.map((e) => e.id), ['h501', 'c101'])
})

test('the mark hides what came before it', () => {
  assert.deepEqual(S.newEvents(abc1(), Date.parse('2026-10-31T12:00:00Z'), 'inProgress').map((e) => e.id), ['c101'])
  assert.equal(S.isUnread(abc1(), ANN_COMMENT, 'inProgress'), false)
})

test('Mentioned counts only mentions', () => {
  assert.deepEqual(S.newEvents(abc1(), undefined, 'mentioned').map((e) => e.id), ['c101'])
  const i = compact(fixture('issue-ABC-7.json'), ME)
  assert.equal(S.isUnread(i, undefined, 'mentioned'), false)
})

test('first run: everything is seen as it is; seeding ends only with a complete poll', () => {
  const seen = S.emptySeen('https://acme.atlassian.net', ME)
  S.seed(seen, [{ issue: abc1(), lane: 'inProgress' }], false)
  assert.equal(seen.marks['ABC-1'], ANN_COMMENT)
  assert.equal(seen.seeded, false)
  // A deferred issue arriving on the next poll is still seeded, not shown as unread.
  const abc2 = compact(fixture('issue-ABC-2.json'), ME)
  S.seed(seen, [{ issue: abc1(), lane: 'inProgress' }, { issue: abc2, lane: 'backlog' }], true)
  assert.equal(seen.marks['ABC-2'], 0)
  assert.equal(seen.seeded, true)
  // Seeded: a new issue is not marked any more, so its activity of others is new.
  const xyz = compact(fixture('issue-XYZ-9.json'), ME)
  S.seed(seen, [{ issue: xyz, lane: 'mentioned' }], true)
  assert.equal('XYZ-9' in seen.marks, false)
  assert.equal(S.isUnread(xyz, seen.marks['XYZ-9'], 'mentioned'), true)
})

test('a comment after the mark makes it unread again', () => {
  const seen = S.emptySeen('s', ME)
  S.seed(seen, [{ issue: abc1(), lane: 'inProgress' }], true)
  const raw = fixture('issue-ABC-1.json')
  raw.fields.comment.comments.push({ id: '102', author: { accountId: 'bob', displayName: 'Bob' }, created: '2026-11-02T08:00:00.000+0000', body: 'ping' })
  const i = compact(raw, ME)
  assert.deepEqual(S.newEvents(i, seen.marks['ABC-1'], 'inProgress').map((e) => e.id), ['c102'])
})

test('mark read: up to the newest activity of others; unread: just before it', () => {
  const seen = S.emptySeen('s', ME)
  const i = abc1()
  S.markRead(seen, i, 123)
  assert.equal(seen.marks['ABC-1'], ANN_COMMENT)
  assert.equal(S.isUnread(i, seen.marks['ABC-1'], 'inProgress'), false)
  S.markUnread(seen, i, 'inProgress')
  assert.equal(seen.marks['ABC-1'], ANN_COMMENT - 1)
  assert.deepEqual(S.newEvents(i, seen.marks['ABC-1'], 'inProgress').map((e) => e.id), ['c101'])
})

test('mark read of an issue with nothing from others uses now; mark unread refuses', () => {
  const seen = S.emptySeen('s', ME)
  const i = compact(fixture('issue-ABC-2.json'), ME)
  S.markRead(seen, i, 999)
  assert.equal(seen.marks['ABC-2'], 999)
  assert.throws(() => S.markUnread(seen, i, 'backlog'), /nothing from others/)
})

test('marks of another site or account are not reused', () => {
  const stored = { site: 'https://a.atlassian.net', accountId: ME, seeded: true, marks: { 'A-1': 5 } }
  assert.deepEqual(S.loadSeen(stored, 'https://a.atlassian.net', ME).marks, { 'A-1': 5 })
  assert.deepEqual(S.loadSeen(stored, 'https://b.atlassian.net', ME).marks, {})
  assert.equal(S.loadSeen(stored, 'https://a.atlassian.net', 'other').seeded, false)
  assert.equal(S.loadSeen(undefined, 'x', 'y').seeded, false)
})

test('bounded: the oldest marks go first', () => {
  const seen = S.emptySeen('s', ME)
  for (let n = 0; n < 10; n++) seen.marks[`A-${n + 1}`] = n
  S.bound(seen, 4)
  assert.deepEqual(Object.keys(seen.marks).sort(), ['A-10', 'A-7', 'A-8', 'A-9'])
})
