'use strict'
// The inbox-feed service (v2, 0.7.0): the pure mapping (lib/feed.js: fields, labels, caps, scope,
// the diff), the host's snapshot from its cache in each state, act with a foreign id or an action
// the item lacks, the item / gone / sync events after a poll, a mark, a settings change and an
// error, and an older app (no useAll, no emit). Made-up issues only.
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const feed = require('../dist/lib/feed')
const { header } = require('../dist/lib/model')
const { current } = require('../dist/lib/poll')
const { mentionedBy } = require('../dist/lib/triage')
const { fakeJira, fakeCtx, fakeTriage, NOW, CONFIGURED } = require('./fakes')

const issue = (key, o = {}) => ({ key, project: key.split('-')[0], summary: `Summary of ${key}`, status: 'In Progress', priority: 'High', type: 'Bug', assignee: 'Oleg Example', reporter: 'Ann Smith', updated: '2026-11-02T10:00:00.000+0000', updatedAt: NOW - 3600000, events: [], description: '', full: true, ...o })
const row = (key, o = {}) => ({ issue: issue(key, o.issue), lane: o.lane || 'inProgress', unread: Boolean(o.unread), newCount: o.unread ? 1 : 0, verdict: o.level ? { priority: o.level } : null })
const items = (rows, o = {}) => feed.feedItems(rows, { mentionedBy, ...o })
const one = (r, o = {}) => feed.issueItem(r, { mentionedBy, ...o })

// ---- the mapping ----

test('issueItem: every field of the contract; rev is updated, place the project and the status', () => {
  const r = row('APP-1', { unread: true, issue: { description: 'Start\nof it', labels: ['backend'], dueAt: Date.parse('2026-11-06'), events: [{ id: 'c1', kind: 'comment', at: 5, by: 'Dana Q', mine: false, text: 'Seen  on\nstaging' }] } })
  assert.deepEqual(one(r), {
    id: 'APP-1',
    rev: '2026-11-02T10:00:00.000+0000',
    title: 'APP-1 Summary of APP-1',
    time: NOW - 3600000,
    read: false,
    place: { kind: 'project', name: 'APP', status: 'In Progress' },
    actions: [{ id: 'open', label: 'Open' }, { id: 'markRead', label: 'Mark read' }],
    preview: 'Seen on staging',
    from: { name: 'Dana Q' },
    to: 'direct',
    labels: ['assigned', 'priority:High', 'type:Bug', 'due:2026-11-06', 'label:backend'],
  })
})

test('issueItem: a read issue offers markUnread; the preview is the latest comment, else the description start; no level, no noise', () => {
  const it = one(row('APP-1', { level: 'noise', issue: { description: 'Desc  start' } }))
  assert.equal(it.read, true)
  assert.deepEqual(it.actions.map((a) => a.id), ['open', 'markUnread'])
  assert.equal(it.preview, 'Desc start', 'no comment: the description')
  assert.ok(!('level' in it) && !('unread' in it) && !('dueAt' in it) && !('where' in it) && !('at' in it))
  assert.ok(!('preview' in one(row('APP-1'))), 'nothing to say: no preview')
  const two = one(row('APP-1', { issue: { description: 'D', events: [{ kind: 'change', at: 1, by: 'x', text: 'status: a → b' }, { kind: 'comment', at: 2, by: 'A', text: 'first' }, { kind: 'comment', at: 3, by: 'B', text: 'last' }, { kind: 'change', at: 4, by: 'x', text: 'status: b → c' }] } }))
  assert.equal(two.preview, 'last')
})

test('issueItem: assigned lanes say assigned and direct; a Mentioned issue says mentioned, cc, who mentioned and who has it', () => {
  const events = [{ id: 'c1', kind: 'comment', at: 1, by: 'Dana Q', mine: false, mentionsMe: true, text: 'hi' }]
  const m = one(row('APP-2', { lane: 'mentioned', issue: { events, assignee: 'Bob Jones' } }))
  assert.equal(m.to, 'cc')
  assert.equal(m.mentionsMe, true)
  assert.deepEqual(m.from, { name: 'Dana Q' })
  assert.deepEqual(m.labels, ['mentioned', 'priority:High', 'type:Bug', 'assignee:Bob Jones'])
  assert.deepEqual(one(row('APP-3', { lane: 'mentioned', issue: { assignee: '', events: [] } })).labels.slice(-1), ['unassigned'])
  const a = one(row('APP-1', { lane: 'onHold' }))
  assert.equal(a.to, 'direct')
  assert.ok(!('mentionsMe' in a))
  assert.equal(a.labels[0], 'assigned')
  assert.ok(!a.labels.some((l) => l.startsWith('assignee:') || l === 'unassigned'))
})

