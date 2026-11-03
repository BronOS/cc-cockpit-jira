'use strict'
// Token-to-host safety: the token goes only to the site or the gateway over https, never on a
// redirect to another host, never over plain http.
const test = require('node:test')
const assert = require('node:assert/strict')
const { guardedGet, readJson, basicAuth, httpsOrigin, JiraError } = require('../dist/lib/http')

const SITE = 'https://acme.atlassian.net'
const AUTH = basicAuth('me@example.com', 'secret-token')

function recorder(answers) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, redirect: init.redirect })
    const a = answers.shift()
    return typeof a === 'function' ? a(url) : a
  }
  return { fetch, calls }
}
const redirect = (location, status = 302) => new Response(null, { status, headers: { location } })

test('basicAuth is Basic base64(email:token)', () => {
  assert.equal(AUTH, 'Basic ' + Buffer.from('me@example.com:secret-token').toString('base64'))
})

test('httpsOrigin: https only, no user info', () => {
  assert.equal(httpsOrigin('https://acme.atlassian.net/rest/api/3/x?y=1'), SITE)
  assert.equal(httpsOrigin('http://acme.atlassian.net/'), null)
  assert.equal(httpsOrigin('https://u:p@acme.atlassian.net/'), null)
  assert.equal(httpsOrigin('not a url'), null)
})

test('the token goes to a trusted https origin, with redirects handled by hand', async () => {
  const r = recorder([new Response('{}', { status: 200 })])
  await guardedGet(`${SITE}/rest/api/3/myself`, { auth: AUTH, trusted: new Set([SITE]), fetch: r.fetch })
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].auth, AUTH)
  assert.equal(r.calls[0].redirect, 'manual')
})

test('refused before sending: another host, plain http, a look-alike host', async () => {
  for (const url of ['https://evil.example.com/rest/api/3/myself', 'http://acme.atlassian.net/rest/api/3/myself', 'https://acme.atlassian.net.evil.com/x', 'https://acme.atlassian.net:8443/x']) {
    const r = recorder([])
    await assert.rejects(guardedGet(url, { auth: AUTH, trusted: new Set([SITE]), fetch: r.fetch }), (e) => e instanceof JiraError && e.kind === 'unsafe')
    assert.equal(r.calls.length, 0, url)
  }
})

test('a redirect to another host is followed without the token', async () => {
  const r = recorder([redirect('https://api.media.atlassian.com/file/1?token=signed'), new Response('ok', { status: 200 })])
  const res = await guardedGet(`${SITE}/rest/api/3/attachment/content/1`, { auth: AUTH, trusted: new Set([SITE]), fetch: r.fetch })
  assert.equal(res.status, 200)
  assert.equal(r.calls[0].auth, AUTH)
  assert.equal(r.calls[1].url, 'https://api.media.atlassian.com/file/1?token=signed')
  assert.equal(r.calls[1].auth, undefined)
})

test('once stripped, the token stays off even when a later hop comes back to the site', async () => {
  const r = recorder([redirect('https://cdn.example.com/a'), redirect(`${SITE}/b`), new Response('ok')])
  await guardedGet(`${SITE}/x`, { auth: AUTH, trusted: new Set([SITE]), fetch: r.fetch })
  assert.deepEqual(r.calls.map((c) => c.auth), [AUTH, undefined, undefined])
})

test('a same-origin redirect keeps the token; a relative Location resolves against the site', async () => {
  const r = recorder([redirect('/rest/api/3/myself?moved=1', 301), new Response('{}')])
  await guardedGet(`${SITE}/rest/api/2/myself`, { auth: AUTH, trusted: new Set([SITE]), fetch: r.fetch })
  assert.equal(r.calls[1].url, `${SITE}/rest/api/3/myself?moved=1`)
  assert.equal(r.calls[1].auth, AUTH)
})

test('a redirect to plain http is not followed at all', async () => {
  const r = recorder([redirect('http://acme.atlassian.net/x')])
  await assert.rejects(guardedGet(`${SITE}/x`, { auth: AUTH, trusted: new Set([SITE]), fetch: r.fetch }), (e) => e.kind === 'unsafe')
  assert.equal(r.calls.length, 1)
})

test('too many redirects end the request', async () => {
  const r = recorder([redirect(`${SITE}/1`), redirect(`${SITE}/2`), redirect(`${SITE}/3`), redirect(`${SITE}/4`)])
  await assert.rejects(guardedGet(`${SITE}/0`, { auth: AUTH, trusted: new Set([SITE]), fetch: r.fetch }), /too many redirects/)
  assert.equal(r.calls.length, 4)
})

test('a network failure is a JiraError naming the host, not the path', async () => {
  const fetch = async () => {
    throw new TypeError('fetch failed')
  }
  await assert.rejects(guardedGet(`${SITE}/rest/api/3/issue/SECRET-1`, { auth: AUTH, trusted: new Set([SITE]), fetch }), (e) => e.kind === 'network' && e.message.includes(SITE) && !e.message.includes('SECRET'))
})

test('readJson: 401 says the token expired or is wrong and where to make a new one', async () => {
  await assert.rejects(readJson(new Response('{"errorMessages":["Client must be authenticated"]}', { status: 401 }), 'myself'), (e) => e.kind === 'auth' && /expired or is wrong/.test(e.message) && /id\.atlassian\.com > Security > API tokens/.test(e.message))
})

test('readJson: 403 names the read-only scopes; 429 is rate; other statuses carry Jira\'s message', async () => {
  await assert.rejects(readJson(new Response('{"errorMessages":["Unauthorized; scope does not match"]}', { status: 403 }), 'search'), (e) => e.kind === 'forbidden' && /read:jira-work and read:jira-user/.test(e.message) && /scope does not match/.test(e.message))
  await assert.rejects(readJson(new Response('', { status: 429, headers: { 'retry-after': '30' } }), 'search'), (e) => e.kind === 'rate' && e.retryAfter === 30)
  await assert.rejects(readJson(new Response('{"errorMessages":["The value \'X\' does not exist for the field \'project\'."]}', { status: 400 }), 'search'), (e) => e.kind === 'http' && /does not exist/.test(e.message))
  await assert.rejects(readJson(new Response('<html>proxy</html>', { status: 502 }), 'search'), (e) => e.message === 'search: Jira answered 502')
  await assert.rejects(readJson(new Response('not json', { status: 200 }), 'x'), (e) => e.kind === 'json')
})
