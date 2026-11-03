'use strict'
// The inbox-feed service: the pure mapping (lib/feed.js) and the host's side (the cache it reads,
// the states, open, the changed event, an older app without useAll). Made-up issues only.
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const feed = require('../dist/lib/feed')
const { mentionedBy } = require('../dist/lib/triage')
const { fakeJira, fakeCtx, fakeTriage, NOW, CONFIGURED } = require('./fakes')

const issue = (key, o = {}) => ({ key, summary: `Summary of ${key}`, status: 'In Progress', priority: 'High', updated: `2026-11-02T10:00:00.000+0000`, updatedAt: NOW - 3600000, events: [], full: true, ...o })
const row = (key, o = {}) => ({ issue: issue(key, o.issue), lane: o.lane || 'inProgress', unread: Boolean(o.unread), newCount: o.unread ? 1 : 0, verdict: o.level ? { priority: o.level } : null })
const build = (rows, limit) => feed.buildItems(rows, { limit, mentionedBy })

// ---- the mapping ----

test('an item: key as id, updated as rev, "KEY summary", assignment and priority, status, ms of updated', () => {
  const [it] = build([row('APP-1', { level: 'action', unread: true })])
  assert.deepEqual(it, { id: 'APP-1', rev: '2026-11-02T10:00:00.000+0000', title: 'APP-1 Summary of APP-1', from: 'assigned to you · High', where: 'In Progress', at: NOW - 3600000, level: 'action', unread: true })
})

test('a mentioned row says who mentioned the person; no priority leaves it out', () => {
  const r = row('APP-2', { lane: 'mentioned', issue: { priority: '', events: [{ id: 'c1', kind: 'comment', at: 1, by: 'Dana Q', mine: false, mentionsMe: true, text: 'hi' }] } })
  assert.equal(build([r])[0].from, 'mentioned by Dana Q')
  assert.equal(build([row('APP-3', { lane: 'mentioned' })])[0].from, 'mentioned by someone · High')
})

test('rev moves with the issue (updated), not with the seen state', () => {
  const a = build([row('APP-1', { unread: false })])[0]
  const b = build([row('APP-1', { unread: true })])[0]
  const c = build([row('APP-1', { issue: { updated: '2026-11-02T11:00:00.000+0000' } })])[0]
  assert.equal(a.rev, b.rev)
  assert.notEqual(a.rev, c.rev)
  assert.equal(build([row('APP-1', { issue: { updated: '' } })])[0].rev, String(NOW - 3600000), 'no updated string: the time')
})

test('level: the verdict; without one the status and priority rule (what triage is handed)', () => {
  assert.equal(feed.levelOf(row('APP-1', { level: 'urgent' })), 'urgent')
  assert.equal(feed.levelOf(row('APP-1')), 'action', 'in progress, seen: action')
  assert.equal(feed.levelOf(row('APP-1', { lane: 'backlog' })), 'noise', 'backlog, nothing new: noise')
  assert.equal(feed.levelOf(row('APP-1', { lane: 'backlog', unread: true })), 'urgent', 'unread and High')
  assert.equal(feed.levelOf(row('APP-1', { lane: 'backlog', unread: true, issue: { priority: 'Low' } })), 'fyi')
  assert.equal(feed.levelOf(row('APP-1', { lane: 'done' })), 'noise')
  assert.equal(feed.levelOf(row('APP-1', { lane: 'mentioned' })), 'fyi')
  assert.equal(feed.levelOf({ ...row('APP-1'), verdict: { priority: 'bogus' } }), 'action', 'an unknown verdict is ignored')
})

test('order: level first, then the newest update; noise left out unless nothing else', () => {
  const rows = [
    row('APP-1', { level: 'fyi', issue: { updatedAt: 300 } }),
    row('APP-2', { level: 'urgent', issue: { updatedAt: 100 } }),
    row('APP-3', { level: 'action', issue: { updatedAt: 200 } }),
    row('APP-4', { level: 'action', issue: { updatedAt: 250 } }),
    row('APP-5', { level: 'noise', issue: { updatedAt: 900 } }),
  ]
  assert.deepEqual(build(rows).map((i) => i.id), ['APP-2', 'APP-4', 'APP-3', 'APP-1'])
  assert.deepEqual(build([rows[4], row('APP-6', { level: 'noise', issue: { updatedAt: 1000 } })]).map((i) => i.id), ['APP-6', 'APP-5'], 'only noise: shown')
  assert.deepEqual(build([]), [])
})

