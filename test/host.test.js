'use strict'
// The host end to end with a fake ctx and a fake Jira: polling, triage, the panel actions, the
// annotate fallback, the CLI.
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const { fakeJira, fakeCtx, fakeTriage, fixture, picture, SITE, MEDIA, NOW, CONFIGURED } = require('./fakes')

function boot(opts = {}) {
  const jira = fakeJira(opts.jira)
  const ctx = fakeCtx({ project: opts.project === undefined ? CONFIGURED : opts.project, triage: opts.triage === undefined ? fakeTriage() : opts.triage, reviewer: opts.reviewer, sessions: opts.sessions, overlayAnswer: opts.overlayAnswer, overlayWait: opts.overlayWait, buttons: !opts.noButtons })
  if (opts.header) Object.assign(ctx.panels, opts.header)
  const h = host._start(ctx, { setInterval: () => 0, clearInterval: () => {}, fetch: jira.fetch, now: () => NOW, setTimeout: () => 0, clearTimeout: () => {}, platform: 'linux', cliWaitMs: 2000, imageWaitMs: opts.imageWaitMs })
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

test('Open with the html reviewer (0.8.0): styled HTML, the image as an asset, the active tab; it marks read', async () => {
  const calls = []
  const reviewer = { annotate: async (spec) => (calls.push(spec), { ok: true }) }
  const { ctx, h, jira } = boot({ reviewer, sessions: [tab('t1', 'waiting'), tab('t2', 'working', { active: true })], jira: attJira() })
  await h.pollNow('test')
  await ctx.runCli(['unread', 'ABC-1'])
  assert.equal(lane(ctx.lastState(), 'inProgress').rows.find((r) => r.key === 'ABC-1').unread, true)
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(calls.length, 1)
  const c = calls[0]
  assert.equal(c.title, 'ABC-1: Checkout fails for EU cards')
  assert.equal(c.url, `${SITE}/browse/ABC-1`)
  assert.equal(c.key, 'jira:ABC-1')
  assert.equal(c.tabId, 't2')
  assert.equal(c.text, undefined, 'html mode sends no text')
  assert.match(c.html, /^<div class="card"><h1>ABC-1: Checkout fails for EU cards<\/h1>/)
  assert.match(c.html, /<div class="card new"><div class="card-header"><strong>Ann Smith<\/strong>/)
  assert.match(c.html, /<img data-asset="att10001" alt="shot.png"/)
  assert.match(c.html, new RegExp(`<a href="${SITE}/rest/api/3/attachment/content/10002">trace\\.log</a>`))
  assert.deepEqual(c.assets.map((a) => [a.id, a.name, a.mime]), [['att10001', 'shot.png', 'image/png']])
  assert.match(c.assets[0].dataUrl, /^data:image\/png;base64,iVBORw0KGgo/)
  // The media host got the signed address without the token.
  const media = jira.calls.filter((x) => x.url.startsWith(MEDIA))
  assert.equal(media.length, 1)
  assert.equal(media[0].auth, undefined)
  assert.equal(lane(ctx.lastState(), 'inProgress').rows.find((r) => r.key === 'ABC-1').unread, false)
  assert.equal(ctx.overlays.length, 0)
  // The second open takes the image from the cache: no new download.
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(jira.calls.filter((x) => x.url.startsWith(MEDIA)).length, 1)
  assert.equal(calls[1].assets.length, 1)
  assert.match((await ctx.runCli(['status'])).stdout, /HTML with its images/)
  await h.stop()
})

// Real-work feedback 8: the overlay came only after the issue was read.
test('Open with a reviewer that has prepare: the overlay is up before the issue is read, then filled', async () => {
  const order = []
  let reads = () => 0
  const reviewer = {
    prepare: async (spec) => (order.push(['prepare', spec, reads()]), { opened: true }),
    cancel: async (spec) => (order.push(['cancel', spec.key]), { closed: false }),
    annotate: async (spec) => (order.push(['annotate', spec.key]), { opened: true }),
  }
  const { ctx, h, jira } = boot({ reviewer, jira: attJira() })
  await h.pollNow('test')
  reads = () => jira.calls.filter((x) => /\/issue\/ABC-1|attachment/.test(x.url)).length
  const before = reads()
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.deepEqual(order[0], ['prepare', { key: 'jira:ABC-1', title: 'ABC-1: Checkout fails for EU cards', type: { name: 'inbox-item', data: { source: 'bronos.jira', id: 'ABC-1' } } }, before])
  assert.ok(reads() > before, 'the open read the issue, after prepare')
  assert.deepEqual(order.slice(1), [['annotate', 'jira:ABC-1'], ['cancel', 'jira:ABC-1']])
  await h.stop()
})

test('Open with prepare: an open that fails cancels the loading overlay', async () => {
  const calls = []
  const reviewer = {
    prepare: async (spec) => (calls.push(['prepare', spec.key]), { opened: true }),
    cancel: async (spec) => (calls.push(['cancel', spec.key]), { closed: true }),
    annotate: async () => {
      throw new Error('reviewer: the review overlay did not open: overlay: at most 3 open')
    },
  }
  const { ctx, h } = boot({ reviewer, jira: attJira() })
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.deepEqual(calls, [['prepare', 'jira:ABC-1'], ['cancel', 'jira:ABC-1']])
  assert.match(ctx.lastState().notice.text, /could not open ABC-1/)
  await h.stop()
})

test('a slow image does not hold the open: after the wait it is a link, and the open goes on', async () => {
  const calls = []
  const reviewer = { annotate: async (spec) => (calls.push(spec), {}) }
  const { ctx, h } = boot({ reviewer, jira: attJira({ mediaDelay: 400 }), imageWaitMs: 30 })
  await h.pollNow('test')
  const t0 = Date.now()
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.ok(Date.now() - t0 < 350, 'the open did not wait for the image')
  assert.equal(calls[0].assets, undefined)
  assert.match(calls[0].html, new RegExp(`<a href="${SITE}/rest/api/3/attachment/content/10001">shot\\.png</a>`))
  await h.stop()
})

test('a reviewer whose annotate takes text only: html refused, then text; remembered for the run', async () => {
  const calls = []
  const reviewer = {
    annotate: async (spec) => {
      calls.push(spec)
      if (typeof spec.text !== 'string') throw new Error('annotate: text must be a string')
      return {}
    },
  }
  const { ctx, h } = boot({ reviewer, jira: attJira() })
  await h.pollNow('test')
  await ctx.runCli(['unread', 'ABC-1'])
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(calls.length, 2)
  assert.ok(calls[0].html)
  assert.match(calls[1].text, /^ABC-1: Checkout fails for EU cards/)
  assert.match(calls[1].text, /\[new\] Ann Smith/)
  assert.equal(calls[1].html, undefined)
  assert.equal(calls[1].key, 'jira:ABC-1')
  assert.equal(ctx.lastState().notice, null)
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(calls.length, 3, 'the next open goes straight to text')
  assert.equal(typeof calls[2].text, 'string')
  assert.match((await ctx.runCli(['status'])).stdout, /text only/)
  await h.stop()
})

test('a real annotate failure (html and text both refused) is shown, and html is tried again next time', async () => {
  let n = 0
  const reviewer = { annotate: async () => { n++; throw new Error('annotate: the overlay could not open') } }
  const { ctx, h } = boot({ reviewer })
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(n, 2)
  assert.equal(ctx.overlays.length, 0)
  assert.match(ctx.lastState().notice.text, /could not open/)
  assert.equal(h.S.htmlRejected, null)
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(n, 4)
  await h.stop()
})

test('Open on an app without annotate: our own page gets the same HTML and the image; a link opens in the browser', async () => {
  const reviewer = { review: async () => {} } // the 0.7.0 reviewer: no annotate
  const { ctx, h } = boot({ reviewer, jira: attJira(), overlayWait: true })
  await h.pollNow('test')
  const opening = ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  // The issue is posted once the page counts as up (no refusal within OVERLAY_SETTLE_MS).
  for (let i = 0; i < 300 && !(ctx.overlays.length && ctx.overlays[0].posts.length); i++) await new Promise((r) => setTimeout(r, 5))
  const o = ctx.overlays[0]
  assert.equal(o.spec.file, 'panels/issue.html')
  const head = o.posts[0]
  assert.equal(head.type, 'doc')
  assert.equal(head.key, 'ABC-1')
  const html = o.posts.filter((m) => m.type === 'html').map((m) => m.part).join('')
  assert.equal(o.posts.filter((m) => m.type === 'html').length, head.parts)
  assert.match(html, /<img data-asset="att10001"/)
  const asset = o.posts.find((m) => m.type === 'asset')
  assert.equal(asset.id, 'att10001')
  assert.match(asset.dataUrl, /^data:image\/png;base64,/)
  // A link in the page: http(s) goes to xdg-open as one argument, anything else is not opened.
  o.send({ open: 'https://grafana.example.com/d/x' })
  o.send({ open: 'file:///etc/passwd' })
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(ctx.execs.map((e) => e.argv), [['xdg-open', 'https://grafana.example.com/d/x']])
  assert.match(ctx.lastState().notice.text, /Only web links/)
  o.close({ kind: 'value', value: { action: 'newSession' } })
  await opening
  assert.equal(ctx.opened.length, 1)
  assert.match(ctx.opened[0].prompt, /^About Jira ABC-1: Checkout fails for EU cards\n/)
  assert.equal(ctx.opened[0].focus, true, 'the new tab is shown')
  assert.equal(ctx.lastState().annotate, false)
  await h.stop()
})

test('Open with no reviewer at all also uses the page; a big issue arrives in parts under the message limit', async () => {
  const raw = fixture('issue-ABC-1.json')
  raw.fields.comment.comments.push({ id: '300', author: { displayName: 'Ann Smith', accountId: 'a' }, created: '2026-11-01T11:00:00.000+0100', body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: '"quoted" \\ '.repeat(50000) }] }] } })
  const { ctx, h } = boot({ reviewer: null, jira: { issues: { 'ABC-1': raw } } })
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  const o = ctx.overlays[0]
  const parts = o.posts.filter((m) => m.type === 'html')
  assert.ok(parts.length >= 3, `${parts.length} parts`)
  for (const m of o.posts) assert.ok(JSON.stringify(m).length <= 1040384)
  assert.match(parts.map((m) => m.part).join(''), /&quot;quoted&quot;/)
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

