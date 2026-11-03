'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { runCli } = require('../dist/lib/cli')

const notReady = { ready: false, missing: ['site', 'email', 'apiToken'], problems: [], site: '', email: '', tokenSet: false }
const deps = (st, more = {}) => ({ status: () => st, refresh: async () => ({}), view: () => ({ lanes: [] }), show: async (k) => `text of ${k}`, read: async () => {}, unread: async () => {}, ...more })

test('help, also as --help after a subcommand', async () => {
  for (const argv of [[], ['help'], ['show', '--help']]) {
    const r = await runCli(argv, deps(notReady))
    assert.equal(r.code, 0)
    assert.match(r.stdout, /ccc jira status/)
  }
})

test('status without configuration says clearly what is missing and where to set it', async () => {
  const r = await runCli(['status'], deps(notReady))
  assert.equal(r.code, 0)
  assert.match(r.stdout, /Not configured:/)
  assert.match(r.stdout, /site is not set/)
  assert.match(r.stdout, /email is not set/)
  assert.match(r.stdout, /API token is not set: a person enters it in Settings > This project/)
  assert.match(r.stdout, /token +not set/)
})

test('refresh, list, show refuse while not configured', async () => {
  for (const argv of [['refresh'], ['list'], ['show', 'ABC-1'], ['read', 'ABC-1']]) {
    const r = await runCli(argv, deps(notReady))
    assert.equal(r.code, 1, argv.join(' '))
    assert.match(r.stderr, /not configured/)
  }
})

const ready = {
  ready: true, missing: [], problems: [], site: 'https://acme.atlassian.net', email: 'me@example.com', tokenSet: true, mode: 'scoped',
  account: { accountId: 'abc', displayName: 'Oleg' }, lastPoll: Date.parse('2026-11-02T11:57:00Z'), pollMinutes: 3,
  counts: [{ title: 'Backlog', total: 2, unread: 1 }, { title: 'In progress', total: 1, unread: 0 }],
  triage: 'on (bronos.jev-triage)', annotate: 'plain reader', deferred: 0, error: null, laneErrors: { mentioned: 'boom' }, issueErrors: [],
}

test('status when configured: site and token kind, account, counts, triage, errors', async () => {
  const r = await runCli(['status'], deps(ready))
  assert.match(r.stdout, /site +https:\/\/acme\.atlassian\.net \(scoped token\)/)
  assert.match(r.stdout, /account +Oleg \(abc\)/)
  assert.match(r.stdout, /lanes +Backlog 2 \(1 unread\) · In progress 1/)
  assert.match(r.stdout, /triage +on/)
  assert.match(r.stdout, /error +mentioned: boom/)
})

test('keys are checked before anything runs', async () => {
  let asked = 0
  const d = deps(ready, { show: async () => (asked++, 'x') })
  for (const bad of ['abc', '../x', 'ABC-0', 'ABC-1; rm']) {
    const r = await runCli(['show', bad], d)
    assert.equal(r.code, 2, bad)
  }
  assert.equal(asked, 0)
  const ok = await runCli(['show', 'abc-12'], d)
  assert.equal(ok.stdout, 'x\n')
})

test('list prints lanes with unread and triage marks; an unknown lane is a usage error', async () => {
  const view = { lanes: [{ id: 'mentioned', title: 'Mentioned', rows: [{ lane: 'mentioned', unread: true, verdict: { priority: 'action' }, mentionedBy: 'Bob', issue: { key: 'XYZ-9', status: 'In Review', summary: 'Release notes' } }] }] }
  const r = await runCli(['list'], deps(ready, { view: () => view }))
  assert.match(r.stdout, /Mentioned \(1\)\n  \* A XYZ-9 +In Review +Release notes  \(mentioned by Bob\)/)
  assert.equal((await runCli(['list', 'nope'], deps(ready))).code, 2)
  assert.match((await runCli(['list', 'done'], deps(ready, { view: () => view }))).stdout, /Done: this lane is off/)
})

test('refresh reports a failure, and a poll still running', async () => {
  assert.match((await runCli(['refresh'], deps(ready, { refresh: async () => ({ error: '401' }) }))).stderr, /refresh failed: 401/)
  assert.match((await runCli(['refresh'], deps(ready, { refresh: async () => ({ pending: true }) }))).stdout, /still polling/)
})

test('read and unread errors come back as exit 1', async () => {
  const r = await runCli(['unread', 'ABC-2'], deps(ready, { unread: async () => { throw new Error('ABC-2: nothing from others on this issue to mark unread') } }))
  assert.equal(r.code, 1)
  assert.match(r.stderr, /nothing from others/)
})
