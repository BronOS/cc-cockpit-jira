'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { adfToHtml, textToHtml, esc, safeHref } = require('../dist/lib/adfhtml')

const doc = (...content) => ({ type: 'doc', version: 1, content })
const p = (...content) => ({ type: 'paragraph', content })
const t = (text, marks) => (marks ? { type: 'text', text, marks } : { type: 'text', text })
const li = (...content) => ({ type: 'listItem', content })

// Every tag the converter may write (the reviewer's allow-list), and every class.
const TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img', 'strong', 'em', 's', 'u', 'sub', 'sup', 'span', 'div', 'details', 'summary', 'figure', 'figcaption'])
const CLASSES = new Set(['jira-panel', 'jira-panel-info', 'jira-panel-note', 'jira-panel-warning', 'jira-panel-error', 'jira-panel-success', 'mention', 'card', 'card-header', 'meta', 'new', 'status', 'lozenge', 'attachment-list'])
const ATTRS = new Set(['class', 'colspan', 'rowspan', 'alt', 'title', 'data-asset', 'href'])

/** Fails when the html has a tag, attribute or class outside the allow-list. */
function assertAllowed(html) {
  for (const m of html.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)) {
    assert.ok(TAGS.has(m[1]), `tag ${m[1]} in ${html}`)
    for (const a of m[2].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
      assert.ok(ATTRS.has(a[1]), `attribute ${a[1]}`)
      if (a[1] === 'href') assert.match(a[2], /^(https?:|mailto:)/)
      if (a[1] === 'class') for (const c of a[2].split(' ')) assert.ok(CLASSES.has(c), `class ${c}`)
    }
    // Nothing but name="value" pairs inside a tag (no bare attribute, no stray quote).
    assert.equal(m[2].replace(/\s+[a-zA-Z-]+="[^"]*"/g, ''), '', `stray markup in <${m[1]}${m[2]}>`)
  }
}

test('esc escapes the five characters', () => {
  assert.equal(esc(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
  assert.equal(esc(null), '')
})

test('text is escaped: a <script> in a paragraph, a code block, a heading stays text', () => {
  const h = adfToHtml(doc(p(t('<script>alert(1)</script> & "q"')), { type: 'codeBlock', attrs: { language: 'html' }, content: [t('<img src=x onerror=alert(1)>\n')] }, { type: 'heading', attrs: { level: 1 }, content: [t('<b>x</b>')] }))
  assert.equal(h, '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;</p>\n<pre><code>&lt;img src=x onerror=alert(1)&gt;</code></pre>\n<h2>&lt;b&gt;x&lt;/b&gt;</h2>')
  assert.ok(!h.includes('<script'))
  assertAllowed(h)
})

test('headings shift one level (the issue is the h1) and stop at h6', () => {
  assert.equal(adfToHtml(doc({ type: 'heading', attrs: { level: 2 }, content: [t('A')] })), '<h3>A</h3>')
  assert.equal(adfToHtml(doc({ type: 'heading', attrs: { level: 6 }, content: [t('A')] })), '<h6>A</h6>')
  assert.equal(adfToHtml(doc({ type: 'heading', attrs: { level: 1 }, content: [t('A')] }), { headingShift: 0 }), '<h1>A</h1>')
})

test('lists: bullets, numbers, nesting, tasks and decisions', () => {
  const h = adfToHtml(
    doc(
      { type: 'bulletList', content: [li(p(t('one'))), li(p(t('two')), { type: 'bulletList', content: [li(p(t('nested')))] })] },
      { type: 'orderedList', attrs: { order: 3 }, content: [li(p(t('first')))] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [t('done')] }, { type: 'taskItem', attrs: { state: 'TODO' }, content: [t('todo')] }] },
      { type: 'decisionList', content: [{ type: 'decisionItem', content: [t('ship it')] }] },
    ),
  )
  assert.equal(
    h,
    '<ul><li>one</li><li><p>two</p>\n<ul><li>nested</li></ul></li></ul>\n<ol><li>first</li></ol>\n<ul><li>☑ done</li><li>☐ todo</li></ul>\n<ul><li>Decision: ship it</li></ul>',
  )
  assertAllowed(h)
})