test('with ctx.openExternal (cc-cockpit 0.9.1+) the issue goes with a details column; the body keeps the title alone', async () => {
  const calls = []
  const reviewer = { annotate: async (spec) => (calls.push(spec), { ok: true }) }
  const { ctx, h } = boot({ reviewer })
  ctx.openExternal = async () => {}
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(calls.length, 1)
  assert.match(calls[0].aside, /^<dl class="facts"><dt>Status<\/dt>/)
  assert.match(calls[0].html, /^<div class="card"><h1>ABC-1: [^<]+<\/h1><\/div>\n/)
  assert.doesNotMatch(calls[0].html, /class="facts"/)
  await h.stop()
})

test('without ctx.openExternal (0.9.0 and older) no aside is sent and the facts stay in the header card', async () => {
  const calls = []
  const reviewer = { annotate: async (spec) => (calls.push(spec), { ok: true }) }
  const { ctx, h } = boot({ reviewer })
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(calls[0].aside, undefined)
  assert.match(calls[0].html, /<dl class="facts">/)
  await h.stop()
})

// ---- overlay type, buttons, early reader (inbox redesign, task 24) ----

const ITEM = (id, source = 'bronos.jira') => ({ type: { name: 'inbox-item', data: { source, id } }, title: 't', opener: 'bronos.jira' })

