'use strict'
// The host end to end with a fake ctx and a fake Jira: polling, triage, the panel actions, the
// issue window (0.9.0), the CLI.
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const { fakeJira, fakeCtx, fakeTriage, fixture, picture, kitView, until, SITE, MEDIA, NOW, CONFIGURED, OWNER, WRITER, READER } = require('./fakes')

function boot(opts = {}) {
  const jira = fakeJira(opts.jira)
  const ctx = fakeCtx({ project: opts.project === undefined ? CONFIGURED : opts.project, triage: opts.triage === undefined ? fakeTriage() : opts.triage, sessions: opts.sessions, buttons: !opts.noButtons, oldApp: opts.oldApp, noPerView: opts.noPerView, overlayRefuse: opts.overlayRefuse })
  if (opts.header) Object.assign(ctx.panels, opts.header)
  const h = host._start(ctx, { setInterval: () => 0, clearInterval: () => {}, fetch: jira.fetch, now: () => NOW, setTimeout: () => 0, clearTimeout: () => {}, platform: 'linux', cliWaitMs: 2000, imageWaitMs: opts.imageWaitMs, overlaySettleMs: 10 })
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

/** ABC-1 with two attachments: an image the newest comment shows, and a log file. */
function abc1WithAttachments() {
  const raw = fixture('issue-ABC-1.json')
  raw.fields.attachment = [
    { id: '10001', filename: 'shot.png', mimeType: 'image/png', size: 300, created: '2026-11-01T10:14:00.000+0100', author: { displayName: 'Ann Smith' } },
    { id: '10002', filename: 'trace.log', mimeType: 'text/plain', size: 900, created: '2026-11-01T10:13:00.000+0100', author: { displayName: 'Ann Smith' } },
  ]
  raw.fields.comment.comments[1].body.content.push({ type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'uuid', type: 'file', alt: 'shot.png' } }] })
  return raw
}
const attJira = (extra = {}) => ({ issues: { 'ABC-1': abc1WithAttachments() }, attachments: { 10001: picture('png', 300) }, ...extra })

// ---- the issue window (0.9.0): one perView overlay per issue, drawn by the kit ----

/** Opens ABC-1 from the panel and connects the given copies; resolves the window's fake overlay. */
async function openWindow(ctx, key = 'ABC-1', ...copies) {
  await ctx.sendPanel({ type: 'open', key })
  const o = ctx.overlays.filter((x) => x.spec.file === 'panels/issue.html').at(-1)
  for (const c of copies) o.connect(c)
  return o
}

test('Open: the window starts at once (type, notes key, Open in Jira), then every copy gets the issue with its image', async () => {
  const { ctx, h, jira } = boot({ jira: attJira() })
  await h.pollNow('test')
  const reads = () => jira.calls.filter((x) => /\/issue\/ABC-1/.test(x.url)).length
  const before = reads()
  let readsAtStart = -1
  const start = ctx.overlay.start
  ctx.overlay.start = (spec) => ((readsAtStart = reads() - before), start(spec))
  const o = await openWindow(ctx, 'ABC-1', OWNER, READER)
  assert.equal(readsAtStart, 0, 'the window was asked for before the issue was read')
  assert.equal(o.spec.file, 'panels/issue.html')
  assert.equal(o.spec.title, 'ABC-1: Checkout fails for EU cards')
  assert.deepEqual(o.spec.type, { name: 'inbox-item', data: { source: 'bronos.jira', id: 'ABC-1' } })
  assert.deepEqual(o.spec.notes, { key: 'jira:ABC-1' })
  assert.deepEqual(o.spec.buttons.map((b) => b.id), ['browser'])
  assert.equal(o.spec.ready, undefined, 'the kit page shows its own loading state')
  await until(() => kitView(o, 'c-owner').phase === 'ready' && kitView(o, 'c-read').phase === 'ready')
  const s = kitView(o, 'c-owner').state
  assert.equal(s.key, 'ABC-1')
  assert.equal(s.url, `${SITE}/browse/ABC-1`)
  // Layout A: the key facts as pills under the h1, the rest folded under More details.
  assert.match(s.html, /^<div class="card"><h1>ABC-1: Checkout fails for EU cards<\/h1>\n<dl class="facts">/)
  assert.match(s.html, /<details><summary>More details<\/summary><dl class="facts">/)
  assert.match(s.html, /<img data-asset="att10001" alt="shot.png"/)
  assert.deepEqual(s.assets.map((a) => [a.id, a.mime]), [['att10001', 'image/png']])
  assert.equal(s.reply, true, "the owner's copy has Reply")
  assert.equal(kitView(o, 'c-read').state.reply, false, "a read guest's copy has none")
  assert.equal(kitView(o, 'c-owner').init.access, 'owner')
  assert.equal(kitView(o, 'c-read').init.access, 'read')
  // Every post names a copy: never a broadcast.
  assert.ok(o.posts.every((p) => typeof p.copy === 'string'))
  // The media host got the signed address without the token.
  const media = jira.calls.filter((x) => x.url.startsWith(MEDIA))
  assert.equal(media.length, 1)
  assert.equal(media[0].auth, undefined)
  // A second open focuses the same window.
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(ctx.overlays.length, 1)
  assert.equal(o.focused, 1)
  assert.match((await ctx.runCli(['status'])).stdout, /opens in +the issue window: notes, Ask and Reply/)
  await h.stop()
})

