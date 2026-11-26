'use strict'
// Writing to Jira end to end (0.8.0; 0.9.0: the Reply tab of the issue window): the form the host keeps per issue,
// Post, and `ccc jira update`, with a fake ctx (perView copies), a fake Jira and the pages' messages.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const host = require('../dist/host')
const wr = require('../dist/lib/write')
const { replyFields } = require('../panels/replylogic')
const { fakeJira, fakeCtx, fakeTriage, fixture, kitView, until, NOW, CONFIGURED, TRANSITIONS, OWNER, WRITER, READER } = require('./fakes')
const { parseTime } = require('../dist/lib/util')

const UPDATED = '2026-11-02T11:30:00.000+0000'

function boot(opts = {}) {
  const jiraOpts = { ...(opts.jira || {}) }
  // After a write Jira's copy moves on: a new `updated` (the seen mark follows it).
  jiraOpts.onWrite = (w) => {
    if (opts.onWrite) opts.onWrite(w)
    const raw = fixture('issue-ABC-1.json')
    raw.fields.updated = UPDATED
    if (opts.mutate) opts.mutate(raw)
    jiraOpts.issues = { ...(jiraOpts.issues || {}), 'ABC-1': raw }
  }
  const jira = fakeJira(jiraOpts)
  const ctx = fakeCtx({ project: { ...CONFIGURED, ...(opts.project || {}) }, triage: fakeTriage(), sessions: opts.sessions, buttons: true })
  const h = host._start(ctx, { setInterval: () => 0, clearInterval: () => {}, fetch: jira.fetch, now: () => NOW, setTimeout: () => 0, clearTimeout: () => {}, platform: 'linux', cliWaitMs: 2000, draftWaitMs: opts.draftWaitMs, overlaySettleMs: 10 })
  return { jira, ctx, h, jiraOpts }
}

const windowsOf = (ctx) => ctx.overlays.filter((o) => o.spec.file === 'panels/issue.html')
const lastOwn = (o, copy, type) => [...kitView(o, copy).own].reverse().find((m) => m.type === type)
const replyOf = (o, copy = 'c-owner') => lastOwn(o, copy, 'reply')
const noteOf = (o, copy = 'c-owner') => lastOwn(o, copy, 'replyNote')
const edit = (o, from, comment, transitionId = '') => o.send({ type: 'edit', comment, transitionId }, from)
const post = (o, from, comment, transitionId = '') => o.send({ type: 'post', comment, transitionId }, from)

/** Reply from the panel (by `from`), the window's copies connected; waits for the owner's form. */
async function openReply(ctx, ...copies) {
  await ctx.sendPanel({ type: 'reply', key: 'ABC-1' }, OWNER)
  const o = windowsOf(ctx).at(-1)
  for (const c of copies.length ? copies : [OWNER]) o.connect(c)
  await until(() => replyOf(o, (copies[0] || OWNER).copy) && replyOf(o, (copies[0] || OWNER).copy).loaded)
  return o
}

test('Reply from the panel: the window opens on Reply with the moves; nothing is written until Post', async () => {
  const { ctx, h, jira } = boot()
  await h.pollNow('test')
  assert.equal(ctx.lastState().writes, true)
  const o = await openReply(ctx)
  assert.deepEqual(lastOwn(o, 'c-owner', 'select'), { type: 'select', tab: 'reply' })
  const r = replyOf(o)
  assert.equal(r.status, 'In Progress')
  assert.equal(r.tone, 'info')
  assert.deepEqual(r.transitions.map((t) => [t.id, t.enabled]), [['21', true], ['31', true], ['41', false]])
  assert.equal(r.max, 32000)
  assert.equal(r.comment, '')
  edit(o, OWNER, 'Fixed in 1.2', '31')
  assert.equal(jira.writes.length, 0, 'nothing written before the click')
  // A second Reply focuses the same window.
  await ctx.sendPanel({ type: 'reply', key: 'ABC-1' }, OWNER)
  assert.equal(windowsOf(ctx).length, 1, 'one window per issue')
  assert.ok(o.focused >= 1)
  post(o, OWNER, 'Fixed in 1.2', '31')
  await until(() => jira.writes.length === 2)
  assert.deepEqual(jira.writes.map((w) => w.what), ['comment', 'transitions'], 'comment first, then the move')
  assert.deepEqual(jira.writes[1].body, { transition: { id: '31' } })
  await until(() => replyOf(o).note && /moved to Done/.test(replyOf(o).note.text))
  assert.equal(o.closed, false, 'the window stays, showing the issue as it is now')
  assert.equal(replyOf(o).comment, '', 'the form starts over')
  assert.match(ctx.lastState().notice.text, /ABC-1: comment posted\. ABC-1: moved to Done\./)
  // The person's own change is not unread: the seen mark moved to the new `updated`; the feed heard it.
  assert.ok(h.S.seen.marks['ABC-1'] >= parseTime(UPDATED))
  assert.equal(h.S.cache.issues['ABC-1'].updated, UPDATED)
  assert.ok(ctx.emitted.some((e) => e.service === 'inbox-feed'))
  await h.stop()
})

