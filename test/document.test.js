'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { issueDetails, issueDocument, attachmentUrl, fmtSize, HTML_MAX_BYTES, statusTone, priorityTone } = require('../dist/lib/document')
const { compact } = require('../dist/lib/model')
const { fixture, ME, SITE } = require('./fakes')

/** ABC-1 with attachments, and an image referenced in the newest comment by its file name. */
function withAttachments() {
  const raw = fixture('issue-ABC-1.json')
  raw.fields.attachment = [
    { id: '10001', filename: 'shot.png', mimeType: 'image/png', size: 2048, created: '2026-11-01T10:14:00.000+0100', author: { displayName: 'Ann Smith' } },
    { id: '10002', filename: 'trace.log', mimeType: 'text/plain', size: 5 * 1024 * 1024, created: '2026-10-30T09:00:00.000+0100', author: { displayName: 'Ann Smith' } },
    { id: '10003', filename: 'old.jpg', mimeType: 'image/jpeg', size: 4096, created: '2026-10-29T09:00:00.000+0100', author: { displayName: 'Oleg Example' } },
    { id: 'x/../1', filename: 'bad id.png', mimeType: 'image/png', size: 1 },
  ]
  raw.fields.comment.comments[1].body.content.push({ type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'uuid', type: 'file', alt: 'shot.png' } }] })
  return raw
}

test('the header card: key and summary as h1, then status, priority and assignee as facts, then the rest', () => {
  const raw = fixture('issue-ABC-1.json')
  const { html } = issueDocument({ issue: compact(raw, ME, 'full'), raw, site: SITE })
  assert.match(html, /^<div class="card"><h1>ABC-1: Checkout fails for EU cards<\/h1>\n<dl class="facts"><dt>Status<\/dt><dd><span class="lozenge lozenge-info">In Progress<\/span><\/dd><dt>Priority<\/dt><dd><span class="lozenge lozenge-warning">High<\/span><\/dd><dt>Assignee<\/dt><dd><span class="person">Oleg Example<\/span><\/dd><\/dl>\n<div class="meta">Bug · Reporter: Ann Smith · Created \d{4}-\d\d-\d\d \d\d:\d\d · Updated /)
  assert.match(html, /<h2>Description<\/h2>\n<p>Customers with EU cards get <code>PAYMENT_DECLINED<\/code> at checkout.<\/p>/)
  assert.match(html, /<pre><code>\{&quot;code&quot;: 402\}<\/code><\/pre>/)
})

test('comments oldest first as cards; the ones after the seen mark by others are .new', () => {
  const raw = fixture('issue-ABC-1.json')
  const issue = compact(raw, ME, 'full')
  const { html } = issueDocument({ issue, raw, site: SITE, mark: Date.parse('2026-10-31T12:00:00Z'), lane: 'inProgress' })
  assert.match(html, /<h2>Comments \(2\)<\/h2>/)
  const cards = [...html.matchAll(/<div class="card( new)?"><div class="card-header"><strong>([^<]+)<\/strong>/g)].map((m) => [m[2], Boolean(m[1])])
  assert.deepEqual(cards, [['Oleg Example', false], ['Ann Smith', true]])
  assert.match(html, /<span class="lozenge">new<\/span>/)
  // Without a mark everything of others is new; with a mark after it nothing is.
  const later = issueDocument({ issue, raw, site: SITE, mark: Date.parse('2026-11-02T00:00:00Z'), lane: 'inProgress' }).html
  assert.ok(!later.includes('card new'))
})

