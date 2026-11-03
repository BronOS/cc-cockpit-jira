'use strict'
// The `jira` service (v1) other plugins call: its checks and limits (lib/service.js), and the host
// answering site(), issue() and document() through the fake ctx, the way bronos.gmail calls it.
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const svc = require('../dist/lib/service')
const { fakeJira, fakeCtx, fakeTriage, fixture, picture, SITE, TOKEN, ME, NOW, CONFIGURED } = require('./fakes')

function boot(opts = {}) {
  const jira = fakeJira(opts.jira)
  const ctx = fakeCtx({ project: opts.project === undefined ? CONFIGURED : opts.project, triage: fakeTriage(), reviewer: opts.reviewer })
  let t = NOW
  const clock = opts.clock || { now: () => t, advance: (ms) => (t += ms) }
  const h = host._start(ctx, { setInterval: () => 0, clearInterval: () => {}, fetch: jira.fetch, now: () => clock.now(), setTimeout: () => 0, clearTimeout: () => {}, platform: 'linux', cliWaitMs: 2000, imageWaitMs: opts.imageWaitMs })
  const call = (method, ...args) => ctx.callService('jira', method, args)
  return { jira, ctx, h, call, clock }
}

/** An issue Jira knows but the lanes do not show (Done, assigned to the person). */
function doneIssue(key = 'OPS-5') {
  const raw = fixture('issue-ABC-2.json')
  raw.key = key
  raw.fields.status = { name: 'Done', statusCategory: { key: 'done' } }
  raw.fields.summary = 'Rotate the staging certificates'
  return raw
}

// ---- lib/service.js ----

test('serviceKey: the PROJ-123 shape only, strings only, bounded', () => {
  assert.equal(svc.serviceKey('abc-12'), 'ABC-12')
  assert.equal(svc.serviceKey('OPS_2-7'), 'OPS_2-7')
  for (const bad of ['ABC', 'ABC-0', 'ABC-1/../x', '1BC-2', 'ABC-1 OR x', '', 'A'.repeat(60) + '-1', 12, null, undefined, { key: 'ABC-1' }, ['ABC-1']]) assert.equal(svc.serviceKey(bad), null, String(bad))
  assert.throws(() => svc.checkKey('nope'), /^Error: jira: not an issue key/)
})

test('options are clamped to the plugin\'s own budgets: a caller can only ask for less', () => {
  assert.deepEqual(svc.issueOptions(), { maxAgeMs: 300000 })
  assert.deepEqual(svc.issueOptions({ maxAgeMs: 0 }), { maxAgeMs: 15000 })
  assert.deepEqual(svc.issueOptions({ maxAgeMs: 1e12 }), { maxAgeMs: 3600000 })
  assert.throws(() => svc.issueOptions('x'), /options are an object/)
  const max = { html: 2000000, images: 15, imageChars: 1000, waitMs: 10000 }
  assert.deepEqual(svc.documentOptions(undefined, max), { maxHtmlBytes: 2000000, maxImages: 15, maxImageChars: 1000 })
  assert.deepEqual(svc.documentOptions({ maxHtmlBytes: 5e9, maxImages: 99, maxImageChars: -4, waitMs: 1e9 }, max), { maxHtmlBytes: 2000000, maxImages: 15, maxImageChars: 0, waitMs: 10000 })
  assert.deepEqual(svc.documentOptions({ maxHtmlBytes: 10, maxImages: 0 }, max), { maxHtmlBytes: 20000, maxImages: 0, maxImageChars: 1000 })
})

test('the limiter: at most N at a time, a short queue, a cap per minute; refusals are at once', async () => {
  let t = 0
  const lim = svc.createLimiter({ concurrency: 2, perMinute: 5, queue: 1, what: 'lookups', now: () => t })
  let release
  const gate = new Promise((r) => (release = r))
  let peak = 0
  let running = 0
  const job = async () => {
    running++
    peak = Math.max(peak, running)
    await gate
    running--
    return 'ok'
  }
  const ps = [lim.run(job), lim.run(job), lim.run(job), lim.run(job)]
  const refused = await ps[3].catch((e) => e.message)
  assert.match(refused, /^jira: busy/)
  release()
  assert.deepEqual(await Promise.all(ps.slice(0, 3)), ['ok', 'ok', 'ok'])
  assert.equal(peak, 2)
  await lim.run(async () => 1)
  await lim.run(async () => 1)
  await assert.rejects(lim.run(async () => 1), /too many lookups \(at most 5 a minute\)/)
  t += 60000
  assert.equal(await lim.run(async () => 2), 2)
})

test('the TTL cache is bounded, oldest out', () => {
  const c = svc.createTtlCache(2)
  c.set('a', 1)
  c.set('b', 2)
  c.set('a', 3)
  c.set('c', 4)
  assert.equal(c.get('b'), undefined)
  assert.equal(c.get('a'), 3)
  assert.equal(c.size, 2)
})

// ---- the host ----

