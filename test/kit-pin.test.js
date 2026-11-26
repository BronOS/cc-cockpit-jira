'use strict'
// The overlay kit is vendored (D9): vendor/cc-kit holds a pinned copy of cc-cockpit's kit/ (dist, host,
// VERSION, SHA256SUMS). Its bytes must be the ones the sums name, and the version the one this plugin was
// built and tested with. To update: copy kit/dist, kit/host, kit/VERSION and kit/SHA256SUMS from cc-cockpit
// (built there with npm run build:kit), then change KIT_VERSION here.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const KIT = path.join(__dirname, '../vendor/cc-kit')
const KIT_VERSION = '0.1.4'

test('the vendored kit\'s bytes match its SHA256SUMS, and it is the pinned version', () => {
  const lines = fs.readFileSync(path.join(KIT, 'SHA256SUMS'), 'utf8').trim().split('\n')
  const names = lines.map((l) => l.split('  ')[1]).sort()
  assert.deepEqual(names, ['VERSION', 'dist/cc-kit.css', 'dist/cc-kit.js', 'host/shared-page.js'])
  for (const line of lines) {
    const [sum, name] = line.split('  ')
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(KIT, name))).digest('hex'), sum, name)
  }
  assert.equal(fs.readFileSync(path.join(KIT, 'VERSION'), 'utf8').trim(), KIT_VERSION)
  // Nothing else in the folder: a file the sums do not name would ship unchecked.
  const all = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else all.push(path.relative(KIT, p))
    }
  }
  walk(KIT)
  assert.deepEqual(all.sort(), ['SHA256SUMS', ...names].sort())
})

test('the pages load the vendored kit, and no page writes markup with innerHTML', () => {
  const panels = path.join(__dirname, '../panels')
  for (const page of ['issue.html', 'part.html']) {
    const html = fs.readFileSync(path.join(panels, page), 'utf8')
    assert.match(html, /<script src="\.\.\/vendor\/cc-kit\/dist\/cc-kit\.js"><\/script>/, page)
    assert.match(html, /<link rel="stylesheet" href="\.\.\/vendor\/cc-kit\/dist\/cc-kit\.css" \/>/, page)
  }
  for (const f of fs.readdirSync(panels).filter((n) => n.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(panels, f), 'utf8').replace(/\/\/[^\n]*/g, '')
    assert.doesNotMatch(code, /\.innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML|document\.write/, f)
  }
})
