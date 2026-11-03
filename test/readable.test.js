'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { readableText, discussPrompt, browseUrl } = require('../dist/lib/readable')
const { compact } = require('../dist/lib/model')
const { fixture, ME, SITE } = require('./fakes')

const abc1 = () => compact(fixture('issue-ABC-1.json'), ME, 'full')

test('readable text: header fields, description, activity oldest first, new ones [new]', () => {
  const t = readableText(abc1(), { site: SITE, mark: Date.parse('2026-10-31T12:00:00Z'), lane: 'inProgress' })
  const lines = t.split('\n')
  assert.equal(lines[0], 'ABC-1: Checkout fails for EU cards')
  assert.equal(lines[1], 'Type: Bug    Status: In Progress    Priority: High')
  assert.equal(lines[2], 'Project: ABC    Reporter: Ann Smith    Assignee: Oleg Example')
  assert.equal(lines[4], `URL: ${SITE}/browse/ABC-1`)
  assert.match(t, /\nDescription\n-----------\nCustomers with EU cards/)
  assert.match(t, /Activity \(2 comments, oldest first\)/)
  const order = ['changed status: To Do', 'Looking into it.', 'changed priority', '[new] Ann Smith']
  let at = 0
  for (const s of order) {
    const i = t.indexOf(s, at)
    assert.ok(i > at, `${s} after the previous one`)
    at = i
  }
  assert.ok(!/\[new\] Oleg/.test(t), 'the person\'s own activity is never new')
  assert.ok(!/\[new\] Ann Smith, [^:]*: changed priority/.test(t))
})

test('no description and no activity', () => {
  const t = readableText(compact(fixture('issue-ABC-2.json'), ME, 'full'), { site: SITE })
  assert.match(t, /\(no description\)$/)
})

test('the prompt starts "About Jira <KEY>: <summary>" and is capped', () => {
  const issue = abc1()
  const p = discussPrompt(issue, readableText(issue, { site: SITE }))
  assert.ok(p.startsWith('About Jira ABC-1: Checkout fails for EU cards\n\n'))
  assert.ok(!/^[/!#&]/.test(p))
  assert.equal(discussPrompt(issue, 'x'.repeat(50000), 1000).length, 1000)
  // A summary that starts with "/" cannot make the prompt start with it.
  assert.ok(discussPrompt({ ...issue, summary: '/clear everything' }, 't').startsWith('About Jira ABC-1: /clear'))
})

test('browseUrl', () => {
  assert.equal(browseUrl(SITE, 'ABC-1'), 'https://acme.atlassian.net/browse/ABC-1')
})
