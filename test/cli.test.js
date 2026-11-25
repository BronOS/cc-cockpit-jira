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
  assert.match((await runCli(['status'], deps({ ...ready, writes: 'draft' }))).stdout, /writes +draft: ccc jira update opens the reply page; the person posts it/)
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

const writeDeps = (writes, more = {}) => {
  const calls = []
  return { calls, d: deps(ready, { writes: () => writes, update: async (key, o) => (calls.push({ key, ...o, signal: undefined }), { code: 0, text: `Draft opened for ${key}: the person posts it.` }), ...more }) }
}

test('update: parsing; the comment only from stdin with -; a status by name; usage errors are exit 2', async () => {
  const { parseUpdate } = require('../dist/lib/cli')
  assert.deepEqual(parseUpdate(['ABC-1', '--status', 'In Progress', '-']), { key: 'ABC-1', status: 'In Progress', dash: true })
  assert.deepEqual(parseUpdate(['--status=Done', 'abc-2']), { key: 'abc-2', status: 'Done', dash: false })
  for (const bad of [[], ['ABC-1', '--status'], ['ABC-1', '--status', ' '], ['ABC-1', '--force'], ['ABC-1', 'ABC-2']]) assert.ok(parseUpdate(bad).usage, bad.join(' '))
  const { calls, d } = writeDeps('draft')
  const r = await runCli(['update', 'abc-1', '--status', 'Done', '-'], d, { stdin: 'Fixed in 1.2\n', tabId: 't1' })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /Draft opened for ABC-1/)
  assert.deepEqual(calls, [{ key: 'ABC-1', comment: 'Fixed in 1.2\n', status: 'Done', mode: 'draft', tabId: 't1', signal: undefined }])
  // stdin without `-` is not the comment; neither given is a usage error.
  const none = await runCli(['update', 'ABC-1'], d, { stdin: 'ignored' })
  assert.equal(none.code, 2)
  assert.equal((await runCli(['update', 'ABC-1', '-'], d, { stdin: '  \n' })).code, 2, 'an empty stdin is no comment')
  assert.equal((await runCli(['update', 'ABC/1', '-'], d, { stdin: 'x' })).code, 2)
  assert.equal(calls.length, 1)
})

test('update: off is refused (exit 1) before anything; a comment over the limit too; not configured too', async () => {
  const { calls, d } = writeDeps('off')
  const r = await runCli(['update', 'ABC-1', '-'], d, { stdin: 'hello' })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /writing is off for this project \(setting: What ccc jira update does\)/)
  const long = writeDeps('direct')
  const r2 = await runCli(['update', 'ABC-1', '-'], long.d, { stdin: 'x'.repeat(32001) })
  assert.equal(r2.code, 1)
  assert.match(r2.stderr, /at most 32,000; nothing was written/)
  assert.equal(calls.length + long.calls.length, 0)
  assert.equal((await runCli(['update', 'ABC-1', '--status', 'Done'], deps(notReady, { writes: () => 'draft' }))).code, 1)
})

test('update: the host\'s answer and exit code pass through; help says the person decides in draft mode', async () => {
  const { d } = writeDeps('direct', { update: async () => ({ code: 1, text: 'ABC-1: comment posted\nABC-1: not moved to Done: 400' }) })
  const r = await runCli(['update', 'ABC-1', '--status', 'Done', '-'], d, { stdin: 'hi' })
  assert.equal(r.code, 1)
  assert.equal(r.stderr, 'ABC-1: comment posted\nABC-1: not moved to Done: 400\n')
  const help = (await runCli(['help'], deps(ready))).stdout
  assert.match(help, /ccc jira update <KEY> \[--status <name>\] \[-\]/)
  assert.match(help, /writes NOTHING: the person reads it/)
  assert.match(help, /do not run the command again to make it happen/)
  assert.match(help, /direct +writes: the comment first, then the move/)
})