test('attachments: an inlined image is "shown above", a downloaded unreferenced one shows in the list, the rest are https links', () => {
  const raw = withAttachments()
  const issue = compact(raw, ME, 'full')
  const assets = new Map([['10001', 'att10001'], ['10003', 'att10003']])
  const { html, inlined } = issueDocument({ issue, raw, site: SITE, assets })
  assert.deepEqual([...inlined], ['10001'])
  assert.match(html, /<figure><img data-asset="att10001" alt="shot.png" title="shot.png"><\/figure>/)
  const list = html.slice(html.indexOf('<h2>Attachments (3)</h2>'))
  assert.match(list, /^<h2>Attachments \(3\)<\/h2>\n<ul class="attachment-list">/)
  assert.match(list, /<li>shot\.png · 2 KB · Ann Smith \(shown above\)<\/li>/)
  assert.match(list, new RegExp(`<li><a href="${SITE}/rest/api/3/attachment/content/10002">trace\\.log</a> · 5\\.0 MB · Ann Smith</li>`))
  assert.match(list, /<li><figure><img data-asset="att10003" alt="old.jpg" title="old.jpg"><figcaption>old\.jpg · 4 KB · Oleg Example<\/figcaption><\/figure><\/li>/)
  assert.ok(!html.includes('bad id'), 'an attachment whose id is not digits is dropped')
})

test('an image that was not downloaded is a link where the text shows it and in the list', () => {
  const raw = withAttachments()
  const { html, inlined } = issueDocument({ issue: compact(raw, ME, 'full'), raw, site: SITE, assets: new Map() })
  assert.equal(inlined.size, 0)
  assert.ok(!html.includes('<img'))
  assert.match(html, new RegExp(`<p><a href="${SITE}/rest/api/3/attachment/content/10001">shot\\.png</a></p>`))
  assert.match(html, new RegExp(`<li><a href="${SITE}/rest/api/3/attachment/content/10001">shot\\.png</a>`))
})

test('the cached copy (no raw ADF): plain-text bodies, escaped, with the note on top', () => {
  const issue = compact(fixture('issue-ABC-1.json'), ME, 'full')
  issue.description = 'Text <script>x</script>'
  const { html } = issueDocument({ issue, raw: null, site: SITE, note: 'Jira could not be reached' })
  assert.match(html, /^<p><em>Jira could not be reached<\/em><\/p>/)
  assert.match(html, /<p>Text &lt;script&gt;x&lt;\/script&gt;<\/p>/)
  assert.match(html, /<h2>Comments \(2\)<\/h2>/)
})

test('text from Jira never becomes markup: a hostile summary, author and file name', () => {
  const raw = withAttachments()
  raw.fields.summary = '<img src=x onerror=alert(1)>'
  raw.fields.comment.comments[0].author.displayName = '<b>Mallory</b>'
  raw.fields.attachment[1].filename = '"><script>alert(1)</script>.txt'
  const { html } = issueDocument({ issue: compact(raw, ME, 'full'), raw, site: SITE })
  assert.ok(!html.includes('<script'))
  assert.ok(!html.includes('<img src'))
  assert.match(html, /<h1>ABC-1: &lt;img src=x onerror=alert\(1\)&gt;<\/h1>/)
  assert.match(html, /<strong>&lt;b&gt;Mallory&lt;\/b&gt;<\/strong>/)
})

test('under the 2 MiB cap: the oldest comments give way, with a line saying how many', () => {
  const raw = fixture('issue-ABC-1.json')
  const big = (n) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: `comment ${n} ` + 'x'.repeat(300000) }] }] })
  raw.fields.comment.comments = Array.from({ length: 10 }, (_, i) => ({ id: String(200 + i), author: { displayName: 'Ann Smith', accountId: 'a' }, created: `2026-10-2${i}T10:00:00.000+0100`, body: big(i) }))
  const { html, omittedComments } = issueDocument({ issue: compact(raw, ME, 'full'), raw, site: SITE })
  assert.ok(Buffer.byteLength(html) <= HTML_MAX_BYTES)
  assert.equal(omittedComments, 4)
  assert.match(html, /<h2>Comments \(10\)<\/h2>\n<p><em>4 earlier comments are not shown here/)
  assert.ok(!html.includes('comment 3 ') && html.includes('comment 4 ') && html.includes('comment 9 '))
})