test('Open with markReadOnOpen: marked read once an owner copy has the issue; a guest looking is not the person', async () => {
  const { ctx, h } = boot({ project: { ...CONFIGURED, markReadOnOpen: true } })
  await h.pollNow('test')
  await ctx.runCli(['unread', 'ABC-1'])
  const unread = () => lane(ctx.lastState(), 'inProgress').rows.find((r) => r.key === 'ABC-1').unread
  const o = await openWindow(ctx, 'ABC-1', READER)
  await until(() => kitView(o, 'c-read').phase === 'ready')
  assert.equal(unread(), true, 'only a read guest saw it')
  o.connect(OWNER)
  await until(() => !unread())
  await h.stop()
})

// The person's request: opening an issue to glance at it must not clear its unread mark unless they ask for that.
test('Open with markReadOnOpen off (the default): the issue stays unread; Read still marks it read', async () => {
  const { ctx, h } = boot()
  await h.pollNow('test')
  await ctx.runCli(['unread', 'ABC-1'])
  const marks = JSON.stringify(h.S.seen)
  const o = await openWindow(ctx, 'ABC-1', OWNER)
  await until(() => kitView(o, 'c-owner').phase === 'ready')
  assert.equal(lane(ctx.lastState(), 'inProgress').rows.find((r) => r.key === 'ABC-1').unread, true)
  assert.equal(JSON.stringify(h.S.seen), marks, 'the open left the seen marks (and the Mark unread flag) as they were')
  await ctx.sendPanel({ type: 'read', key: 'ABC-1' })
  assert.equal(lane(ctx.lastState(), 'inProgress').rows.find((r) => r.key === 'ABC-1').unread, false)
  await h.stop()
})

test('a slow image does not hold the open: after the wait it is a link', async () => {
  const { ctx, h } = boot({ jira: attJira({ mediaDelay: 400 }), imageWaitMs: 30 })
  await h.pollNow('test')
  const t0 = Date.now()
  const o = await openWindow(ctx, 'ABC-1', OWNER)
  await until(() => kitView(o, 'c-owner').phase === 'ready')
  assert.ok(Date.now() - t0 < 350, 'the open did not wait for the image')
  const s = kitView(o, 'c-owner').state
  assert.deepEqual(s.assets, [])
  assert.match(s.html, new RegExp(`<a href="${SITE}/rest/api/3/attachment/content/10001">shot\\.png</a>`))
  await h.stop()
})

test('a big issue reaches each copy in chunks under the page message limit', async () => {
  const raw = fixture('issue-ABC-1.json')
  raw.fields.comment.comments.push({ id: '300', author: { displayName: 'Ann Smith', accountId: 'a' }, created: '2026-11-01T11:00:00.000+0100', body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: '"quoted" \\ '.repeat(50000) }] }] } })
  const { ctx, h } = boot({ jira: { issues: { 'ABC-1': raw } } })
  await h.pollNow('test')
  const o = await openWindow(ctx, 'ABC-1', OWNER)
  await until(() => kitView(o, 'c-owner').phase === 'ready')
  assert.ok(o.sent('c-owner').filter((m) => m.type === 'cc-kit.chunk').length >= 2)
  for (const p of o.posts) assert.ok(JSON.stringify(p.message).length <= 1040384)
  assert.match(kitView(o, 'c-owner').state.html, /&quot;quoted&quot;/)
  await h.stop()
})