test("a read guest's Post is refused by from.access. Fail closed: a missing from refuses", async () => {
  const { ctx, h, jira } = boot()
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'reply', key: 'ABC-1' }, READER)
  assert.equal(windowsOf(ctx).length, 0)
  assert.match(ctx.lastState().notice.text, /Only the owner or a guest with write access/)
  const o = await openReply(ctx, OWNER, WRITER, READER)
  edit(o, OWNER, 'hello')
  // A Post whose `from` is a read view writes nothing, whatever its page holds.
  post(o, READER, 'hello')
  await until(() => noteOf(o, 'c-read'))
  assert.match(noteOf(o, 'c-read').text, /Only the owner or a guest with write access/)
  // No `from` at all (an app that does not say who): nothing, and no owner default anywhere.
  post(o, undefined, 'hello')
  post(o, { view: 'desktop', copy: 'c-owner' }, 'hello') // no access
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(jira.writes.length, 0)
  assert.equal(wr.mayWrite(undefined), false)
  assert.equal(wr.mayWrite(null), false)
  assert.equal(wr.mayWrite({ view: 'desktop' }), false)
  // A write guest may (it uses the owner's Jira token, as 0.8.0 did).
  post(o, WRITER, 'hello')
  await until(() => jira.writes.length === 1)
  assert.deepEqual(jira.writes.map((w) => w.what), ['comment'])
  await h.stop()
})

test("a read guest's copy gets no Reply tab and no draft", async () => {
  const { ctx, h } = boot({ sessions: [{ tabId: 't1', status: 'working', cwd: '/p', notes: [], files: [], name: 'Checkout fix' }] })
  await h.pollNow('test')
  const r = await ctx.runCli(['update', 'ABC-1', '-'], { stdin: 'Draft text', tabId: 't1' })
  assert.equal(r.code, 0, r.stderr)
  const o = windowsOf(ctx)[0]
  o.connect(READER)
  o.connect(OWNER)
  await until(() => kitView(o, 'c-read').phase === 'ready' && replyOf(o) && replyOf(o).comment === 'Draft text')
  assert.equal(kitView(o, 'c-read').state.reply, false)
  assert.equal(kitView(o, 'c-owner').state.reply, true)
  const own = kitView(o, 'c-read').own
  assert.deepEqual(own.filter((m) => m.type === 'reply' || m.type === 'select'), [], 'no form, no draft, no Reply selected')
  assert.ok(!JSON.stringify(o.sent('c-read')).includes('Draft text'))
  // Its edits are dropped too.
  edit(o, READER, 'guest words')
  await new Promise((r2) => setTimeout(r2, 10))
  assert.equal(replyOf(o).comment, 'Draft text')
  await h.stop()
})