test('issueItem: an assigned issue mentioned recently is also labelled mentioned (the lane window decides)', () => {
  const events = [{ id: 'c1', kind: 'comment', at: 1000, by: 'Dana Q', mine: false, mentionsMe: true, text: 'hi' }]
  const r = row('APP-1', { issue: { events } })
  const hit = one(r, { since: 500 })
  assert.equal(hit.mentionsMe, true)
  assert.deepEqual(hit.labels.slice(0, 2), ['assigned', 'mentioned'])
  assert.ok(!('mentionsMe' in one(r, { since: 2000 })), 'too old')
  assert.ok(!('mentionsMe' in one(r)), 'no window given: no claim')
  const mine = row('APP-1', { issue: { events: [{ id: 'c2', kind: 'comment', at: 1000, by: 'Me', mine: true, mentionsMe: true, text: 'x' }] } })
  assert.ok(!('mentionsMe' in one(mine, { since: 500 })), 'a mention by the person themselves is not one')
})

test('issueItem: from is the last other person, else the reporter; nothing known leaves it out; time never 0; no priority or type or status leaves the label out', () => {
  assert.deepEqual(one(row('APP-1')).from, { name: 'Ann Smith' })
  assert.deepEqual(one(row('APP-1', { issue: { events: [{ kind: 'comment', at: 1, by: 'Me', mine: true, text: 'a' }, { kind: 'comment', at: 2, by: 'Cy', mine: false, text: 'b' }, { kind: 'comment', at: 3, by: 'Me', mine: true, text: 'c' }] } })).from, { name: 'Cy' })
  const bare = one(row('APP-1', { issue: { reporter: '', priority: '', type: '', status: '', updatedAt: 0, updated: '' } }))
  assert.ok(!('from' in bare))
  assert.ok(bare.time >= 1)
  assert.deepEqual(bare.labels, ['assigned'])
  assert.deepEqual(bare.place, { kind: 'project', name: 'APP' })
  assert.ok(bare.rev.length >= 1)
})

test('rev moves with the issue (updated), not with the seen state', () => {
  const a = one(row('APP-1', { unread: false }))
  const b = one(row('APP-1', { unread: true }))
  const c = one(row('APP-1', { issue: { updated: '2026-11-02T11:00:00.000+0000' } }))
  assert.equal(a.rev, b.rev)
  assert.notEqual(a.rev, c.rev)
  assert.equal(one(row('APP-1', { issue: { updated: '' } })).rev, String(NOW - 3600000), 'no updated string: the time')
})

test('issueItem: caps (title 300, preview 1000, name 120, status 60, labels 20 of 40), no duplicate labels', () => {
  const many = Array.from({ length: 40 }, (_, n) => `l${n}`)
  const long = one(row('APP-1', { issue: { summary: 'x'.repeat(900), status: 'y'.repeat(500), project: 'p'.repeat(500), reporter: 'r'.repeat(500), description: 'd'.repeat(5000), priority: 'z'.repeat(100), labels: [...many, 'l0', 'L1', 'q'.repeat(100)] } }))
  assert.ok(long.title.length <= 300 && long.preview.length <= 1000 && long.from.name.length <= 120 && long.place.name.length <= 120 && long.place.status.length <= 60)
  assert.ok(long.labels.length <= 20 && long.labels.every((l) => l.length >= 1 && l.length <= 40))
  assert.equal(new Set(long.labels.map((l) => l.toLowerCase())).size, long.labels.length)
  const dup = one(row('APP-1', { issue: { labels: ['l0', 'L0'] } }))
  assert.equal(dup.labels.filter((l) => l.toLowerCase() === 'label:l0').length, 1)
})

test('feedItems: newest first then by id, every lane but Done, a key once, quiet issues kept, no cap of 50', () => {
  const rows = [
    row('APP-1', { level: 'noise', issue: { updatedAt: 300 } }),
    row('APP-2', { issue: { updatedAt: 100 } }),
    row('APP-3', { lane: 'backlog', issue: { updatedAt: 300 } }),
    row('APP-4', { lane: 'done', issue: { updatedAt: 900 } }),
    row('APP-5', { lane: 'onHold', issue: { updatedAt: 200 } }),
    row('APP-1', { lane: 'mentioned', issue: { updatedAt: 999 } }),
  ]
  assert.deepEqual(items(rows).map((i) => i.id), ['APP-1', 'APP-3', 'APP-5', 'APP-2'])
  assert.deepEqual(items([]), [])
  const many = Array.from({ length: 80 }, (_, n) => row(`APP-${n + 1}`))
  assert.equal(items(many).length, 80)
  const huge = Array.from({ length: 1200 }, (_, n) => row(`APP-${n + 1}`, { issue: { updatedAt: n + 1 } }))
  const all = items(huge)
  assert.equal(all.length, 1000, 'the contract cap')
  assert.equal(all[0].id, 'APP-1200', 'the newest kept')
  assert.equal(items(huge, { limit: Infinity }).length, 1200)
  assert.equal(items(huge, { limit: 7 }).length, 7)
})

