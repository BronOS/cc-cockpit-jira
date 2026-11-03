'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createClient } = require('../dist/lib/client')
const { fakeJira, picture, SITE, GATEWAY, MEDIA, EMAIL, TOKEN, fixture } = require('./fakes')

const make = (jira, tokenKind) => createClient({ site: SITE, email: EMAIL, token: TOKEN, tokenKind, fetch: jira.fetch })

test('classic token: requests go to the site; the gateway is never asked', async () => {
  const jira = fakeJira()
  const c = make(jira)
  const me = await c.myself()
  assert.equal(me.displayName, 'Oleg Example')
  assert.equal(c.mode(), 'classic')
  assert.ok(jira.calls.every((x) => x.url.startsWith(SITE + '/rest/')))
})

test('scoped token, auto: the site says 401, the cloudId is read without the token, the gateway answers', async () => {
  const jira = fakeJira({ scoped: true })
  const c = make(jira)
  const me = await c.myself()
  assert.equal(me.accountId, fixture('myself.json').accountId)
  assert.equal(c.mode(), 'scoped')
  const tenant = jira.calls.find((x) => x.url.endsWith('/_edge/tenant_info'))
  assert.equal(tenant.auth, undefined, 'no token on tenant_info')
  const gw = jira.calls.filter((x) => x.url.startsWith(GATEWAY))
  assert.equal(gw.length, 1)
  assert.match(gw[0].url, /^https:\/\/api\.atlassian\.com\/ex\/jira\/9f1c2d3e-4b5a-6789-abcd-ef0123456789\/rest\/api\/3\/myself$/)
  // Settled: the next request goes straight to the gateway.
  jira.calls.length = 0
  await c.myself()
  assert.deepEqual(jira.calls.map((x) => new URL(x.url).origin), [GATEWAY])
})

test('tokenKind scoped skips the site; classic never tries the gateway', async () => {
  const s = fakeJira({ scoped: true })
  await make(s, 'scoped').myself()
  assert.ok(!s.calls.some((x) => x.url.startsWith(SITE + '/rest/')))
  const c = fakeJira({ scoped: true })
  await assert.rejects(make(c, 'classic').myself(), (e) => e.kind === 'auth')
  assert.ok(!c.calls.some((x) => x.url.startsWith(GATEWAY) || x.url.includes('tenant_info')))
})

test('a wrong token: 401 from both, the message says expired or wrong', async () => {
  const jira = fakeJira({ token: 'another' })
  await assert.rejects(make(jira).myself(), (e) => e.kind === 'auth' && /expired or is wrong/.test(e.message))
})

test('a cloudId that is not one is refused (it would go into a URL path)', async () => {
  const jira = fakeJira({ scoped: true, routes: (url) => (url.endsWith('/_edge/tenant_info') ? new Response('{"cloudId":"../../evil"}') : undefined) })
  await assert.rejects(make(jira).myself(), (e) => e.kind === 'auth' && /no usable cloudId/.test(e.detail))
  assert.ok(!jira.calls.some((x) => x.url.startsWith(GATEWAY)))
})

test('search pages by nextPageToken and keeps the order', async () => {
  const jira = fakeJira()
  const r = await make(jira).search('assignee = currentUser() AND statusCategory != Done ORDER BY priority ASC, updated DESC', ['summary'], 500)
  assert.deepEqual(r.issues.map((i) => i.key), ['ABC-1', 'ABC-2', 'ABC-4'])
  assert.equal(r.truncated, false)
  const pages = jira.calls.filter((x) => x.url.includes('/search/jql'))
  assert.equal(pages.length, 2)
  assert.equal(new URL(pages[1].url).searchParams.get('nextPageToken'), 'CAEaAggD')
  assert.equal(new URL(pages[0].url).searchParams.get('fields'), 'summary')
})

test('search stops at the cap and says it was cut', async () => {
  const jira = fakeJira()
  const r = await make(jira).search('assignee = currentUser() AND statusCategory != Done', ['summary'], 2)
  assert.deepEqual(r.issues.map((i) => i.key), ['ABC-1', 'ABC-2'])
  assert.equal(r.truncated, true)
  assert.equal(new URL(jira.calls[0].url).searchParams.get('maxResults'), '2')
})

test('search ends on a page with a token but no issues (no endless loop)', async () => {
  let n = 0
  const jira = fakeJira({ routes: (url) => (url.includes('/search/jql') ? (n++, new Response(JSON.stringify({ issues: [], nextPageToken: 'again' }))) : undefined) })
  const r = await make(jira).search('x', ['summary'], 500)
  assert.equal(r.issues.length, 0)
  assert.equal(n, 1)
})

