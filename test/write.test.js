'use strict'
// Writing to Jira (0.8.0): the pure rules (lib/write.js), the reply page's decisions
// (panels/replylogic.js) and the client's writes against a fake Jira (never the network).
const test = require('node:test')
const assert = require('node:assert/strict')
const wr = require('../dist/lib/write')
const rl = require('../panels/replylogic')
const { createClient } = require('../dist/lib/client')
const { fakeJira, SITE, GATEWAY, EMAIL, TOKEN, TRANSITIONS } = require('./fakes')

const make = (jira, tokenKind) => createClient({ site: SITE, email: EMAIL, token: TOKEN, tokenKind, fetch: jira.fetch })
const text = (t) => ({ type: 'text', text: t })
const BR = { type: 'hardBreak' }
const para = (...content) => ({ type: 'paragraph', content })

test('ADF: a blank line starts a paragraph, a single newline is a hardBreak, nothing is markup', () => {
  assert.deepEqual(wr.commentAdf('one\ntwo\n\nthree'), { type: 'doc', version: 1, content: [para(text('one'), BR, text('two')), para(text('three'))] })
  // CRLF, runs of blank lines, a "blank" line of spaces, leading and trailing blank lines.
  assert.deepEqual(wr.commentAdf('\n\r\nfirst\r\n\r\n\n  \n\nsecond\n\n').content, [para(text('first')), para(text('second'))])
  // Markup and mention-like text stay text; spaces inside a line stay as typed.
  assert.deepEqual(wr.commentAdf('*bold* [link](http://x) @Bob  two  spaces').content, [para(text('*bold* [link](http://x) @Bob  two  spaces'))])
  // An empty line inside a paragraph cannot happen (it is a blank line); no empty text node ever.
  for (const p of wr.commentAdf('a\n\nb\nc\n\n\n\nd').content) for (const n of p.content) if (n.type === 'text') assert.ok(n.text.length > 0)
  // Control characters a terminal paste brings are dropped; tabs stay.
  assert.deepEqual(wr.commentAdf('a\u0007b\tc').content, [para(text('ab\tc'))])
})

test('a comment: not empty, at most 32,000 characters, refused (never cut) past that', () => {
  assert.equal(wr.MAX_COMMENT, 32000)
  assert.equal(rl.REPLY_MAX_COMMENT, wr.MAX_COMMENT, 'the page and the host use one limit')
  assert.match(wr.checkComment('   \n\t ').error, /empty/)
  assert.equal(wr.checkComment('x'.repeat(32000)).text.length, 32000)
  assert.match(wr.checkComment('x'.repeat(32001)).error, /32001 characters; at most 32,000/)
  // CRLF counts as one newline, as Jira will store it.
  assert.ok(wr.checkComment('ab\r\n'.repeat(10666)).text)
})

test('transitions: parsed from expand=transitions.fields; a required field without a default disables one', () => {
  const list = wr.parseTransitions(TRANSITIONS)
  assert.deepEqual(list.map((t) => [t.id, t.name, t.to, t.enabled]), [['21', 'Start progress', 'In Progress', true], ['31', 'Done', 'Done', true], ['41', 'Resolve', 'Resolved', false]])
  assert.equal(list[2].why, 'needs fields: open in Jira')
  assert.deepEqual(list[2].needs, ['Resolution'])
  // A required field with a default is fine; isAvailable false is disabled; junk is skipped.
  const more = wr.parseTransitions({
    transitions: [
      { id: '5', name: 'Triage', to: { name: 'Triaged' }, fields: { priority: { required: true, hasDefaultValue: true } } },
      { id: '6', name: 'Blocked', to: { name: 'Blocked' }, isAvailable: false },
      { id: '../7', name: 'Evil', to: { name: 'x' } },
      { id: '8', name: '   ' },
      null,
    ],
  })
  assert.deepEqual(more.map((t) => [t.id, t.enabled, t.why]), [['5', true, ''], ['6', false, 'not possible now']])
  assert.deepEqual(wr.parseTransitions(null), [])
})

