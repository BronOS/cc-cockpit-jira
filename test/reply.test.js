'use strict'
// Writing to Jira end to end (0.8.0): the reply page, the Reply buttons and `ccc jira update`, with a
// fake ctx, a fake Jira and a fake reply page that answers the host as panels/reply.js does.
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const { fakeJira, fakeCtx, fakeTriage, fixture, NOW, CONFIGURED, TRANSITIONS } = require('./fakes')
const { parseTime } = require('../dist/lib/util')

const OWNER = { view: 'desktop', access: 'owner' }
const READ = { view: 'web:2', access: 'read', person: 'Ann' }
const WRITE = { view: 'web:3', access: 'write', person: 'Bob' }

/** The reply page as panels/reply.js behaves: takes a fill unless the person typed, answers collect. */
function fakePage() {
  const states = new Map()
  const page = (o, m) => {
    if (o.spec.file !== 'panels/reply.html') return
    const st = states.get(o) || { comment: '', transitionId: '', dirty: false, drawn: false, msgs: [] }
    states.set(o, st)
    st.msgs.push(m)
    if (m.type === 'issue') {
      const f = m.fill
      const apply = Boolean(f) && !(st.drawn && st.dirty)
      if (apply) Object.assign(st, { comment: f.comment, transitionId: f.transitionId, dirty: false, marker: f.marker, asked: f.asked })
      if (f) o.send({ type: 'filled', n: f.n, applied: apply })
      st.drawn = true
    } else if (m.type === 'collect') {
      o.send({ type: 'values', n: m.n, comment: st.comment, transitionId: st.transitionId })
    } else if (m.type === 'result' && m.clearComment) {
      st.comment = ''
    }
  }
  page.state = (o) => states.get(o)
  /** The person types (and maybe picks a move). */
  page.edit = (o, comment, transitionId) => {
    const st = states.get(o)
    st.comment = comment
    if (transitionId !== undefined) st.transitionId = transitionId
    st.dirty = true
    o.send({ type: 'edit', comment: st.comment, transitionId: st.transitionId })
  }
  return page
}

const UPDATED = '2026-11-02T11:30:00.000+0000'

function boot(opts = {}) {
  const jiraOpts = { ...(opts.jira || {}) }
  // After a write Jira's copy moves on: a new `updated` (the seen mark follows it).
  jiraOpts.onWrite = () => {
    const raw = fixture('issue-ABC-1.json')
    raw.fields.updated = UPDATED
    jiraOpts.issues = { ...(jiraOpts.issues || {}), 'ABC-1': raw }
  }
  const jira = fakeJira(jiraOpts)
  const page = fakePage()
  const ctx = fakeCtx({ project: { ...CONFIGURED, ...(opts.project || {}) }, triage: fakeTriage(), sessions: opts.sessions, overlayWait: true, buttons: true, noToolbar: opts.noToolbar, page })
  const h = host._start(ctx, { setInterval: () => 0, clearInterval: () => {}, fetch: jira.fetch, now: () => NOW, setTimeout: () => 0, clearTimeout: () => {}, platform: 'linux', cliWaitMs: 2000 })
  return { jira, ctx, h, page, jiraOpts }
}

const replyPages = (ctx) => ctx.overlays.filter((o) => o.spec.file === 'panels/reply.html')
const lastOf = (o, type) => [...o.posts].reverse().find((m) => m.type === type)