test('a failed read: the owner gets the error with Try again, a guest the fixed text; Try again reads again', async () => {
  const fail = { 'ABC-1': 500 }
  const { ctx, h } = boot({ jira: { fail } })
  await h.pollNow('test')
  // Nothing cached to fall back on for this key's full read: drop the cached copy.
  h.S.cache.issues['ABC-1'] = undefined
  const o = await openWindow(ctx, 'ABC-1', OWNER, WRITER)
  await until(() => kitView(o, 'c-owner').phase === 'failed')
  assert.equal(o.closed, false, 'the window stays, with the error')
  assert.match(kitView(o, 'c-owner').failed.message, /^Could not load the issue: /)
  assert.equal(kitView(o, 'c-owner').failed.retry, true)
  assert.deepEqual(kitView(o, 'c-write').failed, { type: 'cc-kit.failed', message: 'This issue could not be loaded.', retry: false })
  assert.equal(ctx.lastState().notice.kind, 'error')
  delete fail['ABC-1']
  o.send({ type: 'cc-kit.retry' }, WRITER)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(kitView(o, 'c-owner').phase, 'failed', "a guest's Try again does nothing")
  o.send({ type: 'cc-kit.retry' }, OWNER)
  await until(() => kitView(o, 'c-owner').phase === 'ready')
  await h.stop()
})

test('links: the document\'s own open in the clicking view; Open in Jira too; any other is not opened', async () => {
  const { ctx, h } = boot({ jira: attJira() })
  const opened = []
  ctx.openExternal = async (url, o) => opened.push([url, o])
  await h.pollNow('test')
  const o = await openWindow(ctx, 'ABC-1', OWNER, READER)
  await until(() => kitView(o, 'c-read').phase === 'ready')
  o.send({ type: 'cc-kit.link', url: `${SITE}/rest/api/3/attachment/content/10002` }, READER)
  o.send({ type: 'cc-kit.link', url: 'https://evil.example/x' }, OWNER)
  await o.click('browser', READER)
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(opened.sort((a, b) => a[0].localeCompare(b[0])), [
    [`${SITE}/browse/ABC-1`, { view: 'web:2' }],
    [`${SITE}/rest/api/3/attachment/content/10002`, { view: 'web:2' }],
  ])
  await h.stop()
})

test('Discuss and Ask: the issue as text; Ask refuses a read guest and a missing from', async () => {
  const { ctx, h } = boot()
  await h.pollNow('test')
  const o = await openWindow(ctx, 'ABC-1', OWNER)
  await until(() => kitView(o, 'c-owner').phase === 'ready')
  const d = await o.discuss(OWNER)
  assert.match(d.text, /^About Jira ABC-1: Checkout fails for EU cards\n/)
  assert.match((await o.ask(OWNER)).text, /^ABC-1: Checkout fails for EU cards\nType: Bug/)
  assert.ok(await o.ask(WRITER))
  assert.equal(await o.ask(READER), null)
  assert.equal(await o.ask(undefined), null)
  await h.stop()
})

test('on an old app (ctx without notes, ask, onAnnounce) the page opens and Discuss works', async () => {
  const { ctx, h } = boot({ oldApp: true })
  await h.pollNow('test')
  assert.equal(typeof ctx.notes, 'undefined')
  assert.equal(typeof ctx.overlay.onAnnounce, 'undefined')
  const o = await openWindow(ctx, 'ABC-1', OWNER)
  assert.equal(o.ask, undefined, 'no onAsk on this app')
  await until(() => kitView(o, 'c-owner').phase === 'ready')
  assert.match(kitView(o, 'c-owner').state.html, /ABC-1: Checkout fails for EU cards/)
  assert.match((await o.discuss(OWNER)).text, /^About Jira ABC-1: /)
  assert.match((await ctx.runCli(['status'])).stdout, /without notes and Ask \(they need cc-cockpit 0\.28\.0\)/)
  await h.stop()
})

test('an app before overlays in every view (no onConnect): fail closed, nothing shown, the panel says why', async () => {
  const { ctx, h } = boot({ noPerView: true })
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(ctx.overlays[0].closed, true)
  assert.equal(ctx.overlays[0].posts.length, 0)
  assert.match(ctx.lastState().notice.text, /needs cc-cockpit 0\.27\.0 or later/)
  await h.stop()
})

