'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { poll, buildView, emptyCache, allRows } = require('../dist/lib/poll')
const { createClient } = require('../dist/lib/client')
const { readSettings } = require('../dist/lib/settings')
const { emptySeen, seed } = require('../dist/lib/seen')
const { fakeJira, SITE, EMAIL, TOKEN, ME, NOW, CONFIGURED } = require('./fakes')

function setup(project = {}, jiraOpts = {}) {
  const jira = fakeJira(jiraOpts)
  const cfg = readSettings({ ...CONFIGURED, ...project }).cfg
  const client = createClient({ site: SITE, email: EMAIL, token: TOKEN, fetch: jira.fetch })
  return { jira, cfg, client, cache: emptyCache(SITE, EMAIL) }
}
const issueReads = (jira) => jira.calls.filter((c) => /\/rest\/api\/3\/issue\/[A-Z]/.test(c.url)).map((c) => new URL(c.url).pathname.split('/').pop())

test('default lanes: assigned (two pages) and Mentioned; Done and On hold not fetched', async () => {
  const { jira, cfg, client, cache } = setup()
  const r = await poll({ client, cfg, cache, now: NOW })
  assert.deepEqual(r.lists.assigned.map((h) => h.key), ['ABC-1', 'ABC-2', 'ABC-4'])
  assert.deepEqual(r.lists.done, [])
  assert.deepEqual(r.lists.candidates.map((h) => h.key), ['XYZ-9', 'ABC-7'])
  assert.ok(!jira.calls.some((c) => c.url.includes('statusCategory+%3D+Done') || decodeURIComponent(c.url).includes('statusCategory = Done')))
  // The mentioned search names the projects of the assigned issues.
  const ms = jira.calls.map((c) => new URL(c.url)).find((u) => (u.searchParams.get('jql') || '').startsWith('project in'))
  assert.match(ms.searchParams.get('jql'), /^project in \("ABC"\) AND updated >= -7d/)
  assert.deepEqual(issueReads(jira).sort(), ['ABC-1', 'ABC-2', 'ABC-4', 'ABC-7', 'XYZ-9'])
  assert.equal(r.stats.deferred, 0)
})

test('the view: lanes, Mentioned only with a mention of the person, unread before seeding', async () => {
  const { cfg, client, cache } = setup()
  const r = await poll({ client, cfg, cache, now: NOW })
  const seen = emptySeen(SITE, ME)
  const view = buildView({ cfg, lists: r.lists, cache, seen, now: NOW })
  const lane = (id) => view.lanes.find((l) => l.id === id)
  assert.deepEqual(view.lanes.map((l) => l.id), ['backlog', 'inProgress', 'mentioned'])
  assert.deepEqual(lane('backlog').rows.map((x) => x.issue.key), ['ABC-2'])
  // ABC-4 (Waiting) is In progress while onHoldStatuses is empty; ABC-1 is newer.
  assert.deepEqual(lane('inProgress').rows.map((x) => x.issue.key), ['ABC-1', 'ABC-4'])
  assert.deepEqual(lane('mentioned').rows.map((x) => x.issue.key), ['XYZ-9'], 'ABC-7 has no mention of the person')
  seed(seen, allRows(view).map((x) => ({ issue: x.issue, lane: x.lane })), true)
  const after = buildView({ cfg, lists: r.lists, cache, seen, now: NOW })
  assert.equal(after.unread, 0, 'the first run marks everything seen')
})

test('a mention older than mentionDays keeps the issue out of Mentioned', async () => {
  const { cfg, client, cache } = setup({ mentionDays: 1 })
  const r = await poll({ client, cfg, cache, now: Date.parse('2026-11-05T12:00:00Z') })
  const view = buildView({ cfg, lists: r.lists, cache, seen: emptySeen(SITE, ME), now: Date.parse('2026-11-05T12:00:00Z') })
  assert.deepEqual(view.lanes.find((l) => l.id === 'mentioned').rows, [])
})