test('Reply draft survives Esc', async () => {
  const { ctx, h, jira } = boot({ sessions: [{ tabId: 't1', status: 'working', cwd: '/p', notes: [], files: [], name: 'Checkout fix' }] })
  await h.pollNow('test')
  assert.equal((await ctx.runCli(['update', 'ABC-1', '--status', 'in progress', '-'], { stdin: 'Looking at it now.', tabId: 't1' })).code, 0)
  const o = windowsOf(ctx)[0]
  o.close() // Esc
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  const o2 = windowsOf(ctx)[1]
  assert.ok(o2 && o2 !== o, 'a new window')
  o2.connect(OWNER)
  await until(() => replyOf(o2))
  assert.equal(replyOf(o2).comment, 'Looking at it now.')
  assert.equal(replyOf(o2).transitionId, '21')
  assert.equal(replyOf(o2).marker, 'Draft from Claude (Checkout fix)')
  // The person's own words survive Esc too, and stay theirs: a draft from ccc is then refused.
  edit(o2, OWNER, 'my own words')
  o2.close()
  const r = await ctx.runCli(['update', 'ABC-1', '-'], { stdin: 'another' })
  assert.equal(r.code, 1)
  await ctx.sendPanel({ type: 'open', key: 'ABC-1' })
  const o3 = windowsOf(ctx)[2]
  o3.connect(OWNER)
  await until(() => replyOf(o3))
  assert.equal(replyOf(o3).comment, 'my own words')
  assert.equal(jira.writes.length, 0)
  await h.stop()
})

test('two views see one draft', async () => {
  const { ctx, h, jira } = boot()
  await h.pollNow('test')
  const o = await openReply(ctx, OWNER, WRITER)
  await until(() => replyOf(o, 'c-write') && replyOf(o, 'c-write').loaded)
  // A draft reaches both.
  assert.equal((await ctx.runCli(['update', 'ABC-1', '-'], { stdin: 'from Claude' })).code, 0)
  await until(() => replyOf(o, 'c-owner').comment === 'from Claude' && replyOf(o, 'c-write').comment === 'from Claude')
  // The write guest types: the owner's copy follows; the typing copy keeps its own fields (own).
  edit(o, WRITER, 'guest edit', '31')
  assert.deepEqual([replyOf(o, 'c-owner').comment, replyOf(o, 'c-owner').transitionId, replyOf(o, 'c-owner').edited], ['guest edit', '31', true])
  assert.equal(replyOf(o, 'c-write').own, true)
  assert.equal(replyOf(o, 'c-write').comment, undefined)
  // Last write wins: the owner types over it.
  edit(o, OWNER, 'owner edit', '')
  assert.equal(replyOf(o, 'c-write').comment, 'owner edit')
  // A Post of words its copy no longer shows (the other's edit came in between) writes nothing.
  post(o, WRITER, 'guest edit', '31')
  await until(() => noteOf(o, 'c-write'))
  assert.match(noteOf(o, 'c-write').text, /draft just changed/)
  assert.equal(jira.writes.length, 0)
  post(o, WRITER, 'owner edit', '')
  await until(() => jira.writes.length === 1)
  // And a ccc draft now is refused: a copy typed.
  const { ctx: c2, h: h2 } = boot()
  await h2.pollNow('test')
  const q = await openReply(c2, OWNER, WRITER)
  edit(q, WRITER, 'typed')
  const r = await c2.runCli(['update', 'ABC-1', '-'], { stdin: 'draft' })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /The person is editing a reply to ABC-1: their words were left alone/)
  await h.stop()
  await h2.stop()
})