test('the host provides jira with site, issue and document', () => {
  const { ctx, h } = boot()
  assert.deepEqual(Object.keys(ctx.provided.jira).sort(), ['document', 'issue', 'site'])
  return h.stop()
})

test('site(): not configured says so; configured: the site, jira@<host>, the account once known', async () => {
  const off = boot({ project: {} })
  const s0 = await off.call('site')
  assert.equal(s0.ready, false)
  assert.deepEqual(s0.senders, [])
  assert.match(s0.error, /not configured in this project \(site, email, apiToken\)/)
  await assert.rejects(off.call('issue', 'ABC-1'), /^Error: jira: the Jira plugin is not configured/)
  assert.equal(off.jira.calls.length, 0)
  await off.h.stop()

  const { call, h } = boot()
  const s1 = await call('site')
  assert.deepEqual(s1, { ready: true, site: SITE, senders: ['jira@acme.atlassian.net'], account: null })
  await h.pollNow('test')
  assert.deepEqual((await call('site')).account, { accountId: ME, displayName: 'Oleg Example' })
  await h.stop()

  const own = boot({ project: { ...CONFIGURED, mailSenders: ['notify@example.com'] } })
  assert.deepEqual((await own.call('site')).senders, ['notify@example.com'])
  await own.h.stop()
})

test('issue(): from the last poll with no request; mine, lane, done, the browse URL', async () => {
  const { call, h, jira } = boot()
  await h.pollNow('test')
  const before = jira.calls.length
  const a = await call('issue', 'abc-1')
  assert.deepEqual(a, {
    key: 'ABC-1',
    summary: 'Checkout fails for EU cards',
    status: 'In Progress',
    category: 'indeterminate',
    done: false,
    priority: a.priority,
    type: a.type,
    assignee: 'Oleg Example',
    mine: true,
    lane: 'inProgress',
    url: `${SITE}/browse/ABC-1`,
    updatedAt: a.updatedAt,
    source: 'poll',
    at: NOW,
  })
  const m = await call('issue', 'XYZ-9')
  assert.equal(m.mine, false)
  assert.equal(m.lane, 'mentioned')
  assert.equal(m.assignee, 'Bob Jones')
  assert.equal(jira.calls.length, before, 'no request: the poll had them')
  await h.stop()
})

test('issue(): a key the lanes do not have is read once (header fields only), then cached', async () => {
  const { call, h, jira, clock } = boot({ jira: { issues: { 'OPS-5': doneIssue() } } })
  await h.pollNow('test')
  const before = jira.calls.length
  const d = await call('issue', 'OPS-5')
  assert.equal(d.done, true)
  assert.equal(d.category, 'done')
  assert.equal(d.mine, true)
  assert.equal(d.lane, 'done')
  assert.equal(d.source, 'fetch')
  const reads = jira.calls.slice(before)
  assert.equal(reads.length, 1)
  const u = new URL(reads[0].url)
  assert.equal(u.pathname, '/rest/api/3/issue/OPS-5')
  assert.equal(u.searchParams.get('expand'), null, 'no changelog')
  assert.doesNotMatch(u.searchParams.get('fields'), /comment|description/)
  // Cached within maxAgeMs; asked again after it.
  await call('issue', 'OPS-5')
  assert.equal(jira.calls.length, before + 1)
  clock.advance(60000)
  await call('issue', 'OPS-5', { maxAgeMs: 30000 })
  assert.equal(jira.calls.length, before + 2)
  // Two calls at once: one request.
  clock.advance(400000)
  await Promise.all([call('issue', 'OPS-5'), call('issue', 'OPS-5')])
  assert.equal(jira.calls.length, before + 3)
  await h.stop()
})

test('issue(): an old poll is not used past maxAgeMs; a stale header is read again', async () => {
  const { call, h, jira, clock } = boot()
  await h.pollNow('test')
  clock.advance(120000)
  const before = jira.calls.length
  assert.equal((await call('issue', 'ABC-1')).source, 'poll', 'within the default 5 min')
  assert.equal((await call('issue', 'ABC-1', { maxAgeMs: 60000 })).source, 'fetch')
  assert.equal(jira.calls.length, before + 1)
  await h.stop()
})

test('issue(): an unknown key throws jira: ... and is not asked again for a while; a bad key never reaches Jira', async () => {
  const { call, h, jira } = boot()
  await h.pollNow('test')
  const before = jira.calls.length
  await assert.rejects(call('issue', 'NOPE-1'), (e) => /^jira: /.test(e.message) && /does not exist/.test(e.message))
  await assert.rejects(call('issue', 'NOPE-1'), /^Error: jira: /)
  assert.equal(jira.calls.length, before + 1)
  for (const bad of ['../../myself', 'ABC-1?expand=x', 42, null]) await assert.rejects(call('issue', bad), /not an issue key/)
  assert.equal(jira.calls.length, before + 1)
  await h.stop()
})

test('issue(): errors never carry the token', async () => {
  const { call, h } = boot({ jira: { token: 'another-token' } })
  const e = await call('issue', 'ABC-1').catch((x) => x)
  assert.match(e.message, /^jira: /)
  assert.ok(!e.message.includes(TOKEN))
  await h.stop()
})