test('issue pages comments and the changelog past the first page', async () => {
  const raw = fixture('issue-ABC-1.json')
  raw.fields.comment = { comments: raw.fields.comment.comments.slice(0, 1), total: 2, maxResults: 1, startAt: 0 }
  raw.changelog = { histories: raw.changelog.histories.slice(0, 1), total: 2, maxResults: 1, startAt: 0 }
  const full = fixture('issue-ABC-1.json')
  const jira = fakeJira({
    issues: { 'ABC-1': raw },
    routes: (url) => {
      const u = new URL(url)
      if (u.pathname.endsWith('/issue/ABC-1/comment')) {
        assert.equal(u.searchParams.get('startAt'), '1')
        return new Response(JSON.stringify({ comments: full.fields.comment.comments.slice(1), total: 2, startAt: 1 }))
      }
      if (u.pathname.endsWith('/issue/ABC-1/changelog')) return new Response(JSON.stringify({ values: full.changelog.histories.slice(1), total: 2, isLast: true }))
      return undefined
    },
  })
  const got = await make(jira).issue('ABC-1')
  assert.deepEqual(got.fields.comment.comments.map((c) => c.id), ['100', '101'])
  assert.deepEqual(got.changelog.histories.map((h) => h.id), ['500', '501'])
  const first = new URL(jira.calls.find((x) => x.url.includes('/issue/ABC-1?')).url)
  assert.equal(first.searchParams.get('expand'), 'changelog')
  assert.match(first.searchParams.get('fields'), /description/)
})

test('attachment: the site redirects to the media host, which gets the signed address without the token', async () => {
  const bytes = picture('png', 500)
  const jira = fakeJira({ attachments: { 10001: bytes } })
  const c = make(jira)
  const got = await c.attachment('10001', { maxBytes: 1000 })
  assert.deepEqual(got, bytes)
  const [first, second] = jira.calls.filter((x) => x.url.includes('attachment') || x.url.startsWith(MEDIA))
  assert.equal(first.url, `${SITE}/rest/api/3/attachment/content/10001`)
  assert.ok(first.auth, 'the site gets the token')
  assert.equal(first.redirect, 'manual')
  assert.ok(second.url.startsWith(`${MEDIA}/file/f-10001/binary?token=signed`))
  assert.equal(second.auth, undefined, 'the media host never sees the token')
})

test('attachment: a scoped token downloads through the gateway, still without the token at the media host', async () => {
  const jira = fakeJira({ scoped: true, attachments: { 7: picture('jpeg', 100) } })
  const c = make(jira, 'scoped')
  await c.attachment('7', { maxBytes: 1000 })
  const urls = jira.calls.map((x) => [x.url.split('?')[0], Boolean(x.auth)])
  assert.deepEqual(urls.slice(-2), [
    [`${GATEWAY}/ex/jira/9f1c2d3e-4b5a-6789-abcd-ef0123456789/rest/api/3/attachment/content/7`, true],
    [`${MEDIA}/file/f-7/binary`, false],
  ])
})

test('attachment: over the byte limit, a redirect to plain http, a bad id, a 404', async () => {
  const jira = fakeJira({ attachments: { 1: picture('png', 2000) } })
  const c = make(jira)
  await assert.rejects(c.attachment('1', { maxBytes: 1000 }), (e) => e.kind === 'toolarge')
  await assert.rejects(c.attachment('../../myself', { maxBytes: 1000 }), (e) => e.kind === 'unsafe')
  await assert.rejects(c.attachment('99', { maxBytes: 1000 }), (e) => e.kind === 'notfound')
  const http = fakeJira({
    routes: (url) => (url.includes('/attachment/content/') ? new Response(null, { status: 302, headers: { location: 'http://media.example/x' } }) : undefined),
  })
  const c2 = make(http)
  await assert.rejects(c2.attachment('1', { maxBytes: 1000 }), (e) => e.kind === 'unsafe')
  assert.ok(!http.calls.some((x) => x.url.startsWith('http://')), 'the http hop is never made')
  // A declared Content-Length over the limit is refused before the body is read.
  const declared = fakeJira({
    routes: (url) => (url.includes('/attachment/content/') ? new Response(picture('png', 50), { status: 200, headers: { 'content-length': '999999' } }) : undefined),
  })
  await assert.rejects(make(declared).attachment('1', { maxBytes: 1000 }), /over 1000 bytes/)
})