test('a huge description falls back to its plain text', () => {
  const raw = fixture('issue-ABC-1.json')
  raw.fields.description = { type: 'doc', version: 1, content: Array.from({ length: 2000 }, () => ({ type: 'paragraph', content: [{ type: 'text', text: 'y'.repeat(600), marks: [{ type: 'strong' }] }] })) }
  const { html } = issueDocument({ issue: compact(raw, ME, 'full'), raw, site: SITE })
  assert.match(html, /too long to show formatted/)
  assert.ok(Buffer.byteLength(html) <= HTML_MAX_BYTES)
})

test('attachmentUrl and fmtSize', () => {
  assert.equal(attachmentUrl(SITE, '10001'), `${SITE}/rest/api/3/attachment/content/10001`)
  assert.equal(fmtSize(512), '512 B')
  assert.equal(fmtSize(716800), '700 KB')
  assert.equal(fmtSize(3.1 * 1024 * 1024), '3.1 MB')
  assert.equal(fmtSize(null), '')
})

test('status and priority tones: On hold lane amber, Done green; priority names matched loosely', () => {
  assert.equal(statusTone({ category: 'indeterminate' }, 'onHold'), 'warning')
  assert.equal(statusTone({ category: 'done' }, 'done'), 'success')
  assert.equal(statusTone({ category: 'new' }, 'backlog'), 'neutral')
  for (const [name, tone] of [['1-Critical', 'danger'], ['Highest', 'danger'], ['Blocker', 'danger'], ['P2', 'warning'], ['High', 'warning'], ['3-Medium', 'info'], ['Medium', 'info'], ['Low', 'neutral'], ['5-Trivial', 'neutral'], ['', 'neutral']]) {
    assert.equal(priorityTone(name), tone, name)
  }
})

test('an unassigned issue says so in the facts', () => {
  const raw = fixture('issue-ABC-1.json')
  const issue = { ...compact(raw, ME, 'full'), assignee: '' }
  assert.match(issueDocument({ issue, raw, site: SITE }).html, /<dt>Assignee<\/dt><dd><em>Unassigned<\/em><\/dd>/)
})

test('the details column: toned facts first, then each attribute the issue has, escaped; parent as a link', () => {
  const raw = fixture('issue-ABC-1.json')
  const issue = compact(raw, ME, 'full')
  const extra = {
    ...raw,
    fields: {
      ...raw.fields,
      labels: ['payments', '<b>x</b>'],
      components: [{ name: 'Checkout' }],
      fixVersions: [{ name: '1.7.10' }],
      duedate: '2026-11-20',
      parent: { key: 'ABC-0', fields: { summary: 'EU launch' } },
      resolution: null,
    },
  }
  const html = issueDetails(issue, extra, 'inProgress', SITE)
  assert.match(html, /^<dl class="facts"><dt>Status<\/dt><dd><span class="lozenge lozenge-info">In Progress<\/span><\/dd><dt>Priority<\/dt>/)
  assert.match(html, /<dt>Labels<\/dt><dd><span class="lozenge lozenge-neutral">payments<\/span> <span class="lozenge lozenge-neutral">&lt;b&gt;x&lt;\/b&gt;<\/span><\/dd>/)
  assert.match(html, /<dt>Components<\/dt><dd><span class="lozenge lozenge-neutral">Checkout<\/span><\/dd>/)
  assert.match(html, /<dt>Due<\/dt><dd>2026-11-20<\/dd>/)
  assert.ok(html.includes(`<dt>Parent</dt><dd><a href="${SITE}/browse/ABC-0">ABC-0</a> EU launch</dd>`))
  assert.doesNotMatch(html, /Resolution/)
  const { aside, html: body } = issueDocument({ issue, raw: extra, site: SITE, aside: true })
  assert.equal(aside, issueDetails(issue, extra, undefined, SITE))
  assert.doesNotMatch(body, /class="facts"/)
})
