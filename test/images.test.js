'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const img = require('../dist/lib/images')
const { tmpDir, picture, SITE } = require('./fakes')

const att = (id, o = {}) => ({ id: String(id), name: `${id}.png`, mime: 'image/png', size: 1000, created: Number(id), by: '', ...o })

test('the budget numbers: 700 KiB raw stays under the 1,000,000-char dataUrl cap; 7.5 MiB total under 8 MiB', () => {
  assert.equal(img.MAX_IMAGE_BYTES, 716800)
  assert.equal(img.dataUrlLength(img.MAX_IMAGE_BYTES, 'image/jpeg'), 955759)
  assert.ok(img.dataUrlLength(img.MAX_IMAGE_BYTES, 'image/webp') < img.MAX_DATAURL_CHARS)
  assert.equal(img.MAX_TOTAL_CHARS, 7864320)
  assert.ok(img.MAX_TOTAL_CHARS < 8 * 1024 * 1024)
  assert.equal(img.MAX_IMAGES, 15)
  assert.equal(img.toDataUrl(picture('png', 1000)).dataUrl.length, img.dataUrlLength(1000, 'image/png'))
})

test('selectImages: raster types only, newest first, at most 15, too big ones and the overflow are links', () => {
  const list = [
    ...Array.from({ length: 18 }, (_, i) => att(100 + i)),
    att(50, { mime: 'image/svg+xml' }),
    att(51, { mime: 'application/pdf' }),
    att(200, { size: img.MAX_IMAGE_BYTES + 1 }),
    att(201, { size: img.MAX_IMAGE_BYTES }),
  ]
  const { wanted, links } = img.selectImages(list)
  assert.equal(wanted.length, 15)
  assert.deepEqual(wanted.slice(0, 3).map((a) => a.id), ['201', '117', '116'])
  assert.ok(!wanted.some((a) => a.id === '200' || a.id === '50' || a.id === '51'))
  assert.deepEqual(links.map((a) => a.id).sort(), ['100', '101', '102', '103', '200'])
})

test('selectImages: the total budget turns the rest into links; an unknown size counts as the maximum', () => {
  const near = Array.from({ length: 10 }, (_, i) => att(300 + i, { size: 700 * 1024 }))
  const { wanted, links } = img.selectImages(near)
  // 955,736-char dataUrls: 8 fit in 7,864,320 chars.
  assert.equal(wanted.length, 8)
  assert.equal(links.length, 2)
  assert.deepEqual(wanted.map((a) => a.id).slice(0, 2), ['309', '308'])
  const unknown = img.selectImages(Array.from({ length: 10 }, (_, i) => att(400 + i, { size: null })))
  assert.equal(unknown.wanted.length, 8)
})

test('sniff reads the bytes, not the claimed type', () => {
  assert.equal(img.sniff(picture('png')), 'image/png')
  assert.equal(img.sniff(picture('jpeg')), 'image/jpeg')
  assert.equal(img.sniff(picture('gif')), 'image/gif')
  assert.equal(img.sniff(picture('webp')), 'image/webp')
  assert.equal(img.sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')), null)
  assert.equal(img.sniff(Buffer.from('<html><body>login</body></html>')), null)
  assert.equal(img.toDataUrl(Buffer.from('<html>nope</html>')), null)
  assert.match(img.toDataUrl(picture('gif')).dataUrl, /^data:image\/gif;base64,R0lGODlh/)
})

test('the cache: per site, read back, bounded by count and bytes (least recently used go)', async () => {
  const dir = path.join(tmpDir(), 'images')
  const c = img.imageCache(dir, SITE, { maxFiles: 3, maxBytes: 10000 })
  const other = img.imageCache(dir, 'https://other.atlassian.net')
  await c.put('1', picture('png', 100))
  assert.deepEqual(await c.get('1'), picture('png', 100))
  assert.equal(await other.get('1'), null, 'another site has its own ids')
  assert.equal(await c.get('2'), null)
  await assert.rejects(c.get('../x'))
  for (const id of ['2', '3', '4']) {
    await new Promise((r) => setTimeout(r, 15))
    await c.put(id, picture('png', 100))
  }
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.img')).length, 3)
  assert.equal(await c.get('1'), null, 'the oldest went')
  await c.put('5', picture('png', 9950))
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.img')).length, 1, 'the bytes bound: only the newest fits')
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
})

test('gatherImages: cache first, downloads for the rest, assets newest first; a non-picture is dropped', async () => {
  const cache = img.imageCache(path.join(tmpDir(), 'images'), SITE)
  await cache.put('3', picture('gif', 50))
  const got = []
  const r = await img.gatherImages({
    wanted: [att(3, { name: 'c.gif' }), att(2, { name: 'b.png' }), att(1, { name: 'a.html' })],
    cache,
    waitMs: 1000,
    download: async (a) => (got.push(a.id), a.id === '1' ? Buffer.from('<html>login page</html>') : picture('png', 80)),
  })
  assert.deepEqual(got, ['2', '1'], 'the cached one is not downloaded')
  assert.deepEqual(r.assets.map((a) => [a.id, a.name, a.mime]), [['att3', 'c.gif', 'image/gif'], ['att2', 'b.png', 'image/png']])
  assert.deepEqual([...r.byAttachment], [['3', 'att3'], ['2', 'att2']])
  assert.equal(r.failed.length, 1)
  assert.match(r.failed[0].message, /not a png/)
  assert.deepEqual(await cache.get('2'), picture('png', 80), 'downloads are cached')
})

test('gatherImages: the wait is bounded; late images are links now and cached for the next open; none starts late', async () => {
  const cache = img.imageCache(path.join(tmpDir(), 'images'), SITE)
  const started = []
  const resolvers = {}
  const download = (a) => {
    started.push(a.id)
    if (a.id === '9') return Promise.resolve(picture('png', 40))
    return new Promise((r) => (resolvers[a.id] = r))
  }
  const wanted = [att(9), att(8), att(7), att(6), att(5)]
  const t0 = Date.now()
  const r = await img.gatherImages({ wanted, cache, waitMs: 60, download })
  assert.ok(Date.now() - t0 < 1000)
  assert.deepEqual(r.assets.map((a) => a.id), ['att9'])
  assert.equal(r.late, 4)
  // Three at a time: 9 finished, then 6 started; 5 never starts after the wait.
  assert.deepEqual(started, ['9', '8', '7', '6'])
  resolvers['8'](picture('jpeg', 40))
  await new Promise((res) => setTimeout(res, 20))
  await cache.flush()
  assert.deepEqual(await cache.get('8'), picture('jpeg', 40), 'a late download still fills the cache')
  assert.deepEqual(started, ['9', '8', '7', '6'], 'nothing started after the wait')
})

test('gatherImages without a download (Jira unreachable): the cached images only', async () => {
  const cache = img.imageCache(path.join(tmpDir(), 'images'), SITE)
  await cache.put('1', picture('webp', 30))
  const r = await img.gatherImages({ wanted: [att(1), att(2)], cache, download: null })
  assert.deepEqual(r.assets.map((a) => a.id), ['att1'])
  assert.equal(r.late, 0)
})