test('caps: limit clamped to 1..50, a key once, text cut', () => {
  const many = Array.from({ length: 80 }, (_, n) => row(`APP-${n + 1}`, { level: 'fyi' }))
  assert.equal(build(many).length, 50)
  assert.equal(build(many, 500).length, 50)
  assert.equal(build(many, 0).length, 1)
  assert.equal(build(many, -4).length, 1)
  assert.equal(build(many, 7.9).length, 7)
  assert.equal(build(many, 'x').length, 50)
  assert.equal(build([row('APP-1'), row('APP-1')]).length, 1)
  const [long] = build([row('APP-1', { issue: { summary: 'x'.repeat(900), status: 'y'.repeat(500), priority: 'z'.repeat(500) } })])
  assert.ok(long.title.length <= 300 && long.from.length <= 120 && long.where.length <= 120)
  assert.throws(() => feed.itemsOptions('x'), /jira: the options/)
  assert.throws(() => feed.itemsOptions([]), /jira: the options/)
  assert.deepEqual(feed.itemsOptions(), { limit: 50 })
})

test('dueAt only when set (and not on a Done issue)', () => {
  const due = Date.parse('2026-11-05')
  assert.equal(build([row('APP-1', { issue: { dueAt: due } })])[0].dueAt, due)
  assert.ok(!('dueAt' in build([row('APP-1')])[0]))
  assert.ok(!('dueAt' in build([row('APP-1', { lane: 'done', issue: { dueAt: due } })])[0]))
})

test('the due date is read from the header', () => {
  const { header } = require('../dist/lib/model')
  assert.equal(header('APP-1', { duedate: '2026-11-05' }).dueAt, Date.parse('2026-11-05'))
  assert.ok(!('dueAt' in header('APP-1', { duedate: null })))
  assert.ok(!('dueAt' in header('APP-1', { duedate: 'soon' })))
})

// ---- the host ----

function boot(opts = {}) {
  const jira = fakeJira(opts.jira)
  const ctx = fakeCtx({ project: opts.project === undefined ? CONFIGURED : opts.project, triage: fakeTriage(), reviewer: opts.reviewer, sessions: opts.sessions })
  if (opts.mutate) opts.mutate(ctx)
  const h = host._start(ctx, { setInterval: () => 0, clearInterval: () => {}, fetch: jira.fetch, now: () => NOW, setTimeout: () => 0, clearTimeout: () => {}, platform: 'linux', cliWaitMs: 2000, imageWaitMs: 0 })
  return { jira, ctx, h }
}

test('describe, features (none: no markRead), and markRead is "no method"', async () => {
  const { ctx, h } = boot()
  assert.deepEqual(await ctx.callService('inbox-feed', 'describe'), { label: 'Jira', badge: 'JIRA', color: 'blue', kind: 'issues' })
  assert.deepEqual(await ctx.callService('inbox-feed', 'features'), [])
  await assert.rejects(ctx.callService('inbox-feed', 'markRead', ['APP-1']), /has no method "markRead"/)
  await h.stop()
})

test('items from the polled cache: ok, ordered, no extra request, fields as the contract says', async () => {
  const { ctx, h, jira } = boot()
  await h.pollNow('test')
  await h.S.classifying
  const calls = jira.calls.length
  const r = await ctx.callService('inbox-feed', 'items', [{ limit: 10 }])
  assert.equal(jira.calls.length, calls, 'the cache only')
  assert.equal(r.state, 'ok')
  assert.equal(r.asOf, h.S.lastPoll)
  assert.ok(!('message' in r))
  assert.ok(r.items.length > 0)
  const keys = r.items.map((i) => i.id)
  assert.ok(keys.includes('ABC-1') && !keys.includes('ABC-2'), 'ABC-2 is a quiet backlog issue: noise, left out')
  const levels = r.items.map((i) => i.level)
  assert.deepEqual(levels, [...levels].sort((a, b) => ['urgent', 'action', 'fyi', 'noise'].indexOf(a) - ['urgent', 'action', 'fyi', 'noise'].indexOf(b)))
  for (const it of r.items) {
    assert.match(it.title, new RegExp(`^${it.id} `))
    assert.equal(typeof it.rev, 'string')
    assert.ok(it.at > 0)
    assert.equal(it.unread, false, 'first run: everything seen')
  }
  assert.equal((await ctx.callService('inbox-feed', 'items', [{ limit: 1 }])).items.length, 1)
  assert.equal((await ctx.callService('inbox-feed', 'items')).items.length, r.items.length, 'no argument: the default limit')
  await assert.rejects(ctx.callService('inbox-feed', 'items', ['x']), /jira: the options/)
  await h.stop()
})