test('the Ask answer never fills Reply', async () => {
  const { ctx, h } = boot()
  await h.pollNow('test')
  const o = await openReply(ctx, OWNER)
  await until(() => kitView(o, 'c-owner').phase === 'ready')
  edit(o, OWNER, 'my reply')
  const before = JSON.stringify(replyOf(o))
  const replies = kitView(o, 'c-owner').own.filter((m) => m.type === 'reply').length
  // Ask runs in the app; the host only hands it the issue's text, and nothing comes back to the form.
  assert.match((await o.ask(OWNER)).text, /^ABC-1: /)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(kitView(o, 'c-owner').own.filter((m) => m.type === 'reply').length, replies)
  assert.equal(JSON.stringify(replyOf(o)), before)
  assert.equal(h.S.cache && typeof h.S.cache, 'object')
  // The page: only a `reply` message from the host fills the form; no Ask push does.
  const pushes = [
    { ev: 'ask', data: { type: 'answer', text: 'Post this: done' } },
    { type: 'answer', text: 'Post this' },
    { type: 'delta', text: 'x' },
    { type: 'history', turns: [{ question: 'q', answer: 'a' }] },
    { type: 'cc-kit.state', state: { comment: 'x' } },
    { type: 'reply', own: true, comment: 'x' },
  ]
  for (const p of pushes) assert.equal(replyFields(p), null, JSON.stringify(p))
  assert.deepEqual(replyFields({ type: 'reply', comment: 'from the host', transitionId: '21' }), { comment: 'from the host', transitionId: '21' })
  // And issue.js sets the comment box from replyFields' answer alone.
  const page = fs.readFileSync(path.join(__dirname, '../panels/issue.js'), 'utf8')
  const sets = page.match(/comment\.value = [^\n]+/g)
  assert.deepEqual(sets, ['comment.value = f.comment'])
  assert.match(page, /const f = replyFields\(m\)/)
  await h.stop()
})

test('Reply is the window\'s tab: no toolbar Reply or send button; writes off drops the form and the tab', async () => {
  const { ctx, h } = boot()
  await h.pollNow('test')
  const provider = ctx.buttonProviders[0].provider
  const info = { type: { name: 'inbox-item', data: { source: 'bronos.jira', id: 'ABC-1' } }, title: 't', opener: 'bronos.jira' }
  assert.ok(!(await provider(info)).some((b) => b.id === 'reply'))
  const o = await openReply(ctx, OWNER)
  assert.deepEqual(o.buttons.map((b) => b.id), ['browser'], 'no send button: Post is in the tab')
  edit(o, OWNER, 'unsent')
  await until(() => kitView(o, 'c-owner').phase === 'ready')
  await ctx.changeSettings({ ...CONFIGURED, writes: 'off' })
  assert.equal(o.closed, false, 'the window stays')
  assert.equal(kitView(o, 'c-owner').state.reply, false, 'its copies lose the Reply tab')
  assert.equal(ctx.lastState().writes, false)
  await ctx.sendPanel({ type: 'reply', key: 'ABC-1' }, OWNER)
  assert.match(ctx.lastState().notice.text, /writing is off/)
  await ctx.changeSettings({ ...CONFIGURED, writes: 'draft' })
  o.send({ type: 'replyOpen' }, OWNER)
  await until(() => replyOf(o).comment === '' && replyOf(o).loaded)
  await h.stop()
})

test('ccc jira update, draft: opens the window on Reply filled in, answers at once, writes nothing', async () => {
  const { ctx, h, jira } = boot({ sessions: [{ tabId: 't1', status: 'working', cwd: '/p', notes: [], files: [], name: 'Checkout fix' }] })
  await h.pollNow('test')
  const r = await ctx.runCli(['update', 'abc-1', '--status', 'in progress', '-'], { stdin: 'Looking at it now.', tabId: 't1' })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /Draft opened for ABC-1: the person posts it\./)
  assert.match(r.stdout, /decides in the Reply tab\. Do not run this again/)
  const [o] = windowsOf(ctx)
  o.connect(OWNER)
  await until(() => replyOf(o))
  assert.deepEqual(lastOwn(o, 'c-owner', 'select'), { type: 'select', tab: 'reply' }, 'a draft opens Reply (D7)')
  const f = replyOf(o)
  assert.equal(f.comment, 'Looking at it now.')
  assert.equal(f.transitionId, '21', 'by the target status, any case')
  assert.equal(f.marker, 'Draft from Claude (Checkout fix)')
  assert.equal(f.edited, false)
  assert.equal(jira.writes.length, 0)
  // From a shell (no tabId): "Draft from ccc"; an unknown status keeps the status and says so.
  const r2 = await ctx.runCli(['update', 'ABC-1', '--status', 'Closed', '-'], { stdin: 'x' })
  assert.equal(r2.code, 0)
  assert.match(r2.stdout, /left at Keep status: no transition or status "Closed".*Possible: Start progress \(to In Progress\), Done/)
  await until(() => replyOf(o).marker === 'Draft from ccc')
  assert.equal(replyOf(o).transitionId, '')
  assert.match(replyOf(o).asked, /Asked to move: no transition or status "Closed"/)
  // A disabled one too.
  const r3 = await ctx.runCli(['update', 'ABC-1', '--status', 'Resolve'])
  assert.equal(r3.code, 0)
  assert.match(r3.stdout, /not possible from here.*needs fields: open in Jira/)
  assert.equal(jira.writes.length, 0)
  assert.equal(windowsOf(ctx).length, 1, 'the same window')
  await h.stop()
})