test('status matching: transition name first, then target status, any case, an enabled one wins', () => {
  const list = wr.parseTransitions(TRANSITIONS)
  assert.equal(wr.matchStatus(list, 'start PROGRESS').transition.id, '21')
  assert.equal(wr.matchStatus(list, 'in progress').transition.id, '21', 'by the target status')
  assert.equal(wr.matchStatus(list, ' done ').transition.id, '31')
  assert.equal(wr.matchStatus(list, 'resolved').disabled.id, '41')
  assert.equal(wr.matchStatus(list, 'Resolve').disabled.id, '41')
  assert.deepEqual(wr.matchStatus(list, 'Closed'), { none: true })
  assert.deepEqual(wr.matchStatus(list, ''), { none: true })
  // Two transitions to one status: the enabled one, whatever the order.
  const two = wr.parseTransitions({ transitions: [{ id: '1', name: 'Close hard', to: { name: 'Closed' }, fields: { r: { required: true } } }, { id: '2', name: 'Close', to: { name: 'Closed' } }] })
  assert.equal(wr.matchStatus(two, 'closed').transition.id, '2')
  assert.match(wr.statusProblem(wr.matchStatus(list, 'Closed'), 'Closed', list), /no transition or status "Closed".*Possible: Start progress \(to In Progress\), Done\./)
  assert.match(wr.statusProblem(wr.matchStatus(list, 'resolved'), 'resolved', list), /not possible from here \(Resolve \(to Resolved\): needs fields: open in Jira\)/)
})

test('the draft / direct / off decision of ccc jira update', () => {
  assert.deepEqual(wr.updatePlan('draft', { comment: 'x' }), { mode: 'draft' })
  assert.deepEqual(wr.updatePlan(undefined, { status: 'Done' }), { mode: 'draft' }, 'no setting: draft')
  assert.deepEqual(wr.updatePlan('nonsense', { status: 'Done' }), { mode: 'draft' })
  assert.deepEqual(wr.updatePlan('direct', { comment: 'x', status: 'Done' }), { mode: 'direct' })
  assert.match(wr.updatePlan('off', { comment: 'x' }).refuse, /writing is off for this project \(setting: What ccc jira update does\)/)
  assert.ok(wr.updatePlan('draft', {}).usage, 'neither a comment nor a status')
  assert.ok(wr.updatePlan('off', {}).refuse, 'off wins over a usage error')
})

test('a new draft never replaces what the person edited or is posting', () => {
  assert.equal(wr.draftDecision(null), 'open')
  assert.equal(wr.draftDecision({ edited: false, busy: false }), 'replace')
  assert.equal(wr.draftDecision({ edited: true, busy: false }), 'refuse')
  assert.equal(wr.draftDecision({ edited: false, busy: true }), 'refuse')
})

test('who may write: the owner or a write guest; an app with no `from` has no guests', () => {
  assert.equal(wr.mayWrite(undefined), true)
  assert.equal(wr.mayWrite({ view: 'desktop', access: 'owner' }), true)
  assert.equal(wr.mayWrite({ view: 'web:2', access: 'write', person: 'Ann' }), true)
  assert.equal(wr.mayWrite({ view: 'web:3', access: 'read' }), false)
  assert.equal(wr.mayWrite({ view: 'web:4' }), false, 'a from without a known access fails closed')
  assert.equal(wr.mayWrite('owner'), false)
})

test('the marker: Claude with the tab name when the app named the tab, else ccc', () => {
  assert.equal(wr.draftMarker(undefined, null), 'Draft from ccc')
  assert.equal(wr.draftMarker('t1', { name: 'Release notes' }), 'Draft from Claude (Release notes)')
  assert.equal(wr.draftMarker('t1', { title: 'Fix the bug' }), 'Draft from Claude (Fix the bug)')
  assert.equal(wr.draftMarker('t1', null), 'Draft from Claude')
})

/** A recording client for performWrite. */
function recorder(o = {}) {
  const log = []
  return {
    log,
    async transitions(key) {
      log.push(['transitions', key])
      return o.transitions || wr.parseTransitions(TRANSITIONS)
    },
    async issueHeader(key) {
      log.push(['header', key])
      return { key, fields: { status: { name: o.status || 'To Do' } } }
    },
    async comment(key, c) {
      log.push(['comment', key, c])
      if (o.commentFails) throw new Error('comment on ABC-1: Jira refused it (400): too long')
    },
    async transition(key, id) {
      log.push(['transition', key, id])
      if (o.transitionFails) throw new Error('moving ABC-1: Jira refused it (400): Resolution is required.')
    },
  }
}