test('items: signedOut when not configured, signedOut when Jira refuses the token (cached items still come), error otherwise', async () => {
  const none = boot({ project: {} })
  const r0 = await none.ctx.callService('inbox-feed', 'items')
  assert.equal(r0.state, 'signedOut')
  assert.deepEqual(r0.items, [])
  assert.match(r0.message, /not configured/)
  await none.h.stop()

  const { ctx, h } = boot()
  await h.pollNow('test')
  await h.S.classifying
  const before = (await ctx.callService('inbox-feed', 'items')).items
  assert.ok(before.length)
  h.S.error = 'Jira refused the API token'
  h.S.errorKind = 'auth'
  const r1 = await ctx.callService('inbox-feed', 'items')
  assert.equal(r1.state, 'signedOut')
  assert.deepEqual(r1.items, before)
  assert.match(r1.message, /refused/)
  h.S.errorKind = 'network'
  h.S.error = 'x'.repeat(1000)
  const r2 = await ctx.callService('inbox-feed', 'items')
  assert.equal(r2.state, 'error')
  assert.ok(r2.message.length <= 300)
  assert.deepEqual(r2.items, before)
  await h.stop()
})

test('a failed poll (token refused) leaves the feed signed out', async () => {
  const { ctx, h } = boot({ jira: { token: 'another-token' } })
  await h.pollNow('test')
  const r = await ctx.callService('inbox-feed', 'items')
  assert.equal(r.state, 'signedOut')
  await h.stop()
})

test('open: a bad key is refused, a key outside the lanes too, a listed key opens its issue view', async () => {
  const { ctx, h } = boot()
  await h.pollNow('test')
  await h.S.classifying
  for (const bad of ['', 'abc', '../etc', 'APP-1/../x', 42, null, {}, 'A'.repeat(100) + '-1']) {
    await assert.rejects(ctx.callService('inbox-feed', 'open', [bad]), /jira: not an issue key/, String(bad))
  }
  await assert.rejects(ctx.callService('inbox-feed', 'open', ['ZZZ-99']), /jira: ZZZ-99 is not in the lanes/)
  await assert.rejects(ctx.callService('inbox-feed', 'open'), /jira: not an issue key/)
  const before = ctx.posts.length + ctx.overlays.length + ctx.opened.length
  const r = await ctx.callService('inbox-feed', 'open', ['ABC-1'])
  assert.equal(r, undefined)
  assert.ok(ctx.posts.length + ctx.overlays.length + ctx.opened.length > before, 'the issue view was opened')
  await h.stop()
})

test('open with the reviewer: the issue goes to its annotate, as a row click does', async () => {
  const calls = []
  const reviewer = { annotate: async (a) => (calls.push(a), { ok: true }) }
  const { ctx, h } = boot({ reviewer })
  await h.pollNow('test')
  await h.S.classifying
  await ctx.callService('inbox-feed', 'open', ['ABC-1'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].key, 'jira:ABC-1')
  await h.stop()
})

test('changed is emitted after a poll (and after a read change)', async () => {
  const { ctx, h } = boot()
  assert.equal(ctx.emitted.length, 0)
  await h.pollNow('test')
  const after = ctx.emitted.filter((e) => e.service === 'inbox-feed' && e.event === 'changed')
  assert.ok(after.length >= 1)
  assert.deepEqual(after[0].data, {})
  const n = after.length
  await h.pollNow('again')
  assert.ok(ctx.emitted.length > n)
  const m = ctx.emitted.length
  await ctx.runCli(['unread', 'ABC-1'])
  assert.ok(ctx.emitted.length > m)
  await h.stop()
})

test('an emit that throws never breaks a poll', async () => {
  const { ctx, h } = boot({ mutate: (c) => (c.services.emit = () => { throw new Error('boom') }) })
  await h.pollNow('test')
  assert.equal(h.S.error, null)
  assert.ok(ctx.lastState().lanes.length)
  await h.stop()
})

test('the jira service is unchanged beside it', async () => {
  const { ctx, h } = boot()
  assert.deepEqual(Object.keys(ctx.provided).sort(), ['inbox-feed', 'jira'])
  assert.deepEqual(Object.keys(ctx.provided.jira).sort(), ['document', 'issue', 'site'])
  assert.deepEqual(Object.keys(ctx.provided['inbox-feed']).sort(), ['describe', 'features', 'items', 'open'])
  assert.equal((await ctx.callService('jira', 'site')).site, 'https://acme.atlassian.net')
  await assert.rejects(ctx.callService('jira', 'issue', ['nope']), /jira: not an issue key/)
  await h.stop()
})

test('an older app (services without useAll or emit) still activates and provides', async () => {
  const { ctx, h } = boot({ mutate: (c) => { delete c.services.emit; delete c.services.caller } })
  assert.equal('useAll' in ctx.services, false)
  assert.deepEqual(Object.keys(ctx.provided).sort(), ['inbox-feed', 'jira'])
  await h.pollNow('test')
  await h.S.classifying
  assert.equal((await ctx.callService('inbox-feed', 'items')).state, 'ok')
  await h.stop()
})

test('the manifest provides jira and inbox-feed at 0.6.0', () => {
  const m = require('../plugin.json')
  assert.equal(m.version, '0.6.0')
  assert.deepEqual(m.services.provides, { jira: 1, 'inbox-feed': 1 })
})