test('a new draft replaces an untouched form, and is refused once a copy typed, also during its read', async () => {
  const { ctx, h } = boot()
  await h.pollNow('test')
  assert.equal((await ctx.runCli(['update', 'ABC-1', '-'], { stdin: 'first' })).code, 0)
  const [o] = windowsOf(ctx)
  o.connect(OWNER)
  assert.equal((await ctx.runCli(['update', 'ABC-1', '-'], { stdin: 'second' })).code, 0)
  await until(() => replyOf(o) && replyOf(o).comment === 'second')
  edit(o, OWNER, 'my own words')
  const r = await ctx.runCli(['update', 'ABC-1', '--status', 'Done', '-'], { stdin: 'third' })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /The person is editing a reply to ABC-1: their words were left alone/)
  // (The typing copy's own answers carry no fields: another copy shows what the form holds.)
  o.connect({ ...OWNER, copy: 'c-owner-2' })
  await until(() => replyOf(o, 'c-owner-2'))
  assert.equal(replyOf(o, 'c-owner-2').comment, 'my own words')
  // The race: the person types while the draft's issue read is under way; their words stay.
  const g = gate((url, init) => init.method !== 'POST' && url.includes('/transitions'))
  const { ctx: c2, h: h2 } = boot({ jira: { routes: g.route } })
  await h2.pollNow('test')
  assert.equal((await c2.runCli(['update', 'ABC-1', '-'], { stdin: 'first' })).code, 0)
  const [q] = windowsOf(c2)
  q.connect(OWNER)
  g.armed = true
  const cli = c2.runCli(['update', 'ABC-1', '-'], { stdin: 'second' })
  await until(() => g.hit > 0)
  edit(q, OWNER, 'typing…')
  g.armed = false
  g.open()
  const r2 = await cli
  assert.equal(r2.code, 1)
  assert.equal(replyOf(q).comment, 'typing…')
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
  assert.equal(windowsOf(ctx).length, 0, 'direct opens no page')
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
  assert.equal(windowsOf(ctx).length, 0)
  await h.stop()
})


test('Post: a move that is gone at the click writes nothing, the comment neither, and the list refreshes', async () => {
  let list = TRANSITIONS
  const { ctx, h, jira } = boot({ jira: { transitions: () => list } })
  await h.pollNow('test')
  const o = await openReply(ctx)
  edit(o, OWNER, 'Moving it on', '21')
  list = { transitions: [TRANSITIONS.transitions[1]] } // someone moved it meanwhile
  post(o, OWNER, 'Moving it on', '21')
  await until(() => replyOf(o).note && replyOf(o).note.kind === 'error' && !replyOf(o).busy)
  assert.equal(jira.writes.length, 0)
  const f = replyOf(o)
  assert.deepEqual(f.transitions.map((x) => x.id), ['31'])
  assert.equal(f.transitionId, '')
  assert.match(f.note.text, /changed meanwhile.*nothing was written/i)
  await h.stop()
})

