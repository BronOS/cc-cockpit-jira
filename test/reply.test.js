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
      if (apply) Object.assign(st, { comment: f.comment, transitionId: f.transitionId, dirty: false, marker: f.marker, asked: f.asked, rev: f.n })
      // `page.hold`: the page drew the fill but its ack is still on the way (released by page.release()).
      const ack = () => f && o.send({ type: 'filled', n: f.n, applied: apply })
      if (page.hold) page.held.push(ack)
      else ack()
      st.drawn = true
    } else if (m.type === 'collect' && page.onCollect) {
      // A test answers the collect itself (later, or with other values).
      page.onCollect(o, m, st)
    } else if (m.type === 'collect') {
      o.send({ type: 'values', n: m.n, comment: st.comment, transitionId: st.transitionId, rev: st.rev })
    } else if (m.type === 'result' && m.clearComment) {
      st.comment = ''
    }
  }
  page.state = (o) => states.get(o)
  page.hold = false
  page.held = []
  page.release = () => {
    page.hold = false
    for (const a of page.held.splice(0)) a()
  }
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
  jiraOpts.onWrite = (w) => {
    if (opts.onWrite) opts.onWrite(w)
    const raw = fixture('issue-ABC-1.json')
    raw.fields.updated = UPDATED
    if (opts.mutate) opts.mutate(raw)
    jiraOpts.issues = { ...(jiraOpts.issues || {}), 'ABC-1': raw }
  }
  const jira = fakeJira(jiraOpts)
  const page = fakePage()
  const ctx = fakeCtx({ project: { ...CONFIGURED, ...(opts.project || {}) }, triage: fakeTriage(), sessions: opts.sessions, overlayWait: true, buttons: true, noToolbar: opts.noToolbar, page })
  const h = host._start(ctx, { setInterval: () => 0, clearInterval: () => {}, fetch: jira.fetch, now: () => NOW, setTimeout: () => 0, clearTimeout: () => {}, platform: 'linux', cliWaitMs: 2000, draftWaitMs: opts.draftWaitMs })
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
  o.send({ type: 'submit', comment: 'x'.repeat(32001), transitionId: '', rev: 1 }, OWNER)
  await until(() => lastOf(o, 'error'))
  assert.match(lastOf(o, 'error').message, /at most 32,000/)
  o.send({ type: 'submit', comment: 'hi', transitionId: '41', rev: 1 }, OWNER)
  await until(() => /not in the list/.test(lastOf(o, 'error').message))
  o.send({ type: 'submit', comment: 'hi', transitionId: '', rev: 1 }, READ)
  await until(() => /write access/.test(lastOf(o, 'error').message))
  assert.equal(jira.writes.length, 0)
  o.send({ type: 'submit', comment: 'hi', transitionId: '', rev: 1 }, OWNER)
  await until(() => o.closed)
  assert.deepEqual(jira.writes.map((w) => w.what), ['comment'])
  await h.stop()
})

// ---- review round 1 (codex sol/high) ----

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

test('R1-1: a click while a new draft is arriving posts nothing; a stale revision is refused', async () => {
  const { ctx, h, jira, page } = boot()
  await h.pollNow('test')
  assert.equal((await ctx.runCli(['update', 'ABC-1', '-'], { stdin: 'draft A' })).code, 0)
  const [o] = replyPages(ctx)
  // Draft B reaches the page (drawn) while its ack is still on the way; the person clicks, having read A.
  page.hold = true
  const cli = ctx.runCli(['update', 'ABC-1', '-'], { stdin: 'draft B, never reviewed' })
  await until(() => page.state(o).comment === 'draft B, never reviewed')
  await o.click('send', OWNER)
  assert.equal(jira.writes.length, 0, 'B is not posted on a click made on A')
  assert.match(lastOf(o, 'error').message, /draft just changed/)
  page.release()
  assert.equal((await cli).code, 0)
  // The page's own button with a revision that is not the one the host last saw drawn: refused.
  const { ctx: c2, h: h2, jira: j2 } = boot({ noToolbar: true })
  await h2.pollNow('test')
  await c2.runCli(['update', 'ABC-1', '-'], { stdin: 'A' })
  const [q] = replyPages(c2)
  q.send({ type: 'submit', comment: 'A', transitionId: '', rev: 0 }, OWNER)
  await until(() => lastOf(q, 'error'))
  assert.match(lastOf(q, 'error').message, /draft just changed/)
  assert.equal(j2.writes.length, 0)
  await h.stop()
  await h2.stop()
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

test('R1-2: the reply page: writes switched off during the click\'s reads posts nothing', async () => {
  const g = gate((url, init) => init.method !== 'POST' && url.includes('/transitions'))
  const { ctx, h, jira, page } = boot({ jira: { routes: g.route } })
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'reply', key: 'ABC-1' }, OWNER)
  const [o] = replyPages(ctx)
  await until(() => lastOf(o, 'issue'))
  page.edit(o, 'hi', '21')
  g.armed = true
  const click = o.click('send', OWNER)
  await until(() => g.hit > 0)
  await ctx.changeSettings({ ...CONFIGURED, writes: 'off' })
  g.open()
  await click
  assert.equal(jira.writes.length, 0)
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

test('R2-3: a fill the page refused, answered after the wait, does not leave every later click refused', async () => {
  const { ctx, h, jira, page } = boot({ draftWaitMs: 50 })
  await h.pollNow('test')
  await ctx.runCli(['update', 'ABC-1', '-'], { stdin: 'first' })
  const [o] = replyPages(ctx)
  // The person types (their edit message still on the way) as a second draft arrives; the page keeps
  // their words and its "not applied" answer comes after the host stopped waiting.
  page.state(o).dirty = true
  page.state(o).comment = 'my words'
  page.hold = true
  await ctx.runCli(['update', 'ABC-1', '-'], { stdin: 'second' })
  await new Promise((r) => setTimeout(r, 150)) // past the host's own wait for the page's answer
  page.release()
  await until(() => h.S && [...o.posts].some((m) => m.type === 'issue' && m.fill && m.fill.n === 2))
  await o.click('send', OWNER)
  assert.deepEqual(jira.writes.map((w) => [w.what, w.body.body.content[0].content[0].text]), [['comment', 'my words']])
  await h.stop()
})

test('R2-4: a click refused after the collect leaves the button usable, also when a load finished meanwhile', async () => {
  const g = gate((url, init) => init.method !== 'POST' && url.includes('/transitions'))
  const { ctx, h, jira, page } = boot({ jira: { routes: g.route } })
  await h.pollNow('test')
  await ctx.sendPanel({ type: 'reply', key: 'ABC-1' }, OWNER)
  const [o] = replyPages(ctx)
  await until(() => lastOf(o, 'issue'))
  page.edit(o, 'hi')
  g.armed = true
  o.send({ type: 'reload' }, OWNER) // a re-read under way (Try again)
  await until(() => g.hit > 0)
  let answer
  page.onCollect = (q, m, st) => (answer = () => q.send({ type: 'values', n: m.n, comment: st.comment, transitionId: '', rev: 99 }))
  const click = o.click('send', OWNER)
  await until(() => answer)
  g.armed = false
  g.open() // the load finishes while the click waits for the page's values
  await until(() => o.posts.filter((m) => m.type === 'issue').length >= 2)
  answer() // values of a revision the host did not see drawn: refused
  await click
  assert.equal(jira.writes.length, 0)
  assert.deepEqual(o.buttons.map((b) => [b.label, Boolean(b.disabled), Boolean(b.busy)]), [['Post comment', false, false]])
  await h.stop()
})