test('the window of an issue not in the cached rows has the bare key as title, with no dangling colon', async () => {
  const { ctx, h } = boot()
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(ctx.overlays[0].spec.title, 'ABC-1')
  await h.stop()
})

test('a window the app refuses: the notice says so and nothing is read', async () => {
  const { ctx, h, jira } = boot({ overlayRefuse: 'overlay: at most 3 open' })
  await h.pollNow('test')
  const before = jira.calls.length
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.match(ctx.lastState().notice.text, /at most 3 open/)
  assert.equal(jira.calls.length, before)
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
  // Nothing from others on ABC-2: unread still works, as the person's own flag, and the panel
  // offers it (canUnread) on every lane but Done.
  assert.equal((await ctx.runCli(['unread', 'ABC-2'])).code, 0)
  const row = ctx.lastState().lanes.flatMap((l) => l.rows).find((x) => x.key === 'ABC-2')
  assert.equal(row.unread, true)
  assert.equal(row.newCount, 0)
  assert.equal(row.canUnread, true)
  assert.match((await ctx.runCli(['list'])).stdout, /\* . ABC-2/)
  assert.equal((await ctx.runCli(['read', 'ABC-2'])).code, 0)
  assert.equal(ctx.lastState().lanes.flatMap((l) => l.rows).find((x) => x.key === 'ABC-2').unread, false)
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

test('Issues per lane: only that many rows are sent until Show all, which is remembered', async () => {
  const { ctx, h } = boot()
  await ctx.changeSettings({ ...CONFIGURED, rowsPerLane: 1 })
  await h.pollNow('test')
  // The lane with the most issues in the fixtures (it needs at least two).
  const id = ctx.lastState().lanes.reduce((a, b) => (b.total > a.total ? b : a)).id
  const before = lane(ctx.lastState(), id)
  assert.ok(before.total > 1, 'the fixtures need a lane with two issues')
  assert.equal(before.limit, 1)
  assert.equal(before.expanded, false)
  assert.equal(before.rows.length, 1)
  await ctx.sendPanel({ type: 'expand', lane: id })
  const after = lane(ctx.lastState(), id)
  assert.equal(after.expanded, true)
  assert.equal(after.rows.length, after.total)
  assert.deepEqual((await ctx.storage.get('ui')).expanded, { [id]: true })
  await ctx.sendPanel({ type: 'expand', lane: id })
  assert.equal(lane(ctx.lastState(), id).rows.length, 1)
  await h.stop()
})

test('the panel toggle remembers a collapsed lane', async () => {
  const { ctx, h } = boot()
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'toggle', lane: 'backlog' })
  assert.equal(lane(ctx.lastState(), 'backlog').collapsed, true)
  assert.deepEqual(await ctx.storage.get('ui'), { collapsed: { backlog: true }, expanded: {} })
  await h.stop()
})

test('title bar: with ctx.panels.header the host sets the last poll and a Refresh action, and a click polls', async () => {
  const headers = []
  const actions = []
  const { ctx, h, jira } = boot({
    header: {
      header: (panel, spec) => headers.push(structuredClone(spec)),
      onAction: (panel, fn) => {
        actions.push(fn)
        return () => {}
      },
    },
  })
  await h.pollNow('test')
  const last = headers[headers.length - 1]
  assert.match(last.meta, /just now/)
  assert.deepEqual(last.actions.map((a) => [a.id, a.icon, a.busy, a.disabled]), [['refresh', 'refresh', false, false]])
  assert.equal(ctx.lastState().coreHeader, true)
  // An unchanged header is not sent again.
  const n = headers.length
  await ctx.sendPanel({ type: 'hello' })
  assert.equal(headers.length, n)
  assert.equal(actions.length, 1)
  const calls = jira.calls ? jira.calls.length : null
  actions[0]('refresh')
  assert.equal(headers[headers.length - 1].actions[0].busy, true, 'the icon spins while the poll runs')
  await h.S.polling
  if (calls !== null) assert.ok(jira.calls.length > calls)
  await h.stop()
})

test('title bar: without ctx.panels.header (cc-cockpit 0.8) the page keeps its own line', async () => {
  const { ctx, h } = boot()
  await h.pollNow('test')
  assert.equal(ctx.lastState().coreHeader, false)
  await h.stop()
})