test('Post: a refused move after a posted comment keeps the form, clears the box, keeps the choice', async () => {
  const { ctx, h, jira } = boot({ jira: { failTransition: 400 } })
  await h.pollNow('test')
  const o = await openReply(ctx)
  edit(o, OWNER, 'Done here', '31')
  post(o, OWNER, 'Done here', '31')
  await until(() => replyOf(o).note && replyOf(o).note.steps && !replyOf(o).busy)
  assert.deepEqual(jira.writes.map((w) => w.what), ['comment'])
  const f = replyOf(o)
  assert.deepEqual(f.note.steps.map((s) => [s.step, s.ok]), [['comment', true], ['transition', false]])
  assert.equal(f.comment, '', 'the posted comment left the box')
  assert.equal(f.transitionId, '31', 'the move stays for a retry')
  // Nothing is posted twice: the retry moves only.
  post(o, OWNER, '', '31')
  await until(() => jira.writes.length >= 1 && !replyOf(o).busy && replyOf(o).note && replyOf(o).note.steps && replyOf(o).note.steps.length === 1)
  assert.deepEqual(jira.writes.map((w) => w.what), ['comment'])
  await h.stop()
})

test('Post checks its values as input: over the limit, a move not listed, nothing at all', async () => {
  const { ctx, h, jira } = boot()
  await h.pollNow('test')
  const o = await openReply(ctx)
  const long = 'x'.repeat(32001)
  edit(o, OWNER, long)
  post(o, OWNER, long)
  await until(() => noteOf(o))
  assert.match(noteOf(o).text, /at most 32,000/)
  edit(o, OWNER, 'hi', '41')
  post(o, OWNER, 'hi', '41')
  await until(() => /not in the list/.test(noteOf(o).text))
  edit(o, OWNER, '  ', '')
  post(o, OWNER, '  ', '')
  await until(() => /Nothing to post/.test(noteOf(o).text))
  assert.equal(jira.writes.length, 0)
  await h.stop()
})

// ---- review round 1 (codex sol/high), as 0.9.0 has them ----

/** A gate: requests matching `match` wait until open() (the test changes things meanwhile). */
function gate(match) {
  let open
  const opened = new Promise((r) => (open = r))
  const g = { hit: 0, armed: false }
  g.open = open
  g.route = async (url, init) => {
    if (g.armed && match(url, init)) {
      g.hit++
      await opened
    }
    return undefined
  }
  return g
}

test('R1-1: a Post made on a draft the copy had not seen posts nothing', async () => {
  const { ctx, h, jira } = boot()
  await h.pollNow('test')
  assert.equal((await ctx.runCli(['update', 'ABC-1', '-'], { stdin: 'draft A' })).code, 0)
  const [o] = windowsOf(ctx)
  o.connect(OWNER)
  await until(() => replyOf(o) && replyOf(o).comment === 'draft A')
  // Draft B reaches the host while the person, having read A, clicks Post.
  assert.equal((await ctx.runCli(['update', 'ABC-1', '-'], { stdin: 'draft B, never reviewed' })).code, 0)
  post(o, OWNER, 'draft A')
  await until(() => noteOf(o))
  assert.match(noteOf(o).text, /draft just changed/)
  assert.equal(jira.writes.length, 0, 'neither A nor B is posted on a click made on A')
  await h.stop()
})

test('R1-2: writes switched off (or the token changed) during the reads: ccc direct posts nothing', async () => {
  for (const change of [{ writes: 'off' }, { writes: 'draft' }, { writes: 'direct', apiToken: 'another-token' }]) {
    const g = gate((url, init) => init.method !== 'POST' && url.includes('/transitions'))
    const { ctx, h, jira } = boot({ project: { writes: 'direct' }, jira: { routes: g.route } })
    await h.pollNow('test')
    g.armed = true
    const cli = ctx.runCli(['update', 'ABC-1', '--status', 'Done', '-'], { stdin: 'hi' })
    await until(() => g.hit > 0)
    await ctx.changeSettings({ ...CONFIGURED, ...change })
    g.open()
    const r = await cli
    assert.equal(jira.writes.length, 0, JSON.stringify(change))
    assert.equal(r.code, 1)
    assert.match(r.stderr, /nothing was written/)
    await h.stop()
  }
})