test('issue(): a burst of lookups is bounded (2 at a time, 20 waiting, 30 a minute)', async () => {
  let peak = 0
  let open = 0
  const { call, h, ctx } = boot({
    jira: {
      routes: async (url) => {
        if (!/\/rest\/api\/3\/issue\/BURST-/.test(url)) return undefined
        open++
        peak = Math.max(peak, open)
        await new Promise((r) => setTimeout(r, 5))
        open--
        return new Response(JSON.stringify({ errorMessages: ['Issue does not exist'] }), { status: 404, headers: { 'content-type': 'application/json' } })
      },
    },
  })
  await h.pollNow('test')
  const all = await Promise.allSettled(Array.from({ length: 26 }, (_, i) => call('issue', `BURST-${i + 1}`)))
  const msgs = all.map((r) => (r.status === 'rejected' ? r.reason.message : 'ok'))
  assert.equal(msgs.filter((m) => /busy/.test(m)).length, 4)
  assert.equal(peak, 2)
  assert.ok(ctx.logs.some(([lvl, t]) => lvl === 'warn' && /refused a lookup of BURST-\d+ for bronos\.gmail/.test(t)))
  // 22 started this minute; 8 more fit, the 9th does not.
  const more = await Promise.allSettled(Array.from({ length: 9 }, (_, i) => call('issue', `BURST-${i + 100}`)))
  assert.equal(more.filter((r) => r.status === 'rejected' && /too many issue lookups/.test(r.reason.message)).length, 1)
  await h.stop()
})

test('document(): the reviewer view (html, aside facts, image assets); not marked read', async () => {
  const raw = fixture('issue-ABC-1.json')
  raw.fields.attachment = [{ id: '10001', filename: 'shot.png', mimeType: 'image/png', size: 300, created: '2026-11-01T10:14:00.000+0100', author: { displayName: 'Ann Smith' } }]
  const { call, h, ctx } = boot({ jira: { issues: { 'ABC-1': raw }, attachments: { 10001: picture('png', 300) } } })
  await h.pollNow('test')
  await ctx.runCli(['unread', 'ABC-1'])
  const d = await call('document', 'ABC-1')
  assert.equal(d.key, 'ABC-1')
  assert.equal(d.title, 'ABC-1: Checkout fails for EU cards')
  assert.equal(d.url, `${SITE}/browse/ABC-1`)
  assert.match(d.html, /^<div class="card"><h1>ABC-1: Checkout fails for EU cards<\/h1><\/div>/)
  assert.match(d.html, /<h2>Description<\/h2>/)
  assert.match(d.aside, /^<dl class="facts"><dt>Status<\/dt>/)
  assert.deepEqual(d.assets.map((a) => [a.id, a.mime]), [['att10001', 'image/png']])
  assert.equal(h.S.view.lanes.find((l) => l.id === 'inProgress').rows.find((r) => r.issue.key === 'ABC-1').unread, true, 'still unread')
  // A caller with its own pictures asks for none, and a small html budget.
  const small = await call('document', 'ABC-1', { maxImages: 0, maxHtmlBytes: 20000 })
  assert.deepEqual(small.assets, [])
  assert.match(small.html, /href="https:\/\/acme\.atlassian\.net\/rest\/api\/3\/attachment\/content\/10001"/, 'the picture is a link')
  assert.ok(Buffer.byteLength(small.html) <= 20000)
  await h.stop()
})

test('document(): a long issue fits the caller\'s html budget (oldest comments give way)', async () => {
  const raw = fixture('issue-ABC-1.json')
  const c = raw.fields.comment.comments[0]
  raw.fields.comment.comments = Array.from({ length: 60 }, (_, i) => ({ ...structuredClone(c), id: String(5000 + i), body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: `comment ${i} ` + 'x'.repeat(2000) }] }] } }))
  raw.fields.comment.total = 60
  const { call, h } = boot({ jira: { issues: { 'ABC-1': raw } } })
  const d = await call('document', 'ABC-1', { maxHtmlBytes: 50000 })
  assert.ok(Buffer.byteLength(d.html) <= 50000, `${Buffer.byteLength(d.html)} bytes`)
  assert.match(d.html, /earlier comments are not shown here/)
  assert.match(d.html, /comment 59 /, 'the newest stays')
  await h.stop()
})

test('document(): one at a time, a short queue; the rest are refused', async () => {
  const { call, h } = boot({ jira: { routes: async (url) => (/\/issue\/ABC-1\b/.test(url) ? (await new Promise((r) => setTimeout(r, 10)), undefined) : undefined) } })
  const all = await Promise.allSettled(Array.from({ length: 6 }, () => call('document', 'ABC-1')))
  const refused = all.filter((r) => r.status === 'rejected')
  assert.equal(refused.length, 2)
  assert.match(refused[0].reason.message, /^jira: busy \(issue documents: 1 at a time, 3 waiting\)/)
  await h.stop()
})