test('issue overlays: the reader page starts at once with the inbox-item type and ready manual, before the issue is read', async () => {
  const { ctx, h, jira } = boot({ reviewer: null })
  await h.pollNow('test')
  const reads = () => jira.calls.filter((x) => /\/issue\/ABC-1/.test(x.url)).length
  const before = reads()
  const start = ctx.overlay.start
  let readsAtStart = -1
  ctx.overlay.start = (spec) => ((readsAtStart = reads() - before), start(spec))
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(readsAtStart, 0, 'the overlay was asked for before the issue was read')
  const o = ctx.overlays[0]
  assert.equal(o.spec.ready, 'manual')
  assert.deepEqual(o.spec.type, { name: 'inbox-item', data: { source: 'bronos.jira', id: 'ABC-1' } })
  assert.equal(o.spec.title, 'ABC-1: Checkout fails for EU cards')
  const doc = o.posts.find((p) => p.type === 'doc')
  assert.equal(doc.toolbar, true, 'with the app toolbar the page drops its Discuss and New session')
  const text = o.discuss().text
  assert.match(text, /^Jira issue: ABC-1 Checkout fails for EU cards\nStatus: /)
  assert.ok(text.length <= 4000)
  await h.stop()
})

test('issue overlays: an issue not in the cached rows opens with the bare key as title, with no dangling colon', async () => {
  const { ctx, h } = boot({ reviewer: null })
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(ctx.overlays[0].spec.title, 'ABC-1')
  await h.stop()
})

