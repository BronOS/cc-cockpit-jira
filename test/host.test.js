'use strict'
// The host end to end with a fake ctx and a fake Jira: polling, triage, the panel actions, the
// annotate fallback, the CLI.
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const { fakeJira, fakeCtx, fakeTriage, SITE, NOW, CONFIGURED } = require('./fakes')

function boot(opts = {}) {
  const jira = fakeJira(opts.jira)
  const ctx = fakeCtx({ project: opts.project === undefined ? CONFIGURED : opts.project, triage: opts.triage === undefined ? fakeTriage() : opts.triage, reviewer: opts.reviewer, sessions: opts.sessions, overlayAnswer: opts.overlayAnswer })
  const h = host._start(ctx, { fetch: jira.fetch, now: () => NOW, setTimeout: () => 0, clearTimeout: () => {}, platform: 'linux', cliWaitMs: 2000 })
  return { jira, ctx, h, triage: ctx.services && opts.triage === undefined ? null : opts.triage }
}
const lane = (st, id) => st.lanes.find((l) => l.id === id)
const tab = (tabId, status, extra = {}) => ({ tabId, status, cwd: '/p/x', notes: [], files: [], ...extra })

test('not configured: no request, the panel and ccc jira status say what is missing', async () => {
  const { jira, ctx, h } = boot({ project: {} })
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'hello' })
  const st = ctx.lastState()
  assert.equal(st.ready, false)
  assert.equal(st.missing.length, 3)
  assert.equal(jira.calls.length, 0)
  const r = await ctx.runCli(['status'])
  assert.match(r.stdout, /Not configured/)
  assert.match(r.stdout, /API token is not set/)
  assert.equal(ctx.schedules[0].seconds, 180)
  await h.stop()
})

test('a poll fills the lanes, seeds the seen marks, sends only shown rows to triage', async () => {
  const triage = fakeTriage()
  const { ctx, h } = boot({ triage })
  await h.pollNow('test')
  await h.S.classifying
  const st = ctx.lastState()
  assert.deepEqual(st.lanes.map((l) => [l.id, l.rows.map((r) => r.key)]), [['backlog', ['ABC-2']], ['inProgress', ['ABC-1', 'ABC-4']], ['mentioned', ['XYZ-9']]])
  assert.equal(st.unread, 0, 'first run: everything seen')
  assert.equal(triage.calls.length, 1)
  assert.equal(triage.calls[0].source, 'jira')
  assert.deepEqual(triage.calls[0].items.map((i) => i.id).sort(), ['ABC-1', 'ABC-2', 'ABC-4', 'XYZ-9'])
  // Seen: nothing new; In progress -> action, Backlog -> noise, Mentioned -> Jev with floor fyi.
  const v = Object.fromEntries(st.lanes.flatMap((l) => l.rows).map((r) => [r.key, r.verdict && r.verdict.priority]))
  assert.deepEqual(v, { 'ABC-1': 'action', 'ABC-4': 'action', 'ABC-2': 'noise', 'XYZ-9': 'fyi' })
  assert.equal(lane(st, 'mentioned').rows[0].who, 'mentioned by Bob Jones')
  // A second poll with nothing changed classifies nothing.
  await h.pollNow('again')
  await h.S.classifying
  assert.equal(triage.calls.length, 1)
  await h.stop()
})

test('the token goes to the site and nowhere else during a whole poll', async () => {
  const { jira, h } = boot()
  await h.pollNow('test')
  const authed = jira.calls.filter((c) => c.auth)
  assert.ok(authed.length > 5)
  assert.ok(authed.every((c) => c.url.startsWith(SITE + '/rest/api/3/')))
  assert.ok(jira.calls.every((c) => c.redirect === 'manual' || !c.auth))
  await h.stop()
})

test('a scoped token works through the gateway', async () => {
  const { ctx, h } = boot({ jira: { scoped: true } })
  await h.pollNow('test')
  assert.equal(ctx.lastState().error, null)
  assert.match((await ctx.runCli(['status'])).stdout, /\(scoped token\)/)
  await h.stop()
})

test('an expired token: a notice with what to do, no lanes lost', async () => {
  const { ctx, h } = boot({ jira: { token: 'other' } })
  await h.pollNow('test')
  assert.match(ctx.lastState().error, /expired or is wrong.*id\.atlassian\.com > Security > API tokens/)
  await h.stop()
})

test('triage off: unsorted, the panel says so, nothing is classified', async () => {
  const { ctx, h } = boot({ triage: null })
  await h.pollNow('test')
  await h.S.classifying
  const st = ctx.lastState()
  assert.equal(st.triage.on, false)
  assert.ok(st.lanes.flatMap((l) => l.rows).every((r) => r.verdict === null))
  assert.match((await ctx.runCli(['status'])).stdout, /triage +off: install and enable Jev triage/)
  await h.stop()
})