test('↗ goes through ctx.openExternal when the app has it (0.9.1+), not xdg-open', async () => {
  const opened = []
  const { ctx, h } = boot()
  ctx.openExternal = async (url) => {
    opened.push(url)
  }
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'browser', key: 'ABC-1' })
  assert.deepEqual(opened, [`${SITE}/browse/ABC-1`])
  assert.equal(ctx.execs.length, 0)
  ctx.openExternal = async () => {
    throw new Error('at most 3 links in 10 seconds')
  }
  await ctx.sendPanel({ type: 'browser', key: 'ABC-1' })
  assert.match(ctx.lastState().notice.text, /at most 3 links/)
  await h.stop()
})

// ---- overlay type and buttons (inbox redesign, task 24; 0.9.0: no reviewer, no Reply button) ----

const ITEM = (id, source = 'bronos.jira') => ({ type: { name: 'inbox-item', data: { source, id } }, title: 't', opener: 'bronos.jira' })

test('overlay buttons: only for our own items, labels follow state, run = act', async () => {
  const { ctx, h } = boot()
  await h.pollNow('test')
  assert.equal(ctx.buttonProviders.length, 1)
  assert.equal(ctx.buttonProviders[0].name, 'inbox-item')
  const provider = ctx.buttonProviders[0].provider
  assert.deepEqual(await provider(ITEM('ABC-1', 'bronos.gmail')), [])
  assert.deepEqual(await provider(ITEM('NOPE-1')), [])
  assert.deepEqual(await provider({ type: { name: 'inbox-item', data: null }, title: 't', opener: 'x' }), [])
  const before = await provider(ITEM('ABC-1'))
  assert.equal(before.length, 1, 'Mark read or unread; Reply is the window\'s own tab')
  assert.ok(!before.some((b) => b.id === 'open' || b.id === 'reply'))
  assert.match(before[0].label, /read/i)
  await before[0].run(ITEM('ABC-1'))
  const after = await provider(ITEM('ABC-1'))
  assert.notEqual(after[0].id, before[0].id)
  assert.notEqual(after[0].label, before[0].label)
  // The same state the feed's act gives.
  assert.equal(lane(ctx.lastState(), 'inProgress').rows.find((r) => r.key === 'ABC-1').unread, after[0].id === 'markRead')
  await h.stop()
})

test('overlay buttons: only on overlays we opened, whatever the data names (no reviewer is trusted)', async () => {
  const { ctx, h } = boot()
  await h.pollNow('test')
  const provider = ctx.buttonProviders[0].provider
  // `opener` is the app's record of who opened the overlay: another plugin naming our item, a type
  // data claiming to be ours, the CLI, core or the reviewer get no buttons that act on it.
  const by = (opener) => ({ type: { name: 'inbox-item', data: { source: 'bronos.jira', id: 'ABC-1', opener: 'bronos.jira' } }, title: 't', opener })
  for (const foreign of ['evil.plugin', 'bronos.inbox', 'cockpit.reviewer', 'cli', 'core', '', undefined]) {
    assert.deepEqual(await provider(by(foreign)), [], `opener ${foreign}`)
  }
  assert.deepEqual(await provider({ type: by('x').type, title: 't' }), [])
  assert.equal((await provider(by('bronos.jira'))).length, 1)
  await h.stop()
})

test('overlay buttons: a refused act shows in the notice and throws, not silent', async () => {
  const { ctx, h } = boot()
  await h.pollNow('test')
  const provider = ctx.buttonProviders[0].provider
  const [button] = await provider(ITEM('ABC-1'))
  // The seen marks are gone (as before the first poll): setRead refuses and act answers ok: false.
  h.S.seen = null
  await assert.rejects(button.run(ITEM('ABC-1')), /no poll yet/)
  assert.equal(ctx.lastState().notice.kind, 'error')
  assert.match(ctx.lastState().notice.text, /no poll yet/)
  await h.stop()
})

test('overlay buttons: a ctx without the member still activates and opens an issue', async () => {
  const { ctx, h } = boot({ noButtons: true })
  await h.pollNow('test')
  assert.equal(ctx.buttonProviders.length, 0)
  const o = await openWindow(ctx, 'ABC-1', OWNER)
  await until(() => kitView(o, 'c-owner').phase === 'ready')
  assert.equal(ctx.lastState().notice, null)
  await h.stop()
})
