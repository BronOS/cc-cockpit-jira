'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { readSettings, checkSite, missingText, mailSendersOf } = require('../dist/lib/settings')

test('nothing set: site, email and token are missing, the plugin is not ready', () => {
  const r = readSettings({})
  assert.deepEqual(r.missing, ['site', 'email', 'apiToken'])
  assert.equal(r.ready, false)
  const text = missingText(r.missing).join('\n')
  assert.match(text, /site is not set: ccc plugin config bronos\.jira site=https:\/\/<name>\.atlassian\.net/)
  assert.match(text, /API token is not set: a person enters it in Settings > This project/)
})

test('a complete configuration with defaults', () => {
  const r = readSettings({ site: 'https://acme.atlassian.net/', email: ' me@example.com ', apiToken: 't' })
  assert.equal(r.ready, true)
  assert.equal(r.cfg.site, 'https://acme.atlassian.net')
  assert.equal(r.cfg.email, 'me@example.com')
  assert.deepEqual(r.cfg.lanes, { backlog: true, inProgress: true, mentioned: true, onHold: false, done: false })
  assert.equal(r.cfg.doneDays, 14)
  assert.equal(r.cfg.mentionDays, 7)
  assert.equal(r.cfg.pollMinutes, 3)
  assert.equal(r.cfg.rowsPerLane, 10)
  assert.equal(r.cfg.tokenKind, 'auto')
  assert.equal(r.cfg.triageText, 'full')
})

test('the site: https only, no path, no user info, a real URL', () => {
  assert.match(checkSite('http://acme.atlassian.net').problem, /only https/)
  assert.match(checkSite('https://acme.atlassian.net/jira/software').problem, /no path/)
  assert.match(checkSite('https://a:b@acme.atlassian.net').problem, /no user or password/)
  assert.match(checkSite('acme').problem, /not an address/)
  assert.equal(checkSite('https://ACME.atlassian.net').site, 'https://acme.atlassian.net')
  assert.equal(readSettings({ site: 'http://acme.atlassian.net', email: 'a@b', apiToken: 't' }).ready, false)
})

test('a bad email stops the plugin; a bad project key is skipped and reported', () => {
  assert.equal(readSettings({ site: 'https://a.atlassian.net', email: 'nope', apiToken: 't' }).ready, false)
  const r = readSettings({ site: 'https://a.atlassian.net', email: 'a@b.c', apiToken: 't', mentionProjects: ['abc', 'A B', 'abc'] })
  assert.equal(r.ready, true)
  assert.deepEqual(r.cfg.mentionProjects, ['ABC'])
  assert.match(r.problems[0], /"A B" is not a project key/)
})

test('lanes: a partial object keeps the other defaults; onHoldStatuses lower-cased; numbers clamped', () => {
  const r = readSettings({ lanes: { done: true, backlog: false }, onHoldStatuses: [' Waiting ', 'BLOCKED', '', 5], doneDays: 0, mentionDays: 500, pollMinutes: 0.5, tokenKind: 'weird', triageText: 'summary' })
  assert.deepEqual(r.cfg.lanes, { backlog: false, inProgress: true, mentioned: true, onHold: false, done: true })
  assert.deepEqual([...r.cfg.onHold], ['waiting', 'blocked'])
  assert.equal(r.cfg.doneDays, 1)
  assert.equal(r.cfg.mentionDays, 90)
  assert.equal(r.cfg.pollMinutes, 1)
  assert.equal(r.cfg.tokenKind, 'auto')
  assert.equal(r.cfg.triageText, 'summary')
})

test('the manifest schema follows the app\'s rules: no regex, a top-level secret with no default', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'))
  const schema = manifest.contributes.settings.project
  const text = JSON.stringify(schema)
  for (const k of ['pattern', 'patternProperties', '$ref', '$anchor', '$id']) assert.ok(!text.includes(`"${k}"`), k)
  const token = schema.properties.apiToken
  assert.equal(token.format, 'secret')
  assert.equal(token.type, 'string')
  assert.ok(!('default' in token))
  assert.deepEqual(Object.keys(token).sort(), ['description', 'format', 'title', 'type'])
  for (const [k, p] of Object.entries(schema.properties)) if (p.oneOf) assert.ok('default' in p, `${k} has a default`)
  assert.deepEqual(manifest.services, { provides: { jira: 1 }, uses: { triage: 1, reviewer: 1 } })
  assert.ok(!manifest.contributes.cli[0].stdin, 'no stdin: it would apply to every subcommand')
})

test('mailSenders: the setting, else jira@<site host>; bad addresses are skipped with a problem', () => {
  const base = { site: 'https://acme.atlassian.net', email: 'me@example.com', apiToken: 't' }
  assert.deepEqual(mailSendersOf(readSettings(base).cfg), ['jira@acme.atlassian.net'])
  const r = readSettings({ ...base, mailSenders: [' Jira@Example.COM ', 'not an address', 'jira@example.com', ''] })
  assert.deepEqual(mailSendersOf(r.cfg), ['jira@example.com'])
  assert.equal(r.ready, true, 'a bad sender does not stop the plugin')
  assert.ok(r.problems.some((p) => p.startsWith('mailSenders:')))
  assert.deepEqual(mailSendersOf(readSettings({}).cfg), [])
})