test('diffFeed: new and changed (each field) are items, missing ids are gone, a no-op is nothing', () => {
  const base = one(row('APP-1', { issue: { labels: ['a'] } }))
  const same = JSON.parse(JSON.stringify(base))
  assert.deepEqual(feed.diffFeed([base], [same]), { items: [], gone: [] })
  assert.deepEqual(feed.diffFeed([], [base]).items.map((i) => i.id), ['APP-1'])
  assert.deepEqual(feed.diffFeed([base], []), { items: [], gone: ['APP-1'] })
  const changes = [
    row('APP-1', { issue: { labels: ['a'], status: 'Done-ish' } }),
    row('APP-1', { issue: { labels: ['a'], priority: 'Low' } }),
    row('APP-1', { issue: { labels: ['a', 'b'] } }),
    row('APP-1', { issue: { labels: ['a'], summary: 'new' } }),
    row('APP-1', { issue: { labels: ['a'], updated: 'later' } }),
    row('APP-1', { unread: true, issue: { labels: ['a'] } }),
    row('APP-1', { lane: 'mentioned', issue: { labels: ['a'] } }),
    row('APP-1', { issue: { labels: ['a'], description: 'new text' } }),
  ]
  for (const c of changes) assert.deepEqual(feed.diffFeed(new Map([[base.id, base]]), [one(c)]).items.length, 1, JSON.stringify(c.issue))
  assert.deepEqual(feed.goneChunks(Array.from({ length: 1001 }, (_, n) => `A-${n}`)).map((c) => c.length), [500, 500, 1])
  assert.deepEqual(feed.goneChunks([]), [])
})

test('scopeLine: right for every lane combination, mentionDays singular and plural, at most 120 characters', () => {
  const L = (o) => ({ lanes: { backlog: false, inProgress: false, onHold: false, mentioned: false, done: false, ...o }, mentionDays: 7 })
  assert.equal(feed.scopeLine(L({ backlog: true, inProgress: true, onHold: true, mentioned: true })), 'my open issues + mentions of the last 7 days')
  assert.equal(feed.scopeLine(L({ backlog: true, inProgress: true, onHold: true })), 'my open issues')
  assert.equal(feed.scopeLine(L({ backlog: true, inProgress: true })), 'my issues in Backlog, In progress')
  assert.equal(feed.scopeLine(L({ onHold: true, mentioned: true })), 'my issues in On hold + mentions of the last 7 days')
  assert.equal(feed.scopeLine({ ...L({ mentioned: true }), mentionDays: 1 }), 'mentions of the last day')
  assert.match(feed.scopeLine(L({ done: true })), /^nothing/, 'Done alone: nothing reaches the feed')
  assert.match(feed.scopeLine(L({})), /^nothing/)
  assert.ok(feed.scopeLine(L({ backlog: true })).length <= 120)
})

test('the header keeps Jira labels (a plain list of strings) and the cached copy never keeps stale ones or a stale due date', () => {
  assert.deepEqual(header('APP-1', { labels: ['a', ' b ', '', 3, null] }).labels, ['a', 'b'])
  assert.ok(!('labels' in header('APP-1', { labels: [] })))
  assert.ok(!('labels' in header('APP-1', {})))
  assert.ok(header('APP-1', { labels: Array.from({ length: 50 }, (_, n) => `l${n}`) }).labels.length <= 30)
  const cache = { issues: { 'APP-1': { ...issue('APP-1'), labels: ['old'], dueAt: 5 } } }
  const now = current(cache, header('APP-1', { labels: ['new'], duedate: '2026-11-05' }))
  assert.deepEqual(now.labels, ['new'])
  assert.equal(now.dueAt, Date.parse('2026-11-05'))
  const gone = current(cache, header('APP-1', {}))
  assert.ok(!('labels' in gone) && !('dueAt' in gone))
})