async function until(fn, ms = 3000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('Reply from the panel: the page shows the issue and its moves, writes nothing until the click', async () => {
  const { ctx, h, jira, page } = boot()
  await h.pollNow('test')
  assert.equal(ctx.lastState().writes, true)
  await ctx.sendPanel({ type: 'reply', key: 'ABC-1' }, OWNER)
  const [o] = replyPages(ctx)
  assert.ok(o, 'the reply page opened')
  assert.equal(o.spec.ready, 'manual')
  assert.equal(o.spec.discuss, false)
  assert.equal(o.spec.type, undefined, 'no issue type: no item buttons on the reply page')
  await until(() => lastOf(o, 'issue'))
  const issue = lastOf(o, 'issue')
  assert.equal(issue.key, 'ABC-1')
  assert.equal(issue.status, 'In Progress')
  assert.equal(issue.tone, 'info')
  assert.deepEqual(issue.transitions.map((t) => [t.id, t.enabled]), [['21', true], ['31', true], ['41', false]])
  assert.equal(issue.toolbar, true)
  await until(() => o.buttons.length && o.buttons[0].label === 'Post comment')
  assert.equal(o.buttons[0].disabled, true, 'nothing to post yet')
  // The person types and picks a move: the label follows.
  page.edit(o, 'Fixed in 1.2', '31')
  assert.deepEqual(o.buttons.map((b) => [b.label, b.disabled]), [['Post and move', false]])
  page.edit(o, '', '31')
  assert.equal(o.buttons[0].label, 'Move')
  page.edit(o, 'Fixed in 1.2', '31')
  assert.equal(jira.writes.length, 0, 'nothing written before the click')
  // A second Reply focuses the same page.
  await ctx.sendPanel({ type: 'reply', key: 'ABC-1' }, OWNER)
  assert.equal(replyPages(ctx).length, 1, 'one page per issue')
  await o.click('send', OWNER)
  assert.deepEqual(jira.writes.map((w) => w.what), ['comment', 'transitions'], 'comment first, then the move')
  assert.deepEqual(jira.writes[1].body, { transition: { id: '31' } })
  assert.equal(o.closed, true, 'a full success closes the page')
  assert.match(ctx.lastState().notice.text, /ABC-1: comment posted\. ABC-1: moved to Done\./)
  // The person's own change is not unread: the seen mark moved to the new `updated`; the feed heard it.
  assert.ok(h.S.seen.marks['ABC-1'] >= parseTime(UPDATED))
  assert.equal(h.S.cache.issues['ABC-1'].updated, UPDATED)
  assert.ok(ctx.emitted.some((e) => e.service === 'inbox-feed'))
  await h.stop()
})

test('a read-only guest gets no page and writes nothing; a write guest may', async () => {
  const { ctx, h, jira, page } = boot()
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'reply', key: 'ABC-1' }, READ)
  assert.equal(replyPages(ctx).length, 0)
  assert.match(ctx.lastState().notice.text, /Only the owner or a guest with write access/)
  await ctx.sendPanel({ type: 'reply', key: 'ABC-1' }, WRITE)
  const [o] = replyPages(ctx)
  await until(() => lastOf(o, 'issue'))
  page.edit(o, 'hello')
  // A click whose `from` is a read view writes nothing, whatever the page holds.
  await o.click('send', READ)
  assert.equal(jira.writes.length, 0)
  assert.match(lastOf(o, 'error').message, /Only the owner or a guest with write access/)
  await o.click('send', WRITE)
  assert.deepEqual(jira.writes.map((w) => w.what), ['comment'])
  await h.stop()
})

test('the overlay toolbar: Reply on our issue overlays, checked on the click; gone with writes off', async () => {
  const { ctx, h } = boot()
  await h.pollNow('test')
  const provider = ctx.buttonProviders[0].provider
  const info = { type: { name: 'inbox-item', data: { source: 'bronos.jira', id: 'ABC-1' } }, title: 't', opener: 'bronos.jira' }
  const reply = (await provider(info)).find((b) => b.id === 'reply')
  assert.equal(reply.label, 'Reply')
  await assert.rejects(reply.run(info, READ), /write access/)
  assert.equal(replyPages(ctx).length, 0)
  await reply.run(info, OWNER)
  assert.equal(replyPages(ctx).length, 1)
  await ctx.changeSettings({ ...CONFIGURED, writes: 'off' })
  assert.equal(replyPages(ctx)[0].closed, true, 'writes off closes an open reply page')
  assert.ok(!(await provider(info)).some((b) => b.id === 'reply'))
  assert.equal(ctx.lastState().writes, false)
  await ctx.sendPanel({ type: 'reply', key: 'ABC-1' }, OWNER)
  assert.match(ctx.lastState().notice.text, /writing is off/)
  await h.stop()
})