test('a triage change event classifies those ids again', async () => {
  const triage = fakeTriage()
  const { ctx, h } = boot({ triage })
  await h.pollNow('test')
  await h.S.classifying
  ctx.handles.triage.listeners.change[0]({ source: 'jira', ids: ['ABC-2'] })
  ctx.handles.triage.listeners.change[0]({ source: 'mail', ids: ['ABC-1'] })
  await h.S.classifying
  assert.equal(triage.calls.length, 2)
  assert.deepEqual(triage.calls[1].items.map((i) => i.id), ['ABC-2'])
  await h.stop()
})

test('Wrong? stores an override and the row shows it; Undo clears it', async () => {
  const triage = fakeTriage()
  const { ctx, h } = boot({ triage })
  await h.pollNow('test')
  await h.S.classifying
  await ctx.sendPanel({ type: 'wrong', key: 'ABC-2', priority: 'urgent' })
  let row = lane(ctx.lastState(), 'backlog').rows[0]
  assert.deepEqual(triage.overrides['ABC-2'], { priority: 'urgent' })
  assert.equal(row.verdict.by, 'override')
  assert.equal(lane(ctx.lastState(), 'backlog').rows[0].key, 'ABC-2')
  assert.match(ctx.lastState().notice.text, /Jev triage panel/)
  await ctx.sendPanel({ type: 'undoWrong', key: 'ABC-2' })
  row = lane(ctx.lastState(), 'backlog').rows[0]
  assert.equal(row.verdict.priority, 'noise')
  await h.stop()
})

test('Open with reviewer.annotate (0.8.0): the issue text, its URL and key, the active tab; it marks read', async () => {
  const calls = []
  const reviewer = { annotate: async (spec) => (calls.push(spec), { ok: true }) }
  const { ctx, h } = boot({ reviewer, sessions: [tab('t1', 'waiting'), tab('t2', 'working', { active: true })] })
  await h.pollNow('test')
  await ctx.runCli(['unread', 'ABC-1'])
  assert.equal(lane(ctx.lastState(), 'inProgress').rows.find((r) => r.key === 'ABC-1').unread, true)
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].title, 'ABC-1: Checkout fails for EU cards')
  assert.equal(calls[0].url, `${SITE}/browse/ABC-1`)
  assert.equal(calls[0].key, 'jira:ABC-1')
  assert.equal(calls[0].tabId, 't2')
  assert.match(calls[0].text, /\[new\] Ann Smith/)
  assert.equal(lane(ctx.lastState(), 'inProgress').rows.find((r) => r.key === 'ABC-1').unread, false)
  assert.equal(ctx.overlays.length, 0)
  assert.equal(ctx.lastState().annotate, true)
  await h.stop()
})

test('Open on an app without annotate: our own reader, and its New session button opens a tab', async () => {
  const reviewer = { review: async () => {} } // the 0.7.0 reviewer: no annotate
  const { ctx, h } = boot({ reviewer, overlayAnswer: { kind: 'value', value: { action: 'newSession' } } })
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(ctx.overlays.length, 1)
  assert.equal(ctx.overlays[0].spec.file, 'panels/issue.html')
  assert.match(ctx.overlays[0].posts[0].text, /^ABC-1: Checkout fails for EU cards/)
  assert.equal(ctx.opened.length, 1)
  assert.match(ctx.opened[0].prompt, /^About Jira ABC-1: Checkout fails for EU cards\n/)
  assert.equal(ctx.lastState().annotate, false)
  await h.stop()
})

test('Open with no reviewer at all also uses the reader', async () => {
  const { ctx, h } = boot({ reviewer: null })
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'open', key: 'ABC-2' })
  assert.equal(ctx.overlays.length, 1)
  await h.stop()
})

test('a real annotate failure is shown, not hidden behind the reader', async () => {
  const reviewer = { annotate: async () => { throw new Error('annotate: text over the limit') } }
  const { ctx, h } = boot({ reviewer })
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(ctx.overlays.length, 0)
  assert.match(ctx.lastState().notice.text, /text over the limit/)
  await h.stop()
})