test('issue overlays: an older app (no ctx.overlay.buttons) keeps the page buttons and still opens', async () => {
  const { ctx, h } = boot({ reviewer: null, noButtons: true })
  await h.pollNow('test')
  assert.equal(ctx.buttonProviders.length, 0)
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(ctx.overlays.length, 1)
  assert.equal(ctx.overlays[0].posts.find((p) => p.type === 'doc').toolbar, undefined)
  await h.stop()
})

test('issue overlays: the early overlay closes when the issue cannot be read, with the error shown', async () => {
  const { ctx, h } = boot({ reviewer: null, jira: { fail: { 'ABC-1': 500 } } })
  await h.pollNow('test')
  // Nothing cached to fall back on for this key's full read: drop the cached copy.
  h.S.cache.issues['ABC-1'] = undefined
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(ctx.overlays.length, 1)
  assert.equal(ctx.overlays[0].closed, true, 'the manual-ready loader does not stay')
  assert.equal(ctx.lastState().notice.kind, 'error')
  await h.stop()
})

test('issue overlays: a failed post to the reader shows an error and closes the loader', async () => {
  const { ctx, h } = boot({ reviewer: null })
  await h.pollNow('test')
  const start = ctx.overlay.start
  ctx.overlay.start = (spec) => {
    const handle = start(spec)
    return { ...handle, post: () => { throw new Error('message too big') } }
  }
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(ctx.overlays[0].closed, true)
  assert.match(ctx.lastState().notice.text, /Cannot show ABC-1: message too big/)
  assert.equal(ctx.lastState().notice.kind, 'error')
  await h.stop()
})

test('issue overlays: the reviewer gets the type in prepare and annotate', async () => {
  const seen = []
  const reviewer = {
    prepare: async (s) => (seen.push(['prepare', s.type]), { opened: true }),
    cancel: async () => ({ closed: false }),
    annotate: async (s) => (seen.push(['annotate', s.type]), { opened: true }),
  }
  const { ctx, h } = boot({ reviewer })
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  const type = { name: 'inbox-item', data: { source: 'bronos.jira', id: 'ABC-1' } }
  assert.deepEqual(seen, [['prepare', type], ['annotate', type]])
  assert.equal(ctx.overlays.length, 0, 'the reviewer path starts no page of ours')
  await h.stop()
})

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
  assert.equal(before.length, 1)
  assert.ok(!before.some((b) => b.id === 'open'))
  assert.match(before[0].label, /read/i)
  await before[0].run(ITEM('ABC-1'))
  const after = await provider(ITEM('ABC-1'))
  assert.notEqual(after[0].id, before[0].id)
  assert.notEqual(after[0].label, before[0].label)
  // The same state the feed's act gives.
  assert.equal(lane(ctx.lastState(), 'inProgress').rows.find((r) => r.key === 'ABC-1').unread, after[0].id === 'markRead')
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
  const { ctx, h } = boot({ noButtons: true, reviewer: { annotate: async () => ({}) } })
  await h.pollNow('test')
  assert.equal(ctx.buttonProviders.length, 0)
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  assert.equal(ctx.lastState().notice, null)
  await h.stop()
})