test('inline marks: strong, em, strike, underline, code, sub/sup; colours dropped', () => {
  const h = adfToHtml(
    doc(
      p(
        t('b', [{ type: 'strong' }]),
        t('i', [{ type: 'em' }]),
        t('s', [{ type: 'strike' }]),
        t('u', [{ type: 'underline' }]),
        t('c', [{ type: 'code' }]),
        t('2', [{ type: 'subsup', attrs: { type: 'sup' } }]),
        t('x', [{ type: 'subsup', attrs: { type: 'sub' } }]),
        t('red', [{ type: 'textColor', attrs: { color: '#ff0000' } }]),
      ),
    ),
  )
  assert.equal(h, '<p><strong>b</strong><em>i</em><s>s</s><u>u</u><code>c</code><sup>2</sup><sub>x</sub>red</p>')
  assert.ok(!h.includes('style'))
})

test('links keep only http(s) and mailto hrefs; the rest is plain text', () => {
  const link = (text, href) => t(text, [{ type: 'link', attrs: { href } }, { type: 'strong' }])
  const h = adfToHtml(doc(p(link('ok', 'https://grafana.example.com/d/x?a=1&b="2"'), link('js', 'javascript:alert(1)'), link('data', 'data:text/html,<script>x</script>'), link('mail', 'mailto:a@b.c'), link('rel', '/browse/ABC-2'), link('file', 'file:///etc/passwd'))), { base: 'https://acme.atlassian.net' })
  assert.equal(
    h,
    '<p><a href="https://grafana.example.com/d/x?a=1&amp;b=%222%22"><strong>ok</strong></a><strong>js</strong><strong>data</strong><a href="mailto:a@b.c"><strong>mail</strong></a><a href="https://acme.atlassian.net/browse/ABC-2"><strong>rel</strong></a><strong>file</strong></p>',
  )
  assertAllowed(h)
  assert.equal(safeHref('JAVASCRIPT:alert(1)'), null)
  assert.equal(safeHref(' javascript:alert(1)'), null)
  assert.equal(safeHref('https://user:pw@evil.example/'), null)
  assert.equal(safeHref('/x'), null, 'a relative link without a base is dropped')
  assert.equal(safeHref('http://intranet/x'), 'http://intranet/x')
})

test('mentions, emoji, status, dates, inline cards and hard breaks', () => {
  const h = adfToHtml(
    doc(
      p(
        { type: 'mention', attrs: { id: 'acc1', text: '@Ann <Smith>' } },
        t(' '),
        { type: 'mention', attrs: { id: 'acc2', text: 'Bob' } },
        t(' '),
        { type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } },
        { type: 'hardBreak' },
        { type: 'status', attrs: { text: 'IN REVIEW', color: 'blue' } },
        { type: 'date', attrs: { timestamp: String(Date.parse('2026-11-02T00:00:00Z')) } },
        { type: 'inlineCard', attrs: { url: 'https://acme.atlassian.net/browse/ABC-2' } },
        { type: 'inlineCard', attrs: { url: 'javascript:alert(1)' } },
      ),
    ),
  )
  assert.equal(
    h,
    '<p><span class="mention">@Ann &lt;Smith&gt;</span> <span class="mention">@Bob</span> 😄<br><span class="status lozenge">IN REVIEW</span>2026-11-02<a href="https://acme.atlassian.net/browse/ABC-2">https://acme.atlassian.net/browse/ABC-2</a>javascript:alert(1)</p>',
  )
  assertAllowed(h)
})

test('panels become div.jira-panel.jira-panel-<type>; tip is success, unknown is info', () => {
  const panel = (panelType) => ({ type: 'panel', attrs: { panelType }, content: [p(t(panelType))] })
  const h = adfToHtml(doc(panel('info'), panel('note'), panel('warning'), panel('error'), panel('success'), panel('tip'), panel('custom" onclick="x')))
  assert.equal(
    h,
    [
      '<div class="jira-panel jira-panel-info"><p>info</p></div>',
      '<div class="jira-panel jira-panel-note"><p>note</p></div>',
      '<div class="jira-panel jira-panel-warning"><p>warning</p></div>',
      '<div class="jira-panel jira-panel-error"><p>error</p></div>',
      '<div class="jira-panel jira-panel-success"><p>success</p></div>',
      '<div class="jira-panel jira-panel-success"><p>tip</p></div>',
      '<div class="jira-panel jira-panel-info"><p>custom&quot; onclick=&quot;x</p></div>',
    ].join('\n'),
  )
  assertAllowed(h)
})