test('onHoldStatuses move an issue to On hold; a hidden lane is never read in full', async () => {
  const { jira, cfg, client, cache } = setup({ onHoldStatuses: ['waiting'], lanes: { onHold: false, mentioned: false } })
  const r = await poll({ client, cfg, cache, now: NOW })
  assert.deepEqual(r.lists.assigned.map((h) => h.key), ['ABC-1', 'ABC-2'])
  assert.deepEqual(issueReads(jira).sort(), ['ABC-1', 'ABC-2'])
  assert.ok(!jira.calls.some((c) => (new URL(c.url).searchParams.get('jql') || '').startsWith('project in')))
  const { cfg: cfg2, client: c2, cache: k2, jira: j2 } = setup({ onHoldStatuses: ['Waiting'], lanes: { onHold: true, backlog: false, inProgress: false, mentioned: false } })
  const r2 = await poll({ client: c2, cfg: cfg2, cache: k2, now: NOW })
  assert.deepEqual(r2.lists.assigned.map((h) => h.key), ['ABC-4'])
  assert.deepEqual(issueReads(j2), ['ABC-4'])
  assert.deepEqual(buildView({ cfg: cfg2, lists: r2.lists, cache: k2, seen: emptySeen(SITE, ME), now: NOW }).lanes.map((l) => [l.id, l.rows.length]), [['onHold', 1]])
})

test('with only Mentioned and Done on, the assigned search still runs for the projects but nothing assigned is read', async () => {
  const { jira, cfg, client, cache } = setup({ lanes: { backlog: false, inProgress: false, mentioned: true, done: true } })
  const r = await poll({ client, cfg, cache, now: NOW })
  assert.deepEqual(r.lists.assigned, [])
  assert.deepEqual(r.lists.done.map((h) => h.key), ['ABC-3'])
  assert.deepEqual(issueReads(jira).sort(), ['ABC-7', 'XYZ-9'])
})

test('mentionProjects replaces the assigned projects and skips the assigned search when no status lane is on', async () => {
  const { jira, cfg, client, cache } = setup({ mentionProjects: ['xyz'], lanes: { backlog: false, inProgress: false } })
  await poll({ client, cfg, cache, now: NOW })
  const jqls = jira.calls.map((c) => new URL(c.url).searchParams.get('jql')).filter(Boolean)
  assert.equal(jqls.length, 1)
  assert.match(jqls[0], /^project in \("XYZ"\)/)
})

test('a second poll reads only what changed', async () => {
  const { jira, cfg, client, cache } = setup()
  await poll({ client, cfg, cache, now: NOW })
  jira.calls.length = 0
  await poll({ client, cfg, cache, now: NOW })
  assert.deepEqual(issueReads(jira), [])
  assert.ok(!jira.calls.some((c) => c.url.endsWith('/myself')), 'myself once')
  cache.issues['ABC-2'].updated = 'older'
  jira.calls.length = 0
  await poll({ client, cfg, cache, now: NOW })
  assert.deepEqual(issueReads(jira), ['ABC-2'])
})

test('the budget defers reads to later polls; one failing issue does not fail the poll', async () => {
  const { cfg, client, cache } = setup({}, { fail: { 'ABC-2': 500 } })
  const r = await poll({ client, cfg, cache, now: NOW, budget: 2 })
  assert.equal(r.stats.deferred, 3)
  assert.equal(r.stats.issueErrors.length, 1)
  assert.equal(r.stats.issueErrors[0].key, 'ABC-2')
  assert.match(r.stats.issueErrors[0].message, /500/)
  assert.ok(cache.issues['ABC-1'])
  const r2 = await poll({ client, cfg, cache, now: NOW, budget: 10 })
  assert.equal(r2.stats.deferred, 0)
  assert.ok(cache.issues['XYZ-9'])
})

test('a failed Done search keeps the last Done list; a 401 fails the whole poll', async () => {
  const { cfg, client, cache } = setup({ lanes: { done: true } }, { failDone: true })
  const prev = { done: [{ key: 'ABC-3', summary: 'old', category: 'done', status: 'Done' }] }
  const r = await poll({ client, cfg, cache, now: NOW, prev })
  assert.match(r.laneErrors.done, /500/)
  assert.deepEqual(r.lists.done.map((h) => h.key), ['ABC-3'])
  const bad = setup({}, { token: 'another' })
  await assert.rejects(poll({ client: bad.client, cfg: bad.cfg, cache: bad.cache, now: NOW }), (e) => e.kind === 'auth')
})

test('the cache drops issues no list names any more', async () => {
  const { cfg, client, cache } = setup()
  cache.me = { accountId: ME, displayName: 'x' }
  cache.issues['OLD-1'] = { key: 'OLD-1', full: true, updated: 'x', updatedAt: 1, events: [] }
  await poll({ client, cfg, cache, now: NOW })
  assert.equal('OLD-1' in cache.issues, false)
})