test('ccc jira update, draft: opens the page filled in, answers at once, writes nothing', async () => {
  const { ctx, h, jira, page } = boot({ sessions: [{ tabId: 't1', status: 'working', cwd: '/p', notes: [], files: [], name: 'Checkout fix' }] })
  await h.pollNow('test')
  const r = await ctx.runCli(['update', 'abc-1', '--status', 'in progress', '-'], { stdin: 'Looking at it now.', tabId: 't1' })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /Draft opened for ABC-1: the person posts it\./)
  assert.match(r.stdout, /Do not run this again/)
  const [o] = replyPages(ctx)
  const st = page.state(o)
  assert.equal(st.comment, 'Looking at it now.')
  assert.equal(st.transitionId, '21', 'by the target status, any case')
  assert.equal(st.marker, 'Draft from Claude (Checkout fix)')
  assert.equal(jira.writes.length, 0)
  // From a shell (no tabId): "Draft from ccc"; an unknown status opens with Keep status and says so.
  o.close()
  const r2 = await ctx.runCli(['update', 'ABC-1', '--status', 'Closed', '-'], { stdin: 'x' })
  assert.equal(r2.code, 0)
  assert.match(r2.stdout, /left at Keep status: no transition or status "Closed".*Possible: Start progress \(to In Progress\), Done/)
  const o2 = replyPages(ctx)[1]
  assert.equal(page.state(o2).marker, 'Draft from ccc')
  assert.equal(page.state(o2).transitionId, '')
  assert.match(page.state(o2).asked, /Asked to move: no transition or status "Closed"/)
  // A disabled one too.
  o2.close()
  const r3 = await ctx.runCli(['update', 'ABC-1', '--status', 'Resolve'])
  assert.equal(r3.code, 0)
  assert.match(r3.stdout, /not possible from here.*needs fields: open in Jira/)
  assert.equal(jira.writes.length, 0)
  await h.stop()
})

test('a new draft replaces an untouched page, and is refused while the person edits theirs', async () => {
  const { ctx, h, page } = boot()
  await h.pollNow('test')
  assert.equal((await ctx.runCli(['update', 'ABC-1', '-'], { stdin: 'first' })).code, 0)
  const [o] = replyPages(ctx)
  assert.equal((await ctx.runCli(['update', 'ABC-1', '-'], { stdin: 'second' })).code, 0)
  assert.equal(replyPages(ctx).length, 1, 'the same page')
  assert.equal(page.state(o).comment, 'second')
  page.edit(o, 'my own words')
  const r = await ctx.runCli(['update', 'ABC-1', '--status', 'Done', '-'], { stdin: 'third' })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /The person is editing a reply to ABC-1: their page was left alone/)
  assert.equal(page.state(o).comment, 'my own words')
  // The race: the person types after the host decided to replace; the page keeps their words.
  const { ctx: c2, h: h2, page: p2 } = boot()
  await h2.pollNow('test')
  await c2.runCli(['update', 'ABC-1', '-'], { stdin: 'first' })
  const [q] = replyPages(c2)
  p2.state(q).dirty = true // typed, its edit message still on the way
  p2.state(q).comment = 'typing…'
  const r2 = await c2.runCli(['update', 'ABC-1', '-'], { stdin: 'second' })
  assert.equal(r2.code, 1)
  assert.equal(p2.state(q).comment, 'typing…')
  await h.stop()
  await h2.stop()
})

test('ccc jira update, direct: comment then move, each step reported; an unknown status writes nothing', async () => {
  const { ctx, h, jira } = boot({ project: { writes: 'direct' } })
  await h.pollNow('test')
  const bad = await ctx.runCli(['update', 'ABC-1', '--status', 'Closed', '-'], { stdin: 'hi' })
  assert.equal(bad.code, 1)
  assert.match(bad.stderr, /ABC-1: no transition or status "Closed".*Possible: .*Nothing was written\./)
  assert.equal(jira.writes.length, 0)
  const r = await ctx.runCli(['update', 'ABC-1', '--status', 'Done', '-'], { stdin: 'Shipped.' })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, 'ABC-1: comment posted\nABC-1: moved to Done\n')
  assert.deepEqual(jira.writes.map((w) => w.what), ['comment', 'transitions'])
  assert.equal(replyPages(ctx).length, 0, 'direct opens no page')
  assert.ok(h.S.seen.marks['ABC-1'] >= parseTime(UPDATED))
  await h.stop()
})

