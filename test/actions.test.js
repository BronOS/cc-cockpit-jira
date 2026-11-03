'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { pickTab, openerArgv, isMissingAnnotate } = require('../dist/lib/actions')

const tab = (tabId, status, extra = {}) => ({ tabId, status, cwd: '/p/proj', notes: [], files: [], ...extra })

test('Discuss goes to the active tab when the app says which one it is (0.8.0)', () => {
  assert.deepEqual(pickTab([tab('a', 'waiting'), tab('b', 'working', { active: true, title: 'Fix login' })]), { tabId: 'b', label: 'Fix login' })
})

test('without active: the only live tab; ended tabs do not count', () => {
  assert.deepEqual(pickTab([tab('a', 'ended'), tab('b', 'waiting')]), { tabId: 'b', label: 'proj' })
})

test('several live tabs and none active: the person picks', () => {
  const r = pickTab([tab('a', 'waiting', { title: 'One' }), tab('b', 'working')])
  assert.deepEqual(r.choose.map((t) => [t.tabId, t.label]), [['a', 'One'], ['b', 'proj']])
})

test('no tab: an error that points to New session; a picked tab that is gone too', () => {
  assert.match(pickTab([]).error, /New session/)
  assert.match(pickTab([tab('a', 'ended')]).error, /New session/)
  assert.match(pickTab([tab('a', 'waiting')], 'zzz').error, /gone/)
  assert.deepEqual(pickTab([tab('a', 'waiting'), tab('b', 'waiting')], 'b'), { tabId: 'b', label: 'proj' })
})

test('the browser opener: one argv entry for the URL, https only, none on Windows', () => {
  assert.deepEqual(openerArgv('linux', 'https://a.atlassian.net/browse/A-1'), ['xdg-open', 'https://a.atlassian.net/browse/A-1'])
  assert.deepEqual(openerArgv('darwin', 'https://a.atlassian.net/browse/A-1'), ['open', 'https://a.atlassian.net/browse/A-1'])
  assert.equal(openerArgv('win32', 'https://a.atlassian.net/browse/A-1'), null)
  assert.equal(openerArgv('linux', '--help'), null)
  assert.equal(openerArgv('linux', 'file:///etc/passwd'), null)
})

test('a reviewer without annotate is told apart from a real failure', () => {
  assert.equal(isMissingAnnotate(new Error('service "reviewer" (plugin cockpit.reviewer) has no method "annotate"')), true)
  assert.equal(isMissingAnnotate(new Error('annotate: text too long')), false)
  assert.equal(isMissingAnnotate(undefined), false)
})
