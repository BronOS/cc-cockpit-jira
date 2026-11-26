'use strict'
// Parts (0.9.0, D13): another plugin's window (a Gmail mail, a calendar event) announces what it shows; a ref that
// is an issue key of a project this plugin knows gets our own part beside their page, drawn by us.
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const { fakeJira, fakeCtx, fakeTriage, kitView, until, NOW, CONFIGURED, OWNER, WRITER, READER } = require('./fakes')

function boot(opts = {}) {
  const jira = fakeJira(opts.jira)
  const ctx = fakeCtx({ project: { ...CONFIGURED, ...(opts.project || {}) }, triage: fakeTriage(), buttons: true, oldApp: opts.oldApp, partRefuse: opts.partRefuse })
  const h = host._start(ctx, { setInterval: () => 0, clearInterval: () => {}, fetch: jira.fetch, now: () => NOW, setTimeout: () => 0, clearTimeout: () => {}, platform: 'linux', cliWaitMs: 2000, overlaySettleMs: 10 })
  return { jira, ctx, h }
}
const mail = (refs, extra = {}) => ({ overlay: { id: 'ov-mail-1', opener: 'bronos.gmail', title: 'Re: checkout' }, kind: 'mail', refs, ...extra })

test("refs that are not a configured project's key attach nothing", async () => {
  const { ctx, h, jira } = boot({ project: { mentionProjects: ['OPS'] } })
  await h.pollNow('test')
  const before = jira.calls.length
  for (const refs of [[], ['ZZZ-1'], ['abc'], ['ABC'], ['not a key'], ['../ABC-1'], ['x'.repeat(201)], [42, null, { key: 'ABC-1' }], 'ABC-1', undefined]) {
    ctx.announce(mail(refs))
  }
  ctx.announce(mail(['ABC-1'], { kind: 'note' })) // a kind we do not listen to
  ctx.announce({ ...mail(['ABC-1']), overlay: { id: 'ov-own', opener: 'bronos.jira', title: 'ours' } }) // our own window
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(ctx.parts, [])
  assert.equal(jira.calls.length, before, 'nothing read for them either')
  // Not configured: nothing, whatever the refs.
  const b2 = boot({ project: { site: '' } })
  b2.ctx.announce(mail(['ABC-1']))
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(b2.ctx.parts, [])
  await h.stop()
  await b2.h.stop()
})

test('a known project\'s key gets one compact, read-only part; Open issue is the owner\'s', async () => {
  const { ctx, h } = boot({ project: { mentionProjects: ['OPS'] } })
  await h.pollNow('test')
  ctx.announce(mail(['ZZZ-9', 'abc-1', 'OPS-7'])) // the first known one wins (case folded)
  assert.equal(ctx.parts.length, 1)
  const p = ctx.parts[0]
  assert.deepEqual(p.spec, { file: 'panels/part.html', title: 'Jira ABC-1', partOf: 'ov-mail-1' })
  for (const c of [OWNER, WRITER, READER]) p.connect(c)
  await until(() => ['c-owner', 'c-write', 'c-read'].every((c) => kitView(p, c).phase === 'ready'))
  const s = kitView(p, 'c-owner').state
  assert.deepEqual([s.key, s.summary, s.status, s.tone, s.canOpen], ['ABC-1', 'Checkout fails for EU cards', 'In Progress', 'info', true])
  assert.equal(kitView(p, 'c-write').state.canOpen, false)
  assert.equal(kitView(p, 'c-read').state.canOpen, false)
  assert.ok(!('comment' in s) && !('reply' in s), 'no writes in a part')
  // The same announcement again: the same part. Open issue: only the owner's click opens the window.
  ctx.announce(mail(['ABC-1']))
  assert.equal(ctx.parts.length, 1)
  p.send({ type: 'open' }, READER)
  p.send({ type: 'open' }, WRITER)
  p.send({ type: 'open' }, undefined)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(ctx.overlays.length, 0)
  p.send({ type: 'open' }, OWNER)
  await until(() => ctx.overlays.length === 1)
  assert.equal(ctx.overlays[0].spec.file, 'panels/issue.html')
  // Discuss and Ask take the issue's text; Ask refuses a read guest.
  assert.match((await p.discuss(OWNER)).text, /^ABC-1: Checkout fails for EU cards/)
  assert.equal(await p.ask(READER), null)
  // A new announcement naming another issue replaces the part; one naming none detaches it.
  ctx.announce(mail(['ABC-2']))
  assert.equal(p.closed, true)
  assert.equal(ctx.parts.length, 2)
  ctx.announce(mail([]))
  assert.equal(ctx.parts[1].closed, true)
  await h.stop()
})

test('F6: a mail announced before the first poll (or before the settings) gets its part once the issue is known', async () => {
  const { ctx, h } = boot()
  // Before any poll nothing names the ABC project: no part yet, the announcement is kept.
  ctx.announce(mail(['ABC-1']))
  ctx.announce({ ...mail(['ZZZ-9']), overlay: { id: 'ov-mail-2', opener: 'bronos.gmail', title: 'other' } })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(ctx.parts, [])
  await h.pollNow('test')
  await until(() => ctx.parts.length === 1)
  assert.deepEqual(ctx.parts[0].spec, { file: 'panels/part.html', title: 'Jira ABC-1', partOf: 'ov-mail-1' })
  // Still checked against the known projects: ZZZ never is. A second poll adds nothing.
  await h.pollNow('again')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(ctx.parts.length, 1)
  await h.stop()

  // Not configured when the mail announced: the part comes with the settings (Mentioned names OPS) and the next poll.
  const b = boot({ project: { site: '' } })
  b.ctx.announce(mail(['OPS-7']))
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(b.ctx.parts, [])
  await b.ctx.changeSettings({ ...CONFIGURED, mentionProjects: ['OPS'] })
  await until(() => b.ctx.parts.length === 1)
  assert.equal(b.ctx.parts[0].spec.title, 'Jira OPS-7')
  // A newer announcement of that overlay naming nothing known detaches it; nothing comes back on a poll.
  b.ctx.announce(mail(['nothing']))
  await b.h.pollNow('test')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(b.ctx.parts[0].closed, true)
  assert.equal(b.ctx.parts.length, 1)
  await b.h.stop()
})

test('a part the app refuses is logged and skipped; an old app never hears an announcement', async () => {
  const { ctx, h } = boot({ partRefuse: 'overlay: a part of this plugin is there already' })
  await h.pollNow('test')
  ctx.announce(mail(['ABC-1']))
  assert.deepEqual(ctx.parts, [])
  assert.ok(ctx.logs.some(([lvl, t]) => lvl === 'info' && /no part for ABC-1/.test(t)))
  const old = boot({ oldApp: true })
  assert.equal(old.ctx.announceListeners.length, 0)
  await h.stop()
  await old.h.stop()
})