test('write order: the transitions read again, then the comment, then the move; each step reported', async () => {
  const c = recorder()
  const r = await wr.performWrite({ client: c, key: 'ABC-1', comment: 'hi', transitionId: '21', expectStatus: 'to do' })
  assert.deepEqual(c.log.map((x) => x[0]), ['transitions', 'header', 'comment', 'transition'])
  assert.equal(r.ok, true)
  assert.deepEqual(r.steps, [{ step: 'comment', ok: true }, { step: 'transition', ok: true, to: 'In Progress' }])
  assert.deepEqual(wr.stepLines('ABC-1', r.steps), ['ABC-1: comment posted', 'ABC-1: moved to In Progress'])
  // A comment alone reads nothing first; a move alone posts no comment.
  const only = recorder()
  assert.equal((await wr.performWrite({ client: only, key: 'ABC-1', comment: 'hi' })).ok, true)
  assert.deepEqual(only.log.map((x) => x[0]), ['comment'])
  const mv = recorder()
  assert.equal((await wr.performWrite({ client: mv, key: 'ABC-1', transitionId: '31' })).ok, true)
  assert.deepEqual(mv.log.map((x) => x[0]), ['transitions', 'transition'])
})

test('partial failure: a posted comment and a refused move each say so; a failed comment is never followed by the move', async () => {
  const c = recorder({ transitionFails: true })
  const r = await wr.performWrite({ client: c, key: 'ABC-1', comment: 'hi', transitionId: '21' })
  assert.equal(r.ok, false)
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [['comment', true], ['transition', false]])
  assert.match(wr.stepLines('ABC-1', r.steps)[1], /ABC-1: not moved to In Progress: .*Resolution is required/)
  const f = recorder({ commentFails: true })
  const r2 = await wr.performWrite({ client: f, key: 'ABC-1', comment: 'hi', transitionId: '21' })
  assert.deepEqual(r2.steps.map((s) => [s.step, s.ok]), [['comment', false], ['transition', false]])
  assert.match(r2.steps[1].message, /not tried: the comment failed/)
  assert.ok(!f.log.some((x) => x[0] === 'transition'), 'no move after a failed comment')
})

test('moved meanwhile: a gone or disabled transition, or a changed status, writes nothing, the comment neither', async () => {
  const gone = recorder({ transitions: wr.parseTransitions({ transitions: [TRANSITIONS.transitions[1]] }) })
  const r = await wr.performWrite({ client: gone, key: 'ABC-1', comment: 'hi', transitionId: '21' })
  assert.equal(r.moved, true)
  assert.equal(r.steps.length, 0)
  assert.deepEqual(r.transitions.map((t) => t.id), ['31'])
  assert.ok(!gone.log.some((x) => x[0] === 'comment' || x[0] === 'transition'))
  const disabled = recorder()
  assert.equal((await wr.performWrite({ client: disabled, key: 'ABC-1', comment: 'hi', transitionId: '41' })).moved, true)
  assert.ok(!disabled.log.some((x) => x[0] === 'comment'))
  const status = recorder({ status: 'In Review' })
  const r3 = await wr.performWrite({ client: status, key: 'ABC-1', comment: 'hi', transitionId: '21', expectStatus: 'To Do' })
  assert.equal(r3.moved, true)
  assert.equal(r3.status, 'In Review')
  assert.match(r3.error, /its status is now In Review.*nothing was written/)
  assert.ok(!status.log.some((x) => x[0] === 'comment'))
  // The re-read itself failing: nothing written either.
  const broken = { ...recorder(), transitions: async () => { throw new Error('cannot reach https://acme.atlassian.net') }, comment: async () => assert.fail('no comment') }
  const r4 = await wr.performWrite({ client: broken, key: 'ABC-1', comment: 'hi', transitionId: '21' })
  assert.match(r4.error, /could not read the possible moves again, so nothing was written/)
})

test('the reply page: one button whose label follows the choice, disabled while nothing would happen', () => {
  assert.deepEqual(rl.replyAction('', ''), { label: 'Post comment', disabled: true, what: 'none' })
  assert.deepEqual(rl.replyAction('  \n ', ''), { label: 'Post comment', disabled: true, what: 'none' })
  assert.deepEqual(rl.replyAction('hi', ''), { label: 'Post comment', disabled: false, what: 'comment' })
  assert.deepEqual(rl.replyAction('', '21'), { label: 'Move', disabled: false, what: 'move' })
  assert.deepEqual(rl.replyAction('hi', '21'), { label: 'Post and move', disabled: false, what: 'both' })
  assert.equal(rl.replyAction('x'.repeat(32001), '').disabled, true)
  const list = wr.parseTransitions(TRANSITIONS)
  assert.deepEqual(rl.moveOption(list[0]), { value: '21', text: 'Start progress (to In Progress)', disabled: false })
  assert.deepEqual(rl.moveOption(list[1]), { value: '31', text: 'Done', disabled: false })
  assert.deepEqual(rl.moveOption(list[2]), { value: '41', text: 'Resolve (to Resolved) — needs fields: open in Jira', disabled: true })
  assert.equal(rl.keepChoice(list, '21'), '21')
  assert.equal(rl.keepChoice(list, '41'), '', 'a disabled one is not kept')
  assert.equal(rl.keepChoice(list, '99'), '')
})