test("R1-2: the window's Post: writes switched off during the click's reads posts nothing", async () => {
  const g = gate((url, init) => init.method !== 'POST' && url.includes('/transitions'))
  const { ctx, h, jira } = boot({ jira: { routes: g.route } })
  await h.pollNow('test')
  const o = await openReply(ctx)
  edit(o, OWNER, 'hi', '21')
  g.armed = true
  post(o, OWNER, 'hi', '21')
  await until(() => g.hit > 0)
  await ctx.changeSettings({ ...CONFIGURED, writes: 'off' })
  g.open()
  // With writes off the copies no longer get the form (no Reply tab); the write stopped at its guard.
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(jira.writes.length, 0)
  assert.equal(kitView(o, 'c-owner').state.reply, false)
  await h.stop()
})

test('R1-5: a poll that started before a write does not bring the old status back', async () => {
  let written = false
  const g = gate((url) => url.includes('/search/jql'))
  const routes = async (url, init) => {
    const before = !written // the search was sent before the write: Jira's answer is the old one
    await g.route(url, init)
    if (!before && url.includes('/search/jql') && url.includes('statusCategory+%21%3D+Done')) {
      const body = fixture('search-assigned-1.json')
      body.issues = body.issues.filter((i) => i.key !== 'ABC-1') // moved to Done: no longer open
      return new Response(JSON.stringify(body), { status: 200 })
    }
    return undefined
  }
  const { ctx, h } = boot({
    project: { writes: 'direct' },
    jira: { routes },
    onWrite: () => (written = true),
    mutate: (raw) => (raw.fields.status = { name: 'Done', statusCategory: { key: 'done' } }),
  })
  await h.pollNow('test')
  const inProgress = () => ctx.lastState().lanes.find((l) => l.id === 'inProgress').rows.map((r) => r.key)
  assert.ok(inProgress().includes('ABC-1'))
  g.armed = true
  const slow = h.pollNow('slow') // its search waits at the gate, sent before the write
  await until(() => g.hit > 0)
  const r = await ctx.runCli(['update', 'ABC-1', '--status', 'Done'])
  assert.equal(r.code, 0, r.stderr)
  assert.ok(!inProgress().includes('ABC-1'), 'the write moved it out')
  g.armed = false
  g.open()
  await slow
  assert.ok(!inProgress().includes('ABC-1'), 'the stale poll did not put it back')
  // A follow-up poll was queued behind the stale one, and it agrees.
  await until(() => !h.S.polling)
  assert.ok(!inProgress().includes('ABC-1'))
  await h.stop()
})

// ---- review round 2 (codex sol/high) ----

test('R2-1: ccc direct writes with the client and settings it started with, never ones set during its reads', async () => {
  const g = gate((url, init) => init.method !== 'POST' && url.includes('/transitions'))
  const { ctx, h, jira } = boot({ project: { writes: 'direct' }, jira: { routes: g.route, alsoToken: 'replacement-token' } })
  await h.pollNow('test')
  g.armed = true
  const cli = ctx.runCli(['update', 'ABC-1', '--status', 'Done', '-'], { stdin: 'hi' })
  await until(() => g.hit > 0)
  // A valid replacement token (still direct) set while the transitions are read.
  await ctx.changeSettings({ ...CONFIGURED, writes: 'direct', apiToken: 'replacement-token' })
  g.open()
  const r = await cli
  assert.equal(jira.writes.length, 0, 'not written with the new token, nor with the old one')
  assert.equal(r.code, 1)
  assert.match(r.stderr, /settings \(site, email or token\) changed.*nothing was written/)
  await h.stop()
})

test('R2-2: writes switched off while the client settles its token kind (before any poll): no POST', async () => {
  const g = gate((url, init) => init.method !== 'POST' && url.endsWith('/rest/api/3/myself'))
  const { ctx, h, jira } = boot({ project: { writes: 'direct' }, jira: { routes: g.route } })
  g.armed = true
  const cli = ctx.runCli(['update', 'ABC-1', '-'], { stdin: 'hi' }) // comment only: no read before the POST
  await until(() => g.hit > 0)
  await ctx.changeSettings({ ...CONFIGURED, writes: 'off' })
  g.open()
  const r = await cli
  assert.equal(jira.writes.length, 0)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /writing is off.*nothing was written/)
  await h.stop()
})