test('direct, partial failure: the comment posted, the move refused; exit 1 with both lines', async () => {
  const { ctx, h, jira } = boot({ project: { writes: 'direct' }, jira: { failTransition: 400 } })
  await h.pollNow('test')
  const r = await ctx.runCli(['update', 'ABC-1', '--status', 'Done', '-'], { stdin: 'Shipped.' })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^ABC-1: comment posted\nABC-1: not moved to Done: moving ABC-1: Jira refused it \(400\)/)
  assert.deepEqual(jira.writes.map((w) => w.what), ['comment'])
  await h.stop()
})

test('off: ccc jira update is refused and nothing is read or written', async () => {
  const { ctx, h, jira } = boot({ project: { writes: 'off' } })
  await h.pollNow('test')
  const before = jira.calls.length
  const r = await ctx.runCli(['update', 'ABC-1', '--status', 'Done'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /writing is off for this project/)
  assert.equal(jira.calls.length, before)
  assert.equal(replyPages(ctx).length, 0)
  await h.stop()
})

test('the page: a move that is gone at the click writes nothing, the comment neither, and the list refreshes', async () => {
  let list = TRANSITIONS
  const { ctx, h, jira, page } = boot({ jira: { transitions: () => list } })
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'reply', key: 'ABC-1' }, OWNER)
  const [o] = replyPages(ctx)
  await until(() => lastOf(o, 'issue'))
  page.edit(o, 'Moving it on', '21')
  list = { transitions: [TRANSITIONS.transitions[1]] } // someone moved it meanwhile
  await o.click('send', OWNER)
  assert.equal(jira.writes.length, 0)
  const t = lastOf(o, 'transitions')
  assert.deepEqual(t.transitions.map((x) => x.id), ['31'])
  assert.equal(t.keep, '')
  assert.match(t.message, /changed meanwhile.*nothing was written/)
  assert.equal(o.closed, undefined, 'the page stays for the person to choose again')
  await h.stop()
})

test('the page: a refused move after a posted comment keeps the page, clears the box, keeps the choice', async () => {
  const { ctx, h, jira, page } = boot({ jira: { failTransition: 400 } })
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'reply', key: 'ABC-1' }, OWNER)
  const [o] = replyPages(ctx)
  await until(() => lastOf(o, 'issue'))
  page.edit(o, 'Done here', '31')
  await o.click('send', OWNER)
  assert.deepEqual(jira.writes.map((w) => w.what), ['comment'])
  const r = lastOf(o, 'result')
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [['comment', true], ['transition', false]])
  assert.equal(r.clearComment, true)
  assert.equal(r.keep, '31')
  assert.equal(o.closed, undefined)
  assert.equal(page.state(o).comment, '')
  assert.equal(o.buttons[0].label, 'Move', 'the retry is the move alone')
  // Nothing is posted twice: the retry moves only.
  await o.click('send', OWNER)
  assert.deepEqual(jira.writes.map((w) => w.what), ['comment'])
  await h.stop()
})

test('an app without overlay toolbar buttons: the page posts submit from its own button', async () => {
  const { ctx, h, jira } = boot({ noToolbar: true })
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'reply', key: 'ABC-1' }, OWNER)
  const [o] = replyPages(ctx)
  await until(() => lastOf(o, 'issue'))
  assert.equal(lastOf(o, 'issue').toolbar, false)
  o.send({ type: 'submit', comment: 'x'.repeat(32001), transitionId: '' }, OWNER)
  await until(() => lastOf(o, 'error'))
  assert.match(lastOf(o, 'error').message, /at most 32,000/)
  o.send({ type: 'submit', comment: 'hi', transitionId: '41' }, OWNER)
  await until(() => /not in the list/.test(lastOf(o, 'error').message))
  o.send({ type: 'submit', comment: 'hi', transitionId: '' }, READ)
  await until(() => /write access/.test(lastOf(o, 'error').message))
  assert.equal(jira.writes.length, 0)
  o.send({ type: 'submit', comment: 'hi', transitionId: '' }, OWNER)
  await until(() => o.closed)
  assert.deepEqual(jira.writes.map((w) => w.what), ['comment'])
  await h.stop()
})