test('tables: a header row becomes thead, spans are kept as integers only', () => {
  const cell = (type, text, attrs) => ({ type, attrs, content: [p(t(text))] })
  const h = adfToHtml(
    doc({
      type: 'table',
      content: [
        { type: 'tableRow', content: [cell('tableHeader', 'Card'), cell('tableHeader', 'Result')] },
        { type: 'tableRow', content: [cell('tableCell', 'Visa', { colspan: 2 }), cell('tableCell', '<x>', { rowspan: '3" onclick="y' })] },
      ],
    }),
  )
  assert.equal(h, '<table><thead><tr><th>Card</th><th>Result</th></tr></thead><tbody><tr><td colspan="2">Visa</td><td>&lt;x&gt;</td></tr></tbody></table>')
  assertAllowed(h)
})

test('blockquote, rule, expand and code block', () => {
  const h = adfToHtml(doc({ type: 'blockquote', content: [p(t('quoted'))] }, { type: 'rule' }, { type: 'expand', attrs: { title: 'Logs <here>' }, content: [{ type: 'codeBlock', content: [t('a\nb')] }] }, { type: 'nestedExpand', attrs: {}, content: [p(t('x'))] }))
  assert.equal(h, '<blockquote><p>quoted</p></blockquote>\n<hr>\n<details><summary>Logs &lt;here&gt;</summary><pre><code>a\nb</code></pre></details>\n<details><summary>Details</summary><p>x</p></details>')
  assertAllowed(h)
})

test('media: an inlined image is <img data-asset>, a file is a link, unknown is its name, external never loads', () => {
  const media = (attrs) => {
    if (attrs.alt === 'shot.png') return { kind: 'image', assetId: 'att10001', name: 'shot.png' }
    if (attrs.alt === 'log.txt') return { kind: 'link', href: 'https://acme.atlassian.net/rest/api/3/attachment/content/10002', name: 'log.txt' }
    return null
  }
  const m = (alt, extra = {}) => ({ type: 'media', attrs: { id: 'uuid-1', type: 'file', collection: '', alt, ...extra } })
  const h = adfToHtml(
    doc(
      { type: 'mediaSingle', attrs: { layout: 'center' }, content: [m('shot.png'), { type: 'caption', content: [t('The <error>')] }] },
      { type: 'mediaGroup', content: [m('log.txt'), m('gone.pdf')] },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'external', url: 'https://evil.example/pixel.gif', alt: 'pixel' } }] },
      p(t('see '), { type: 'mediaInline', attrs: { id: 'u', type: 'file', alt: 'log.txt' } }),
    ),
    { media },
  )
  assert.equal(
    h,
    [
      '<figure><img data-asset="att10001" alt="shot.png" title="shot.png"><figcaption>The &lt;error&gt;</figcaption></figure>',
      '<p><a href="https://acme.atlassian.net/rest/api/3/attachment/content/10002">log.txt</a></p>',
      '<p>[attachment: gone.pdf]</p>',
      '<p><a href="https://evil.example/pixel.gif">image: pixel</a></p>',
      '<p>see <a href="https://acme.atlassian.net/rest/api/3/attachment/content/10002">log.txt</a></p>',
    ].join('\n'),
  )
  assert.ok(!/<img[^>]*src=/.test(h), 'no image ever has a src')
  assertAllowed(h)
})

test('a hostile document: deep nesting, junk nodes, attribute injection', () => {
  let deep = p(t('bottom'))
  for (let i = 0; i < 200; i++) deep = { type: 'blockquote', content: [deep] }
  const h = adfToHtml(doc(deep, null, 7, 'x', { type: 'paragraph', content: 'nope' }, { type: 'unknownBlock', content: [t('inline kids')] }, { type: 'mediaSingle', content: [{ type: 'media', attrs: { alt: '" onerror="alert(1)' } }] }))
  assert.ok(!h.includes('bottom'), 'past the depth limit nothing is rendered')
  assert.match(h, /<p>inline kids<\/p>/)
  assert.match(h, /\[attachment: &quot; onerror=&quot;alert\(1\)\]/)
  assertAllowed(h)
})

test('plain text bodies (the cached copy) become escaped paragraphs', () => {
  assert.equal(textToHtml('a <b>\nnext\n\npara 2'), '<p>a &lt;b&gt;<br>next</p>\n<p>para 2</p>')
  assert.equal(adfToHtml('x & y'), '<p>x &amp; y</p>')
  assert.equal(adfToHtml(null), '')
  assert.equal(textToHtml('  '), '')
})