test('the due date is read from the header', () => {
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
  const impl = () => ctx.provided['inbox-feed']
  return { jira, ctx, h, impl }
}
const events = (b, name) => b.ctx.emitted.filter((e) => e.service === 'inbox-feed' && (!name || e.event === name))
const settle = () => new Promise((r) => setTimeout(r, 20))

test('describe with its scope, features (none), and v1 methods are gone', async () => {
  const { ctx, h } = boot()
  assert.deepEqual(await ctx.callService('inbox-feed', 'describe'), { label: 'Jira', badge: 'JIRA', color: 'blue', kind: 'issues', scope: 'my issues in Backlog, In progress + mentions of the last 7 days' })
  assert.deepEqual(await ctx.callService('inbox-feed', 'features'), [])
  assert.deepEqual(Object.keys(ctx.provided['inbox-feed']).sort(), ['act', 'describe', 'features', 'snapshot'])
  await assert.rejects(ctx.callService('inbox-feed', 'items'), /has no method "items"/)
  await assert.rejects(ctx.callService('inbox-feed', 'open', ['ABC-1']), /has no method "open"/)
  await h.stop()
})

test('describe: the scope follows the lane settings, in every combination', async () => {
  const b = boot({ project: { ...CONFIGURED, lanes: { backlog: false, inProgress: false, onHold: true, mentioned: false, done: true }, mentionDays: 1 } })
  assert.equal((await b.ctx.callService('inbox-feed', 'describe')).scope, 'my issues in On hold')
  await b.ctx.changeSettings({ ...CONFIGURED, lanes: { backlog: true, inProgress: true, onHold: true, mentioned: true }, mentionDays: 30 })
  assert.equal((await b.ctx.callService('inbox-feed', 'describe')).scope, 'my open issues + mentions of the last 30 days')
  await b.h.stop()
})

test('snapshot from the polled cache: ok, newest first, no extra request, quiet issues kept, plain data', async () => {
  const { ctx, h, jira } = boot()
  await h.pollNow('test')
  await h.S.classifying
  const calls = jira.calls.length
  const r = await ctx.callService('inbox-feed', 'snapshot')
  assert.equal(jira.calls.length, calls, 'the cache only')
  assert.equal(r.state, 'ok')
  assert.equal(r.asOf, h.S.lastPoll)
  assert.ok(!('message' in r))
  assert.deepEqual(r.items.map((i) => i.id).sort(), ['ABC-1', 'ABC-2', 'ABC-4', 'XYZ-9'], 'ABC-2 is a quiet backlog issue: kept')
  const times = r.items.map((i) => i.time)
  assert.deepEqual(times, [...times].sort((a, b) => b - a))
  const by = Object.fromEntries(r.items.map((i) => [i.id, i]))
  assert.deepEqual(by['ABC-1'].place, { kind: 'project', name: 'ABC', status: 'In Progress' })
  assert.deepEqual(by['ABC-1'].labels.slice(0, 4), ['assigned', 'mentioned', 'priority:High', 'type:Bug'], 'assigned, and mentioned in a comment of the window')
  assert.equal(by['ABC-1'].mentionsMe, true)
  assert.deepEqual(by['ABC-2'].labels.slice(0, 3), ['assigned', 'priority:Medium', 'type:Task'])
  assert.ok(by['ABC-1'].labels.includes('label:backend') && by['ABC-1'].labels.includes('label:customer-reported'))
  assert.equal(by['XYZ-9'].to, 'cc')
  assert.ok(by['XYZ-9'].labels.includes('mentioned') && by['XYZ-9'].labels.some((l) => l.startsWith('assignee:')))
  assert.equal(by['XYZ-9'].mentionsMe, true)
  for (const it of r.items) {
    assert.match(it.title, new RegExp(`^${it.id} `))
    assert.equal(typeof it.rev, 'string')
    assert.equal(it.read, true, 'first run: everything seen')
    assert.deepEqual(it.actions.map((a) => a.id), ['open', 'markUnread'])
  }
  assert.equal(r.items.length, 4, 'no 50 cap, no noise rule')
  await h.stop()
})

test('snapshot: the Done lane is not in it; with the lane on the issue still is not', async () => {
  const b = boot({ project: { ...CONFIGURED, lanes: { done: true } } })
  await b.h.pollNow('test')
  assert.ok(b.h.S.view.lanes.find((l) => l.id === 'done').rows.length, 'the panel shows Done')
  assert.ok(!(await b.ctx.callService('inbox-feed', 'snapshot')).items.some((i) => i.id === 'ABC-3'))
  await b.h.stop()
})

test('snapshot: signedOut when not configured, signedOut when Jira refuses the token (cached items still come), error otherwise', async () => {
  const none = boot({ project: {} })
  const r0 = await none.ctx.callService('inbox-feed', 'snapshot')
  assert.equal(r0.state, 'signedOut')
  assert.deepEqual(r0.items, [])
  assert.match(r0.message, /not configured/)
  await none.h.stop()

  const { ctx, h } = boot()
  await h.pollNow('test')
  await h.S.classifying
  const before = (await ctx.callService('inbox-feed', 'snapshot')).items
  assert.ok(before.length)
  h.S.error = 'Jira refused the API token'
  h.S.errorKind = 'auth'
  const r1 = await ctx.callService('inbox-feed', 'snapshot')
  assert.equal(r1.state, 'signedOut')
  assert.deepEqual(r1.items, before)
  assert.match(r1.message, /refused/)
  h.S.errorKind = 'network'
  h.S.error = 'x'.repeat(1000)
  const r2 = await ctx.callService('inbox-feed', 'snapshot')
  assert.equal(r2.state, 'error')
  assert.ok(r2.message.length <= 300)
  assert.deepEqual(r2.items, before)
  await h.stop()
})

test('a failed poll (token refused) leaves the feed signed out', async () => {
  const { ctx, h } = boot({ jira: { token: 'another-token' } })
  await h.pollNow('test')
  const r = await ctx.callService('inbox-feed', 'snapshot')
  assert.equal(r.state, 'signedOut')
  await h.stop()
})

test('act refuses a bad argument, a foreign key and an action the item lacks; nothing is opened or marked', async () => {
  const { ctx, h } = boot()
  await h.pollNow('test')
  await h.S.classifying
  const before = ctx.posts.length + ctx.overlays.length + ctx.opened.length
  for (const [id, action] of [[42, 'open'], ['ABC-1', null], [null, null], ['', 'open'], ['abc', 'open'], ['../etc', 'open'], ['ZZZ-99', 'open'], ['ABC-3', 'open']]) {
    const r = await ctx.callService('inbox-feed', 'act', [id, action])
    assert.equal(r.ok, false, String(id))
    assert.ok(r.message.length > 0 && r.message.length <= 300)
  }
  // ABC-1 is read: it has no markRead.
  const r = await ctx.callService('inbox-feed', 'act', ['ABC-1', 'markRead'])
  assert.deepEqual(r.ok, false)
  assert.match(r.message, /no action "markRead"/)
  assert.match((await ctx.callService('inbox-feed', 'act', ['ABC-1', 'x'.repeat(500)])).message, /no action/)
  assert.equal(ctx.posts.length + ctx.overlays.length + ctx.opened.length, before)
  await h.stop()
})

test('act open: a listed key opens its issue view, as a row click does', async () => {
  const calls = []
  const reviewer = { annotate: async (a) => (calls.push(a), { ok: true }) }
  const { ctx, h } = boot({ reviewer })
  await h.pollNow('test')
  await h.S.classifying
  assert.deepEqual(await ctx.callService('inbox-feed', 'act', ['ABC-1', 'open']), { ok: true })
  // A reviewer without prepare: nothing is on screen before the annotate, so act answers after it.
  await until(() => calls.length === 1)
  assert.equal(calls[0].key, 'jira:ABC-1')
  await h.stop()
})

test('act open without a reviewer: the plugin\'s own page', async () => {
  const { ctx, h } = boot()
  await h.pollNow('test')
  await h.S.classifying
  const before = ctx.overlays.length
  assert.deepEqual(await ctx.callService('inbox-feed', 'act', ['ABC-1', 'open']), { ok: true })
  assert.ok(ctx.overlays.length > before)
  await h.stop()
})

// Round-2 review: act answered ok before anything was on screen, so a failed read went only to this
// panel's notice and Inbox ended the item's "back" mark for an open the person never saw.
test('act open with nothing on screen yet (a reviewer without prepare, or a prepare that failed): a failed read is the act\'s refusal', async () => {
  const calls = []
  const annotate = async (a) => (calls.push(a.key), { opened: true })
  const reviewers = {
    'no prepare': { annotate },
    'prepare failed': {
      prepare: async () => {
        throw new Error('reviewer: the review overlay did not open: overlay: at most 3 open')
      },
      cancel: async () => ({ closed: false }),
      annotate,
    },
  }
  for (const [name, reviewer] of Object.entries(reviewers)) {
    const jira = {}
    const { ctx, h } = boot({ reviewer, jira })
    await h.pollNow('test')
    await h.S.classifying
    // The issue is gone at Jira by the time it is opened, with no cached copy to fall back on.
    jira.fail = { 'ABC-1': 404 }
    const cached = h.S.cache.issues['ABC-1']
    delete h.S.cache.issues['ABC-1']
    const r = await ctx.callService('inbox-feed', 'act', ['ABC-1', 'open'])
    assert.equal(r.ok, false, name)
    assert.match(r.message, /^jira: .*nope/, name)
    assert.deepEqual(calls, [], `${name}: nothing was annotated`)
    assert.equal(ctx.overlays.length, 0, `${name}: no reader page either`)
    // The same reviewer opens an issue that can be read: ok once the reviewer's overlay is filled.
    delete jira.fail
    h.S.cache.issues['ABC-1'] = cached
    assert.deepEqual(await ctx.callService('inbox-feed', 'act', ['ABC-1', 'open']), { ok: true }, name)
    assert.deepEqual(calls.splice(0), ['jira:ABC-1'], name)
    await h.stop()
  }
})

// Round-3 review: an open that ended without anything on screen (the reviewer refused the issue, or
// the app refused the reader page) set the panel's notice and returned, and act still answered ok.
test('act open: a reviewer (without prepare) refusing the issue is the act\'s refusal, with the notice\'s text', async () => {
  const calls = []
  const reviewer = {
    annotate: async (a) => {
      calls.push(a.key)
      throw new Error('reviewer: the review overlay did not open: overlay: at most 3 open')
    },
  }
  const { ctx, h } = boot({ reviewer })
  await h.pollNow('test')
  await h.S.classifying
  const r = await ctx.callService('inbox-feed', 'act', ['ABC-1', 'open'])
  assert.equal(r.ok, false)
  assert.match(r.message, /^jira: The reviewer could not open ABC-1: .*at most 3 open/)
  assert.deepEqual(calls, ['jira:ABC-1', 'jira:ABC-1'], 'html, then text')
  assert.equal(h.S.notice.kind, 'error', 'the panel says it too')
  assert.equal(ctx.overlays.length, 0)
  await h.stop()
})

test('act open: the app refusing our reader page is the act\'s refusal, with the notice\'s text', async () => {
  const { ctx, h } = boot({
    mutate: (c) => {
      c.overlay.start = () => {
        throw new Error('overlay: at most 3 open')
      }
    },
  })
  await h.pollNow('test')
  await h.S.classifying
  const r = await ctx.callService('inbox-feed', 'act', ['ABC-1', 'open'])
  assert.equal(r.ok, false)
  assert.match(r.message, /^jira: Cannot open the reader: overlay: at most 3 open/)
  await h.stop()
})

// Round-4 review: main never throws from start(); its refusal (3 open, 10 a minute) rejects the
// handle's result a moment later, and act answered ok for a reader page that never opened. And the
// issue was marked seen (read: true to Inbox) right after the read, before anything was shown.
const readOf = async (b, key) => (await b.ctx.callService('inbox-feed', 'snapshot')).items.find((i) => i.id === key).read

test('act open: a reader page whose result rejects (main refused it) is the act\'s refusal, and the issue stays unread', async () => {
  const b = boot({
    mutate: (c) => {
      const start = c.overlay.start
      c.overlay.start = (spec) => {
        const h = start(spec)
        const result = Promise.reject(new Error('overlay: bronos.jira already has 3 overlays open'))
        result.catch(() => {})
        return { ...h, result }
      }
    },
  })
  await b.h.pollNow('test')
  await b.h.S.classifying
  assert.deepEqual(await b.ctx.callService('inbox-feed', 'act', ['ABC-1', 'markUnread']), { ok: true })
  const r = await b.ctx.callService('inbox-feed', 'act', ['ABC-1', 'open'])
  assert.equal(r.ok, false)
  assert.match(r.message, /^jira: Cannot open the reader: overlay: bronos\.jira already has 3 overlays open/)
  assert.equal(await readOf(b, 'ABC-1'), false, 'an issue never shown stays unread')
  await b.h.stop()
})

test('act open: the loader the person closed (annotate { opened: false }) leaves the issue unread; a shown one marks it read', async () => {
  let answer = { opened: false }
  const calls = []
  const reviewer = {
    prepare: async () => ({ opened: true }),
    cancel: async () => ({ closed: false }),
    annotate: async (a) => (calls.push(a.key), answer),
  }
  const b = boot({ reviewer })
  await b.h.pollNow('test')
  await b.h.S.classifying
  assert.deepEqual(await b.ctx.callService('inbox-feed', 'act', ['ABC-1', 'markUnread']), { ok: true })
  // The prepared loader was up, so act answers ok; the person closed it while the issue loaded.
  assert.deepEqual(await b.ctx.callService('inbox-feed', 'act', ['ABC-1', 'open']), { ok: true })
  for (let i = 0; i < 100 && !calls.length; i++) await settle()
  await settle()
  assert.equal(await readOf(b, 'ABC-1'), false, 'an issue never shown stays unread')
  answer = { opened: true }
  assert.deepEqual(await b.ctx.callService('inbox-feed', 'act', ['ABC-1', 'open']), { ok: true })
  for (let i = 0; i < 100 && !(await readOf(b, 'ABC-1')); i++) await settle()
  assert.equal(await readOf(b, 'ABC-1'), true)
  await b.h.stop()
})

test('our reader page closed before the issue reached it leaves the issue unread; one still open marks it read', async () => {
  let keepOpen = false
  const b = boot({
    mutate: (c) => {
      const start = c.overlay.start
      c.overlay.start = (spec) => (keepOpen ? { ...start(spec), result: new Promise(() => {}) } : start(spec))
    },
  })
  await b.h.pollNow('test')
  await b.h.S.classifying
  assert.deepEqual(await b.ctx.callService('inbox-feed', 'act', ['ABC-1', 'markUnread']), { ok: true })
  // The fake page ends at once (dismissed): the person closed the loader during the read.
  await b.ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.ok(b.ctx.overlays.length >= 1)
  assert.equal(await readOf(b, 'ABC-1'), false)
  keepOpen = true
  assert.deepEqual(await b.ctx.callService('inbox-feed', 'act', ['ABC-1', 'open']), { ok: true })
  for (let i = 0; i < 100 && !(await readOf(b, 'ABC-1')); i++) await settle()
  assert.equal(await readOf(b, 'ABC-1'), true)
  await b.h.stop()
})

test('act markUnread then markRead: the plugin\'s seen marks, the item follows', async () => {
  const b = boot()
  await b.h.pollNow('test')
  await b.h.S.classifying
  assert.deepEqual(await b.ctx.callService('inbox-feed', 'act', ['ABC-1', 'markUnread']), { ok: true })
  let item = (await b.ctx.callService('inbox-feed', 'snapshot')).items.find((i) => i.id === 'ABC-1')
  assert.equal(item.read, false)
  assert.deepEqual(item.actions.map((a) => a.id), ['open', 'markRead'])
  assert.deepEqual(await b.ctx.callService('inbox-feed', 'act', ['ABC-1', 'markRead']), { ok: true })
  item = (await b.ctx.callService('inbox-feed', 'snapshot')).items.find((i) => i.id === 'ABC-1')
  assert.equal(item.read, true)
  await b.h.stop()
})

test('act: a failure comes back as { ok: false, message }', async () => {
  const b = boot()
  await b.h.pollNow('test')
  await b.h.S.classifying
  b.h.S.seen = null // no poll yet from the marks' point of view
  const r = await b.ctx.callService('inbox-feed', 'act', ['ABC-1', 'markUnread'])
  assert.equal(r.ok, false)
  assert.match(r.message, /^jira: no poll yet/)
  await b.h.stop()
})

// ---- the events ----

test('sync at start (carrying the state), then the first poll\'s issues as items', async () => {
  const b = boot()
  await settle()
  const first = events(b, 'sync')
  assert.equal(first.length, 1)
  assert.equal(first[0].data.state, 'ok')
  assert.deepEqual(first[0].data.items, [])
  await b.h.pollNow('test')
  await settle()
  assert.deepEqual(events(b, 'item').map((e) => e.data.id).sort(), ['ABC-1', 'ABC-2', 'ABC-4', 'XYZ-9'])
  assert.equal(events(b, 'sync').length, 1, 'no second sync: the state did not change')
  assert.ok(events(b).every((e) => ['item', 'gone', 'sync'].includes(e.event)), 'no changed event any more')
  await b.h.stop()
})

test('a no-op poll emits nothing; a mark emits the item with its new read state', async () => {
  const b = boot()
  await b.h.pollNow('test')
  await settle()
  const n = b.ctx.emitted.length
  await b.h.pollNow('again')
  await settle()
  assert.equal(b.ctx.emitted.length, n)
  await b.ctx.runCli(['unread', 'ABC-1'])
  const e = events(b, 'item').slice(n - events(b, 'sync').length)
  const last = events(b, 'item').filter((x) => x.data.id === 'ABC-1').pop()
  assert.equal(last.data.read, false)
  assert.ok(e.length >= 1)
  await b.h.stop()
})

test('a lane switched off is gone for its issues, in the same breath as the settings change', async () => {
  const b = boot()
  await b.h.pollNow('test')
  await settle()
  assert.ok(events(b, 'item').some((e) => e.data.id === 'ABC-2'))
  await b.ctx.changeSettings({ ...CONFIGURED, lanes: { backlog: false } })
  await settle()
  const gone = events(b, 'gone')
  assert.ok(gone.some((e) => e.data.ids.includes('ABC-2')), 'ABC-2 left with its lane')
  assert.ok(!gone.some((e) => e.data.ids.includes('ABC-1')), 'the others stay')
  await b.h.stop()
})

test('a lane switched on later brings its issues as items', async () => {
  const b = boot({ project: { ...CONFIGURED, lanes: { mentioned: false } } })
  await b.h.pollNow('test')
  await settle()
  assert.ok(!events(b, 'item').some((e) => e.data.id === 'XYZ-9'))
  await b.ctx.changeSettings({ ...CONFIGURED, lanes: { mentioned: true } })
  await settle()
  await b.h.pollNow('again')
  await settle()
  assert.ok(events(b, 'item').some((e) => e.data.id === 'XYZ-9'))
  await b.h.stop()
})

test('the Done lane never goes out as an item; an issue that moves from a status lane to Done is gone', async () => {
  const b = boot({ project: { ...CONFIGURED, lanes: { done: true } } })
  await b.h.pollNow('test')
  await settle()
  assert.ok(!events(b, 'item').some((e) => e.data.id === 'ABC-3'))
  assert.ok(events(b, 'item').some((e) => e.data.id === 'ABC-4'))
  // ABC-4 is closed on Jira's side: the next search lists it under Done, not under assigned.
  const closed = b.h.S.lists.assigned.find((x) => x.key === 'ABC-4')
  b.h.S.lists.assigned = b.h.S.lists.assigned.filter((x) => x.key !== 'ABC-4')
  b.h.S.lists.done = [...b.h.S.lists.done, { ...closed, category: 'done', status: 'Done' }]
  await b.ctx.runCli(['unread', 'ABC-1']) // any local change makes the host compare the list again
  await settle()
  assert.ok(!(b.h.S.view.lanes.flatMap((l) => l.rows)).some((r) => r.issue.key === 'ABC-4' && r.lane !== 'done'))
  assert.ok(events(b, 'gone').some((e) => e.data.ids.includes('ABC-4')))
  assert.ok(!events(b, 'item').some((e) => e.data.id === 'ABC-3' || (e.data.id === 'ABC-4' && e.data.place.status === 'Done')))
  await b.h.stop()
})

test('the state is a sync when its kind or its message changes, and a recovery too; the last list comes with an error', async () => {
  const b = boot()
  await b.h.pollNow('test')
  await settle()
  const n = events(b, 'sync').length
  b.h.S.error = 'first failure'
  b.h.S.errorKind = 'network'
  await b.ctx.runCli(['unread', 'ABC-1'])
  await settle()
  const syncs = events(b, 'sync')
  assert.equal(syncs.length, n + 1)
  assert.equal(syncs[n].data.state, 'error')
  assert.equal(syncs[n].data.message, 'first failure')
  assert.ok(syncs[n].data.items.length >= 4, 'the last known list comes with it')
  // the same kind with another message: a sync again (Inbox shows the message on the source line)
  b.h.S.error = 'second failure'
  await b.ctx.runCli(['read', 'ABC-1'])
  await settle()
  assert.equal(events(b, 'sync').length, n + 2)
  assert.equal(events(b, 'sync')[n + 1].data.message, 'second failure')
  // the same state and message: items only
  await b.ctx.runCli(['unread', 'ABC-1'])
  await settle()
  assert.equal(events(b, 'sync').length, n + 2)
  // the token refused: signedOut
  b.h.S.error = 'Jira refused the API token'
  b.h.S.errorKind = 'auth'
  await b.ctx.runCli(['read', 'ABC-1'])
  await settle()
  assert.equal(events(b, 'sync')[n + 2].data.state, 'signedOut')
  // recovered
  b.h.S.error = null
  b.h.S.errorKind = null
  await b.h.pollNow('again')
  await settle()
  const all = events(b, 'sync')
  assert.equal(all[all.length - 1].data.state, 'ok')
  assert.ok(!('message' in all[all.length - 1].data))
  await b.h.stop()
})

test('a failed first poll after start is a sync with the state; configuring the plugin later is a sync with ok', async () => {
  const b = boot({ project: {} })
  await settle()
  assert.equal(events(b, 'sync')[0].data.state, 'signedOut')
  assert.match(events(b, 'sync')[0].data.message, /not configured/)
  await b.ctx.changeSettings(CONFIGURED)
  await settle()
  await b.h.pollNow('test')
  await settle()
  const s = events(b, 'sync')
  assert.equal(s[s.length - 1].data.state, 'ok')
  assert.ok(events(b, 'item').some((e) => e.data.id === 'ABC-1'))
  await b.h.stop()
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
  assert.equal((await ctx.callService('jira', 'site')).site, 'https://acme.atlassian.net')
  await assert.rejects(ctx.callService('jira', 'issue', ['nope']), /jira: not an issue key/)
  await h.stop()
})

test('an older app (services without useAll or emit) still activates, provides and answers a snapshot', async () => {
  const { ctx, h } = boot({ mutate: (c) => { delete c.services.emit; delete c.services.caller } })
  assert.equal('useAll' in ctx.services, false)
  assert.equal(ctx.slots, undefined)
  assert.equal(ctx.overlay.buttons, undefined)
  assert.deepEqual(Object.keys(ctx.provided).sort(), ['inbox-feed', 'jira'])
  await h.pollNow('test')
  await h.S.classifying
  assert.equal((await ctx.callService('inbox-feed', 'snapshot')).state, 'ok')
  await h.stop()
})

test('the manifest provides jira 1 and inbox-feed 2 at 0.7.0', () => {
  const m = require('../plugin.json')
  assert.equal(m.version, '0.7.0')
  assert.deepEqual(m.services.provides, { jira: 1, 'inbox-feed': 2 })
})

async function until(fn, ms = 2000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('act open settles once the reader is up, not when the person closes it', async () => {
  const { ctx, h } = boot()
  await h.pollNow('test')
  await h.S.classifying
  // Our own reader page stays open (its result never settles), as it does until the person closes it.
  const start = ctx.overlay.start
  ctx.overlay.start = (spec) => ({ ...start(spec), result: new Promise(() => {}) })
  const before = ctx.overlays.length
  const late = new Promise((r) => setTimeout(() => r('late'), 1000))
  assert.deepEqual(await Promise.race([ctx.callService('inbox-feed', 'act', ['ABC-1', 'open']), late]), { ok: true })
  assert.ok(ctx.overlays.length > before)
  await h.stop()
})