test('Discuss: the active tab, else the only live one, else the person picks', async () => {
  let b = boot({ sessions: [tab('a', 'waiting'), tab('b', 'idle', { active: true, title: 'Payments' })] })
  await b.h.pollNow('test')
  await b.ctx.sendPanel({ type: 'discuss', key: 'ABC-1' })
  assert.equal(b.ctx.sent[0].tabId, 'b')
  assert.match(b.ctx.sent[0].text, /^About Jira ABC-1: /)
  assert.match(b.ctx.lastState().notice.text, /Sent ABC-1 to "Payments"/)
  await b.h.stop()

  b = boot({ sessions: [tab('a', 'waiting'), tab('b', 'working')] })
  await b.h.pollNow('test')
  await b.ctx.sendPanel({ type: 'discuss', key: 'ABC-1' })
  assert.equal(b.ctx.sent.length, 0)
  assert.deepEqual(b.ctx.lastState().choose.tabs.map((t) => t.tabId), ['a', 'b'])
  await b.ctx.sendPanel({ type: 'discuss', key: 'ABC-1', tabId: 'b' })
  assert.equal(b.ctx.sent[0].tabId, 'b')
  assert.equal(b.ctx.lastState().choose, null)
  await b.h.stop()

  b = boot({ sessions: [] })
  await b.h.pollNow('test')
  await b.ctx.sendPanel({ type: 'discuss', key: 'ABC-1' })
  assert.match(b.ctx.lastState().notice.text, /No Claude tab/)
  await b.h.stop()
})

test('↗ opens the issue page with xdg-open, the URL as one argument', async () => {
  const { ctx, h } = boot()
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'browser', key: 'ABC-1' })
  assert.deepEqual(ctx.execs[0].argv, ['xdg-open', `${SITE}/browse/ABC-1`])
  await h.stop()
})

test('a key from the page that is not one is ignored', async () => {
  const { ctx, h, jira } = boot()
  await h.pollNow('test')
  const before = jira.calls.length
  await ctx.sendPanel({ type: 'open', key: '../../rest/api/3/myself' })
  await ctx.sendPanel({ type: 'browser', key: 'ABC-1 --foo' })
  assert.equal(jira.calls.length, before)
  assert.equal(ctx.execs.length, 0)
  await h.stop()
})

test('CLI: list, show, read and unread', async () => {
  const { ctx, h } = boot()
  await ctx.runCli(['refresh'])
  const list = (await ctx.runCli(['list'])).stdout
  assert.match(list, /In progress \(2\)\n {4}A ABC-1/)
  const show = (await ctx.runCli(['show', 'abc-1'])).stdout
  assert.match(show, /^ABC-1: Checkout fails for EU cards\nType: Bug/)
  assert.equal((await ctx.runCli(['unread', 'ABC-1'])).code, 0)
  // Unread and High: the urgent hint.
  assert.match((await ctx.runCli(['list', 'inProgress'])).stdout, /\* U ABC-1/)
  assert.equal((await ctx.runCli(['read', 'ABC-1'])).code, 0)
  const r = await ctx.runCli(['unread', 'ABC-2'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /nothing from others/)
  assert.match((await ctx.runCli(['read', 'NOPE-1'])).stderr, /not in the lanes/)
  await h.stop()
})

test('a new comment of someone else makes the issue unread on the next poll, with its badge', async () => {
  const { fixture } = require('./fakes')
  const issues = {}
  let page1 = null
  const routes = (url) => {
    const u = new URL(url)
    if (page1 && u.pathname.endsWith('/search/jql') && u.searchParams.get('jql').includes('!= Done') && !u.searchParams.get('nextPageToken')) return new Response(JSON.stringify(page1))
    return undefined
  }
  const { ctx, h } = boot({ jira: { issues, routes } })
  await h.pollNow('test')
  const raw = fixture('issue-ABC-2.json')
  raw.fields.updated = '2026-11-02T11:00:00.000+0000'
  raw.fields.comment = { comments: [{ id: '900', author: { accountId: 'x', displayName: 'Carol' }, created: '2026-11-02T11:00:00.000+0000', body: 'Any news?' }], total: 1 }
  issues['ABC-2'] = raw
  page1 = fixture('search-assigned-1.json')
  page1.issues[1].fields.updated = raw.fields.updated
  await h.pollNow('again')
  const row = lane(ctx.lastState(), 'backlog').rows[0]
  assert.equal(row.unread, true)
  assert.equal(row.newCount, 1)
  assert.equal(ctx.badges[ctx.badges.length - 1], 1)
  await h.stop()
})

test('a site change starts over: no marks, verdicts or lanes of the old site', async () => {
  const { ctx, h } = boot()
  await h.pollNow('test')
  assert.ok(h.S.seen)
  await ctx.changeSettings({ ...CONFIGURED, site: 'https://other.atlassian.net' })
  assert.equal(h.S.seen, null)
  assert.deepEqual(h.S.verdicts, {})
  assert.equal(ctx.lastState().site, 'https://other.atlassian.net')
  await h.stop()
})

test('the panel toggle remembers a collapsed lane', async () => {
  const { ctx, h } = boot()
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'toggle', lane: 'backlog' })
  assert.equal(lane(ctx.lastState(), 'backlog').collapsed, true)
  assert.deepEqual(await ctx.storage.get('ui'), { collapsed: { backlog: true } })
  await h.stop()
})
