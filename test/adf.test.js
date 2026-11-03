'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { adfToText, mentionIds } = require('../dist/lib/adf')
const { fixture, ME } = require('./fakes')

test('a recorded description: code marks, nested lists, a fenced code block, a link', () => {
  const text = adfToText(fixture('issue-ABC-1.json').fields.description)
  assert.equal(text, [
    'Customers with EU cards get `PAYMENT_DECLINED` at checkout.',
    '',
    '- Visa: always',
    '- Mastercard: sometimes',
    '  - only 3DS',
    '',
    '```json',
    '{"code": 402}',
    '```',
    '',
    'Logs: dashboard (https://grafana.example.com/d/x)',
  ].join('\n'))
})

test('mentions read @Name; a mention without text falls back to its id', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'a1', text: '@Ann' } }, { type: 'text', text: ' and ' }, { type: 'mention', attrs: { id: 'b2', text: 'Bob' } }, { type: 'text', text: ' and ' }, { type: 'mention', attrs: { id: 'c3' } }] }] }
  assert.equal(adfToText(doc), '@Ann and @Bob and @c3')
})

test('ordered lists keep their start, tasks their state, headings, quotes, rules and hard breaks', () => {
  const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
  const doc = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Steps' }] },
    { type: 'orderedList', attrs: { order: 3 }, content: [{ type: 'listItem', content: [p('three')] }, { type: 'listItem', content: [p('four')] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [{ type: 'text', text: 'done one' }] }, { type: 'taskItem', attrs: { state: 'TODO' }, content: [{ type: 'text', text: 'open one' }] }] },
    { type: 'blockquote', content: [p('quoted'), p('twice')] },
    { type: 'rule' },
    { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] },
  ] }
  assert.equal(adfToText(doc), '## Steps\n\n3. three\n4. four\n\n[x] done one\n[ ] open one\n\n> quoted\n>\n> twice\n\n---\n\na\nb')
})

test('tables, panels, media, cards, emoji, status and dates become plain text', () => {
  const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
  const doc = { type: 'doc', content: [
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [p('A')] }, { type: 'tableHeader', content: [p('B')] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [p('1')] }, { type: 'tableCell', content: [p('2')] }] }] },
    { type: 'panel', attrs: { panelType: 'warning' }, content: [p('careful')] },
    { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'x', alt: 'screenshot.png' } }] },
    { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: 'https://acme.atlassian.net/browse/ABC-9' } }, { type: 'text', text: ' ' }, { type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } }, { type: 'text', text: ' ' }, { type: 'status', attrs: { text: 'BLOCKED', color: 'red' } }, { type: 'text', text: ' ' }, { type: 'date', attrs: { timestamp: '1761955200000' } }] },
  ] }
  assert.equal(adfToText(doc), '| A | B |\n| 1 | 2 |\n\n[warning] careful\n\n[attachment: screenshot.png]\n\nhttps://acme.atlassian.net/browse/ABC-9 😄 [BLOCKED] 2025-11-01')
})

test('null, a string body and broken nodes do not throw', () => {
  assert.equal(adfToText(null), '')
  assert.equal(adfToText('  plain v2 body '), 'plain v2 body')
  assert.equal(adfToText({ type: 'doc', content: [null, 5, { type: 'paragraph', content: [{ type: 'text' }] }, { type: 'mystery', content: [{ type: 'text', text: 'kept' }] }] }), 'kept')
})

test('a deeply nested document stops instead of overflowing the stack', () => {
  let node = { type: 'text', text: 'deep' }
  for (let i = 0; i < 10000; i++) node = { type: 'blockquote', content: [node] }
  assert.doesNotThrow(() => adfToText({ type: 'doc', content: [node] }))
  assert.doesNotThrow(() => mentionIds({ type: 'doc', content: [node] }))
})

test('mentionIds finds every mention once, in lists and tables too', () => {
  const body = fixture('issue-ABC-1.json').fields.comment.comments[1].body
  assert.deepEqual(mentionIds(body), [ME])
  const nested = { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'x' } }, { type: 'mention', attrs: { id: 'x' } }] }] }] }] }
  assert.deepEqual(mentionIds(nested), ['x'])
  assert.deepEqual(mentionIds(null), [])
})