// ---- the client's writes ----

test('client: a comment is POSTed as ADF to the site with the token', async () => {
  const jira = fakeJira()
  const c = make(jira)
  assert.deepEqual(await c.comment('ABC-1', 'one\n\ntwo'), { id: '9001' })
  const post = jira.calls.find((x) => x.method === 'POST')
  assert.equal(post.url, `${SITE}/rest/api/3/issue/ABC-1/comment`)
  assert.equal(post.redirect, 'manual')
  assert.ok(post.auth)
  assert.deepEqual(JSON.parse(post.body), { body: wr.commentAdf('one\n\ntwo') })
  // The token kind was settled by a read first: the write was never the probe.
  assert.ok(jira.calls.indexOf(post) > 0)
  assert.equal(jira.calls[0].method, 'GET')
})

test('client: an empty, too long or badly keyed comment is refused before any request', async () => {
  const jira = fakeJira()
  const c = make(jira)
  await assert.rejects(c.comment('ABC-1', '  '), /empty/)
  await assert.rejects(c.comment('ABC-1', 'x'.repeat(32001)), /at most 32,000/)
  for (const bad of ['abc-1', 'ABC-1/../../x', 'ABC-1?x=1', 'ABC', '']) await assert.rejects(c.comment(bad, 'hi'), /not an issue key/, bad)
  await assert.rejects(c.transition('ABC-1', '21/../1'), /digits only/)
  assert.equal(jira.calls.length, 0)
})

test('client: transitions read with expand=transitions.fields, the move POSTed as { transition: { id } }', async () => {
  const jira = fakeJira()
  const c = make(jira)
  const list = await c.transitions('ABC-1')
  assert.deepEqual(list.map((t) => [t.id, t.enabled]), [['21', true], ['31', true], ['41', false]])
  await c.transition('ABC-1', '21')
  assert.deepEqual(jira.writes, [{ method: 'POST', key: 'ABC-1', what: 'transitions', body: { transition: { id: '21' } } }])
})

test('client: a scoped token writes through the gateway, never to the site', async () => {
  const jira = fakeJira({ scoped: true })
  const c = make(jira)
  await c.comment('ABC-1', 'hi')
  const posts = jira.calls.filter((x) => x.method === 'POST')
  assert.equal(posts.length, 1)
  assert.ok(posts[0].url.startsWith(`${GATEWAY}/ex/jira/`))
})

test('client: a write never follows a redirect, whatever the status', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const jira = fakeJira({ routes: (url, init) => (init.method === 'POST' ? new Response(null, { status, headers: { location: 'https://evil.example/collect' } }) : undefined) })
    const c = make(jira)
    await assert.rejects(c.comment('ABC-1', 'hi'), (e) => e.kind === 'unsafe' && /redirect.*never sent on/.test(e.message), String(status))
    assert.equal(jira.calls.filter((x) => x.method === 'POST').length, 1, `${status}: sent once`)
    assert.ok(!jira.calls.some((x) => x.url.startsWith('https://evil.example')), `${status}: not followed`)
  }
  // Same-origin too: a write is never re-sent anywhere.
  const same = fakeJira({ routes: (url, init) => (init.method === 'POST' ? new Response(null, { status: 307, headers: { location: `${SITE}/rest/api/3/issue/ABC-2/comment` } }) : undefined) })
  await assert.rejects(make(same).transition('ABC-1', '21'), /redirect/)
  assert.equal(same.calls.filter((x) => x.method === 'POST').length, 1)
})

test('client: 403 says the token may not write (write:jira-work); 400 shows Jira\'s reasons, cut', async () => {
  const f403 = fakeJira({ failComment: 403 })
  await assert.rejects(make(f403).comment('ABC-1', 'hi'), (e) => e.kind === 'forbidden' && /may not write here \(403\).*write:jira-work/.test(e.message))
  const f400 = fakeJira({ failTransition: 400 })
  await assert.rejects(make(f400).transition('ABC-1', '41'), (e) => e.status === 400 && /moving ABC-1: Jira refused it \(400\): transitions refused; Resolution is required\./.test(e.message))
  const long = fakeJira({ routes: (url, init) => (init.method === 'POST' ? new Response(JSON.stringify({ errorMessages: ['x'.repeat(5000)] }), { status: 400 }) : undefined) })
  await assert.rejects(make(long).comment('ABC-1', 'hi'), (e) => e.message.length < 500)
})
