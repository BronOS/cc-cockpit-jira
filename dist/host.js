'use strict'
// bronos.jira: your Jira Cloud issues in lanes, sorted by jev-triage; since 0.8.0 a comment and a
// status change from Reply (section "writing to Jira" below; design "Writing to Jira"); since 0.9.0 an
// issue opens in its own window (section "the issue window": notes, Ask and Reply in every view).
// Plain JavaScript with no build step; the pure logic is in ./lib (node:test suites in test/).
// Design: docs/design.md. The app API: `ccc guide api` (this file uses only what it documents).
//
// Life of a project window: activate reads the settings and the stored state, then polls every
// `pollMinutes` while the window is open (a closed project has no host, so it does nothing). A
// poll searches, reads changed issues in full, updates the seen marks, asks triage about what
// changed, and posts the state to the panel. Nothing is polled until site, email and token are set.

const { readSettings, connectionKey, missingText, mailSendersOf } = require('./lib/settings')
const { createClient } = require('./lib/client')
const { compact, attachmentsOf, header } = require('./lib/model')
const { poll, buildView, allRows, loadCache } = require('./lib/poll')
const { loadSeen, seed, markRead, markUnread, emptySeen, bound } = require('./lib/seen')
const { triageItem, mentionedBy } = require('./lib/triage')
const { readableText, browseUrl, discussPrompt } = require('./lib/readable')
const { pickTab, openerArgv } = require('./lib/actions')
const { runCli } = require('./lib/cli')
const { jsonFile } = require('./lib/store')
const { hashOf, oneLine, cut, issueKey } = require('./lib/util')
const { issueDocument, HTML_MAX_BYTES } = require('./lib/document')
const { statusLane } = require('./lib/lanes')
const svc = require('./lib/service')
const feed = require('./lib/feed')
const { headerSpec } = require('./lib/header')
const { selectImages, gatherImages, imageCache, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_TOTAL_CHARS, WAIT_MS } = require('./lib/images')
const wr = require('./lib/write')
// The Reply tab's own decisions (a classic script the page loads too): the kept move choice.
const { keepChoice } = require('../panels/replylogic')
// The overlay kit's host side (vendored and pinned, D9; test/kit-pin.test.js checks the bytes).
const { makePage } = require('../vendor/cc-kit/host/shared-page')
const path = require('node:path')

const PANEL = 'main'
const SOURCE = 'jira' // the triage source name: verdicts, overrides and cases group by it
const TRIAGE_CHUNK = 500 // triage.classify takes at most 500 items a call
const ROWS_PER_LANE = 300 // the panel message stays far below the 1 MiB post limit
const CLI_WAIT_MS = 25000 // `ccc` gives a handler 30 s
// ctx.overlay.start gives no "shown" signal: main's refusal (3 open, 10 a minute) rejects the handle's
// `result` within one host-to-main round trip, while an overlay that opened settles only when it
// closes. The issue window counts as up once this long passed without a rejection.
const OVERLAY_SETTLE_MS = 500
const IMAGE_TIMEOUT_MS = 20000 // one attachment download, redirects and body included
// How long a CLI draft waits for the issue's header and moves to be read (the answer comes before ccc's 30 s).
const DRAFT_WAIT_MS = 20000

let instance = null

/**
 * The host, with its I/O injectable for the suites (`fetch`, the platform, timers). The app calls
 * `activate(ctx)`, which uses the real ones.
 */
function start(ctx, io = {}) {
  const fetchFn = io.fetch || globalThis.fetch
  const platform = io.platform || process.platform
  const now = io.now || Date.now
  const draftWaitMs = io.draftWaitMs || DRAFT_WAIT_MS // the suites shorten it
  const triage = ctx.services.use('triage')
  const cacheFile = jsonFile(ctx.dataDir, 'cache.json')
  const abort = new AbortController()

  const S = {
    settings: readSettings(ctx.settings.project),
    connKey: null,
    client: null,
    cache: null, // poll.loadCache: me and the issues read in full
    lists: null, // the last poll's lists (assigned, done, candidates)
    seen: null, // seen.loadSeen, once the account is known
    view: { lanes: [], unread: 0 },
    lastPoll: 0,
    polling: null, // the running poll's promise: one at a time
    error: null, // the last poll's failure, shown as a notice
    errorKind: null, // its client error kind ('auth' when Jira refused the token), for the inbox feed's state
    laneErrors: {},
    stats: null,
    verdicts: {}, // key -> { priority, kind, confidence, by }
    sigs: {}, // key -> hash of the triage item it was judged on
    triageError: null,
    classifying: Promise.resolve(),
    ui: { collapsed: {}, expanded: {} }, // per lane id; `expanded` = Show all pressed
    notice: null, // { text, kind: 'info'|'error' } after an action, until dismissed or replaced
    choose: null, // { key, tabs } when Discuss needs the person to pick a tab
    // Writes (0.8.0) vs a poll already under way (review R1-5): each write bumps `writeGen` and keeps
    // the issue as read after it; a poll that started before a write keeps those newer copies over its
    // own older answer and is followed by a fresh poll.
    writeGen: 0,
    written: new Map(), // key -> { gen, header, issue }
    stopped: false,
  }

  const cfg = () => S.settings.cfg
  // Writing to Jira (0.8.0): whether writes are on (the forms are in "writing to Jira" below).
  const writesOn = () => cfg().writes !== 'off'

  // ---- stored state ----

  const ready = (async () => {
    const ui = await ctx.storage.get('ui').catch(() => undefined)
    if (ui && typeof ui === 'object') {
      const obj = (v) => (v && typeof v === 'object' ? { ...v } : {})
      S.ui = { collapsed: obj(ui.collapsed), expanded: obj(ui.expanded) }
    }
    const t = await ctx.storage.get('triage').catch(() => undefined)
    if (t && t.site === cfg().site && t.verdicts && t.sigs) {
      S.verdicts = t.verdicts
      S.sigs = t.sigs
    }
    if (S.settings.ready) await loadSiteState()
    rebuild()
    recheckAnnouncements()
  })().catch((e) => ctx.log.error('loading the stored state failed:', e && e.stack ? e.stack : e))

  /** The cache file and the seen marks of the configured site and email (from the last run). */
  async function loadSiteState() {
    const stored = await cacheFile.read(null)
    S.cache = loadCache(stored, cfg().site, cfg().email)
    if (stored && S.cache.issues === stored.issues) {
      S.lists = stored.lists || null
      S.lastPoll = stored.lastPoll || 0
    }
    if (S.cache.me) S.seen = loadSeen(await ctx.storage.get('seen').catch(() => undefined), cfg().site, S.cache.me.accountId)
  }

  function saveCache() {
    return cacheFile.write({ ...S.cache, lists: S.lists, lastPoll: S.lastPoll }).catch((e) => ctx.log.warn('writing the issue cache failed:', e.message))
  }
  function saveSeen() {
    return ctx.storage.set('seen', S.seen).catch((e) => ctx.log.warn('saving the seen marks failed:', e.message))
  }
  function saveTriage() {
    return ctx.storage.set('triage', { site: cfg().site, verdicts: S.verdicts, sigs: S.sigs }).catch((e) => ctx.log.warn('saving triage verdicts failed:', e.message))
  }

  function client() {
    const key = connectionKey(cfg())
    if (!S.client || S.connKey !== key) {
      S.client = createClient({ site: cfg().site, email: cfg().email, token: cfg().token, tokenKind: cfg().tokenKind, fetch: fetchFn })
      S.connKey = key
    }
    return S.client
  }

  let images = null
  /** The image cache of the configured site (attachment ids are per site). */
  function imgCache() {
    if (!images || images.site !== cfg().site) images = { site: cfg().site, cache: imageCache(path.join(ctx.dataDir, 'images'), cfg().site) }
    return images.cache
  }

  // ---- the view ----

  function rebuild() {
    if (!S.cache || !S.lists) {
      S.view = { lanes: [], unread: 0 }
    } else {
      S.view = buildView({ cfg: cfg(), lists: S.lists, cache: S.cache, seen: S.seen || emptySeen(cfg().site, ''), verdicts: triageOn() ? S.verdicts : {}, now: now() })
    }
    try {
      ctx.badge(PANEL, S.view.unread || null)
    } catch (e) {
      ctx.log.warn('badge:', e.message)
    }
  }

  function triageOn() {
    return ctx.services.available('triage')
  }

  // ---- polling ----

  /** Poll now unless a poll is running (then that one's promise). Never rejects. */
  function pollNow(reason) {
    if (S.polling) return S.polling
    if (!S.settings.ready || S.stopped) return Promise.resolve()
    const gen0 = S.writeGen
    let followUp = false
    S.polling = (async () => {
      try {
        await ready
        if (!S.cache || S.cache.site !== cfg().site || S.cache.email !== cfg().email) await loadSiteState()
        const r = await poll({ client: client(), cfg: cfg(), cache: S.cache, prev: S.lists || undefined, now: now(), signal: abort.signal })
        S.lists = r.lists
        followUp = keepWrites(gen0)
        S.lastPoll = r.at
        S.stats = r.stats
        S.laneErrors = r.laneErrors
        S.error = null
        S.errorKind = null
        if (!S.seen || S.seen.accountId !== S.cache.me.accountId) S.seen = loadSeen(await ctx.storage.get('seen').catch(() => undefined), cfg().site, S.cache.me.accountId)
        rebuild()
        recheckAnnouncements()
        // First runs: what is there now counts as seen (seen.js explains when seeding ends).
        if (!S.seen.seeded) {
          const entries = allRows(S.view).filter((x) => x.issue.full).map((x) => ({ issue: x.issue, lane: x.lane }))
          seed(S.seen, entries, r.stats.deferred === 0)
          rebuild()
        }
        for (const e of r.stats.issueErrors) ctx.log.warn(`reading ${e.key} failed: ${e.message}`)
        for (const [lane, m] of Object.entries(r.laneErrors)) ctx.log.warn(`${lane} search: ${m}`)
        await Promise.all([saveCache(), saveSeen()])
        ctx.log.info(`poll (${reason}): ${r.stats.searched} found, ${r.stats.fetched} read in full, ${r.stats.deferred} deferred, ${r.stats.issueErrors.length} failed; ${S.client.mode() || '?'} token`)
        postState()
        await classifyChanged()
      } catch (e) {
        S.error = e && e.message ? e.message : String(e)
        S.errorKind = e && typeof e.kind === 'string' ? e.kind : null
        ctx.log.error(`poll (${reason}) failed: ${S.error}${e && e.detail ? ` (${e.detail})` : ''}`)
      } finally {
        S.polling = null
        postState()
        // After a failed poll too: the feed's state (signed out, error) changed.
        emitFeed()
        // A write landed while this poll ran: one more, whose searches were sent after it.
        if ((followUp || S.writeGen !== gen0) && !S.stopped) void pollNow('after a write')
      }
    })()
    postState()
    return S.polling
  }

  /**
   * After a poll that started at write generation `gen0`: the issues written since then keep the copy
   * read after the write (its header in the lists, its full copy in the cache) wherever the poll's
   * own answer is older, since its searches may have been sent before the write. Entries no poll
   * needs any more (written before this poll started) are dropped. True when such a write happened.
   */
  function keepWrites(gen0) {
    let newer = false
    for (const [key, w] of S.written) {
      if (w.gen <= gen0) {
        S.written.delete(key)
        continue
      }
      newer = true
      for (const name of ['assigned', 'done', 'candidates']) {
        const list = S.lists && S.lists[name]
        if (!Array.isArray(list)) continue
        const i = list.findIndex((x) => x.key === key)
        if (i >= 0 && (list[i].updatedAt || 0) <= (w.header.updatedAt || 0)) list[i] = { ...w.header, closedAt: w.header.closedAt || list[i].closedAt || 0 }
      }
      const cached = S.cache && S.cache.issues[key]
      if (w.issue && cached && (cached.updatedAt || 0) < (w.issue.updatedAt || 0)) S.cache.issues[key] = w.issue
    }
    return newer
  }

  let stopSchedule = null
  let scheduledMinutes = 0
  function reschedule() {
    const minutes = cfg().pollMinutes
    if (stopSchedule && minutes === scheduledMinutes) return
    if (stopSchedule) stopSchedule()
    scheduledMinutes = minutes
    // The tick only starts a poll and returns: a first poll can outlast ctx.schedule's 60 s per
    // run, and pollNow already keeps polls from overlapping.
    stopSchedule = ctx.schedule(minutes * 60, () => {
      void pollNow('schedule')
    })
  }
  reschedule()
  // Not inside activate: the poll ends in a triage call, and a service call during activate can
  // close a cycle (`ccc guide api`, Cycles).
  const firstPoll = (io.setTimeout || setTimeout)(() => void pollNow('start'), io.firstPollMs === undefined ? 1500 : io.firstPollMs)

  // ---- triage ----

  /**
   * Classify the shown rows whose triage item changed since they were judged (or `force`d by a
   * triage `change` event). One at a time: an event during a classify waits for it.
   */
  function classifyChanged(force = new Set()) {
    S.classifying = S.classifying.then(async () => {
      if (!triageOn()) {
        S.triageError = null
        return
      }
      const rows = allRows(S.view)
      const items = rows.map((x) => triageItem(x, cfg().triageText))
      const ids = new Set(items.map((i) => i.id))
      const todo = items.filter((it) => force.has(it.id) || S.sigs[it.id] !== hashOf(it))
      // Forget verdicts of issues no longer shown (bounded by what the lanes hold).
      for (const k of Object.keys(S.verdicts)) if (!ids.has(k)) delete S.verdicts[k]
      for (const k of Object.keys(S.sigs)) if (!ids.has(k)) delete S.sigs[k]
      if (!todo.length) return
      try {
        for (let i = 0; i < todo.length; i += TRIAGE_CHUNK) {
          const chunk = todo.slice(i, i + TRIAGE_CHUNK)
          const { results } = await triage.classify(SOURCE, chunk)
          for (const it of chunk) {
            const v = results && results[it.id]
            if (v && !v.error && v.priority) {
              S.verdicts[it.id] = { priority: v.priority, kind: v.kind || null, confidence: typeof v.confidence === 'number' ? v.confidence : 1, by: v.by || '' }
              S.sigs[it.id] = hashOf(it)
            } else if (v && v.error) {
              ctx.log.warn(`triage of ${it.id}: ${v.error}`)
            }
          }
        }
        S.triageError = null
      } catch (e) {
        // jev-triage's own message (jev missing, a cap reached): the person reads it as is.
        S.triageError = e && e.message ? e.message : String(e)
        ctx.log.warn('triage:', S.triageError)
      }
      await saveTriage()
      rebuild()
      postState()
    })
    return S.classifying
  }

  // After a rescore, a correction or a jev-triage settings change: judge those ids again.
  triage.on('change', (data) => {
    if (!data || data.source !== SOURCE) return
    const force = new Set()
    if (data.ids === null || data.ids === undefined) S.sigs = {}
    else for (const id of data.ids) force.add(String(id))
    void classifyChanged(force)
  })

  // ---- settings ----

  ctx.onSettingsChange(() => {
    const before = cfg()
    S.settings = readSettings(ctx.settings.project)
    const after = cfg()
    if (before.site !== after.site || before.email !== after.email) {
      // Another site or account: nothing of the old one applies (keys, marks, verdicts).
      S.cache = null
      S.lists = null
      S.seen = null
      S.verdicts = {}
      S.sigs = {}
      S.lastPoll = 0
      S.error = null
    }
    if (connectionKey(before) !== connectionKey(after)) S.client = null
    // Writing turned off, or another site or account: an unsent Reply would write where the person no
    // longer means to. Dropped (its text was the person's to post; nothing was written). A window of the
    // old site closes; with writes off the windows stay and their copies lose the Reply tab.
    const moved = before.site !== after.site || before.email !== after.email || connectionKey(before) !== connectionKey(after)
    if (after.writes === 'off' || moved) {
      for (const [key, form] of forms) if (!form.busy) forms.delete(key)
      if (moved) for (const win of [...windows.values()]) closeQuietly(win.handle)
      else for (const win of windows.values()) if (win.state) win.page.set(win.state, { document: win.state.html })
    }
    // The service's answers belong to the old site or account (and the senders may have changed).
    lookups.clear()
    if (S.settings.ready) reschedule()
    rebuild()
    recheckAnnouncements()
    postState()
    // A lane switched off or on, or the account gone: Inbox hears it now, not with the next poll.
    emitFeed()
    if (S.settings.ready) void pollNow('settings')
  })

  // ---- issues for the actions ----

  /** The row of a key in the current view, or null. */
  function rowOf(key) {
    return allRows(S.view).find((x) => x.issue.key === key) || null
  }

  /**
   * The issue in full for a reader (overlay, show, Discuss): read fresh with the large cuts, so the
   * text is what Jira holds now; the cached copy when Jira cannot be reached.
   */
  async function fullIssue(key, signal) {
    await ready
    if (!S.settings.ready) throw new Error(missingText(S.settings.missing).join('; ') || S.settings.problems.join('; '))
    const row = rowOf(key)
    const lane = row ? row.lane : 'any'
    const mark = S.seen ? S.seen.marks[key] : undefined
    try {
      if (!S.cache) await loadSiteState()
      if (!S.cache.me) S.cache.me = await client().myself(signal)
      const raw = await client().issue(key, signal || abort.signal)
      const issue = compact(raw, S.cache.me.accountId, 'full')
      return { issue, raw, lane, mark }
    } catch (e) {
      const cached = S.cache && S.cache.issues[key]
      if (cached) {
        ctx.log.warn(`reading ${key} fresh failed, using the cached copy: ${e.message}`)
        return { issue: row ? row.issue : cached, raw: null, lane, mark, stale: e.message }
      }
      throw e
    }
  }

  async function setRead(key, read) {
    await ready
    if (!S.seen) throw new Error('no poll yet: the seen marks start with the first poll (ccc jira refresh)')
    const row = rowOf(key)
    const issue = row ? row.issue : S.cache && S.cache.issues[key]
    if (!issue) throw new Error(`${key} is not in the lanes (only shown issues have a seen mark)`)
    if (read) markRead(S.seen, issue, now())
    else markUnread(S.seen, issue, row ? row.lane : 'any')
    await saveSeen()
    rebuild()
    postState()
    emitFeed()
    // Unread changes the hint, so the item's hash: only this issue is judged again.
    void classifyChanged()
  }

  function setNotice(text, kind = 'info') {
    S.notice = { text: cut(oneLine(text), 400), kind }
    postState()
  }

  /** Close an overlay handle that is not needed; a throw here must not mask the error it runs beside. */
  function closeQuietly(handle) {
    try {
      handle.close()
    } catch {}
  }


  // ---- the issue window (0.9.0; the overlay foundation's layout A) ----
  //
  // One perView overlay per issue (`windows`, by key), opened before the issue is read so something is on
  // screen at once. The kit's makePage (vendor/cc-kit/host/shared-page.js) greets each copy with the access the app
  // gave it (owner, a write guest, a read guest; never the page's word), replays the issue to every copy, keeps the
  // owner's last side tab, and opens only links that are in the issue. The page (panels/issue.js) draws the issue
  // with the kit's renderer, the notes (`notes: { key: 'jira:<KEY>' }`: core keeps them, in every view, over Esc),
  // Ask (core's chat) and the Reply tab. Reply's form lives here (`forms`), not in a page, so one Esc never
  // loses it and every write copy shows the same draft. Discuss with Claude and New session are core's toolbar.

  const windows = new Map() // issue key -> the open window (win)
  // A draft opens Reply (D7): a copy that connects this soon after the request starts there too.
  const SELECT_MS = 30000

  /** Owner or write guest, from the app's `from` only. A missing or malformed `from` refuses: no owner default. */
  const writer = (from) => Boolean(from) && typeof from === 'object' && (from.access === 'owner' || from.access === 'write')
  const isOwner = (from) => Boolean(from) && typeof from === 'object' && from.access === 'owner'
  const mayReply = (from) => writer(from) && writesOn()

  /**
   * Open (or focus) the issue's window: up at once, filled once the issue is read. `onStarted` (feed act) runs once
   * the app did not refuse the overlay; `o.reply` selects Reply in the owner's and write guests' copies (a Reply
   * click, a draft). Resolves after the read (a failed read is the window's error page with Try again, and the
   * panel's notice); throws when the app refused the window.
   */
  async function openIssue(key, onStarted, o = {}) {
    const win = await showWindow(key, o)
    if (onStarted) onStarted()
    if (win.loaded) return win.loaded
  }

  /** The window of `key` on screen (focused when it was open already), its read started; throws on a refusal. */
  async function showWindow(key, o = {}) {
    await ready
    if (!S.settings.ready) throw notConfigured()
    const reply = Boolean(o.reply) && writesOn()
    const open = windows.get(key)
    if (open && !open.ended) {
      try {
        open.handle.focus()
      } catch {}
      if (reply) selectReply(open)
      return open
    }
    const win = startWindow(key)
    if (reply) selectReply(win)
    const refused = await overlayRefusal(win.handle)
    if (refused) {
      endWindow(win)
      throw new Error(`Cannot open ${key}: ${refused.message || refused}`)
    }
    win.loaded = loadWindow(win).catch((e) => {
      const msg = e && e.message ? e.message : String(e)
      ctx.log.warn(`open ${key}: ${msg}`)
      setNotice(`Could not open ${key}: ${msg}`, 'error')
    })
    return win
  }

  /** The overlay and its page helper; throws when the app refused `start` itself or is too old for copies. */
  function startWindow(key) {
    const row = rowOf(key)
    const summary = row ? row.issue.summary : ''
    // The overlay API cannot retitle an open overlay: with no cached summary the title is the bare key.
    const handle = ctx.overlay.start({
      kind: 'html',
      file: 'panels/issue.html',
      title: summary ? `${key}: ${cut(oneLine(summary), 80)}` : key,
      size: 'large',
      type: overlayType(key),
      // Core's notes and Ask (app 0.28.0); an older app ignores the key and the page goes without them.
      notes: { key: `jira:${key}` },
      buttons: [{ id: 'browser', label: 'Open in Jira ↗' }],
    })
    if (typeof handle.onConnect !== 'function') {
      // An app before overlays in every view (0.27.0) names no copy and no access: fail closed, nothing shown.
      closeQuietly(handle)
      throw new Error('this Jira version needs cc-cockpit 0.27.0 or later')
    }
    const page = makePage(handle, {
      ctx,
      project: (state, from) => ({ ...state, reply: mayReply(from) }),
      // Ask first (D7), then the owner's last used; a read guest has neither tab (the page shows no column).
      tabs: { ids: ['ask', 'reply'], first: 'ask' },
      guestError: 'This issue could not be loaded.',
    })
    const win = { key, handle, page, ended: false, issue: null, text: '', loadSeq: 0, seen: false, selectAt: 0, loaded: null }
    windows.set(key, win)
    const end = () => endWindow(win)
    handle.result.then(end, end)
    page.onMessage((m, from) => onWindowMessage(win, m, from))
    handle.onConnect((from) => onCopy(win, from))
    if (typeof handle.onButton === 'function') handle.onButton('browser', (from) => openFor(browseUrl(cfg().site, key), from))
    if (typeof handle.onDiscuss === 'function') {
      handle.onDiscuss(() => (win.issue ? { text: discussPrompt(win.issue, win.text) } : null))
    }
    // Core's Ask (app 0.28.0): the issue as text for the chat; core already refuses a read guest, and so do we.
    if (typeof handle.onAsk === 'function') handle.onAsk((from) => (writer(from) && win.issue ? { text: win.text } : null))
    return win
  }

  function endWindow(win) {
    if (win.ended) return
    win.ended = true
    if (windows.get(win.key) === win) windows.delete(win.key)
    win.page.dispose()
  }

  /** Read the issue into the window: loading, then the issue, or the error page with Try again (the owner's). */
  async function loadWindow(win) {
    const n = ++win.loadSeq
    const current = () => !win.ended && n === win.loadSeq
    win.page.loading()
    let got
    try {
      got = await fullIssue(win.key)
    } catch (e) {
      if (current()) {
        const msg = e && e.message ? e.message : String(e)
        const head = (e && (e.kind === 'network' || e.kind === 'timeout')) || /^cannot reach /i.test(msg) ? "Can't reach Jira" : 'Could not load the issue'
        win.page.fail(cut(`${head}: ${msg}`, 300), { retry: () => void loadWindow(win).catch((err) => ctx.log.warn(`retry ${win.key}: ${err && err.message}`)) })
      }
      throw e
    }
    if (!current()) return
    const { issue, lane, mark, stale } = got
    const site = cfg().site
    const staleNote = stale ? `Jira could not be reached, this is the copy from the last poll: ${stale}` : ''
    const v = await issueView(got, staleNote, false, {}, true)
    if (!current()) return
    win.issue = issue
    win.text = readableText(issue, { site, mark, lane }) + (stale ? `\n\n(${staleNote})` : '')
    win.got = got
    win.state = { key: issue.key, summary: issue.summary || '', url: browseUrl(site, issue.key), html: v.html, assets: v.assets }
    win.page.set(win.state, { document: v.html })
    if (win.page.copies().some((c) => isOwner(c.from))) await seenOnOpen(win)
  }

  /**
   * Opening marks the issue read only with the markReadOnOpen setting (off by default: an issue opened to glance
   * at it, from Inbox above all, kept the unread mark the person meant as a to-do), once per window, when the
   * issue reached an owner's copy (a guest looking is not the person reading). Read at that moment: a settings
   * change during the read counts. Never throws.
   */
  async function seenOnOpen(win) {
    if (win.seen || !win.got) return
    win.seen = true
    const issue = win.got.issue
    if (!S.seen || !issue.full || !cfg().markReadOnOpen) return
    try {
      markRead(S.seen, issue, now())
      await saveSeen()
      rebuild()
      postState()
      emitFeed()
      void classifyChanged()
    } catch (e) {
      ctx.log.warn(`marking ${win.key} seen: ${e && e.message ? e.message : e}`)
    }
  }

  /** A copy connected: an owner's marks the issue seen; an owner's or a write guest's gets the Reply form. */
  function onCopy(win, from) {
    if (!from || typeof from.copy !== 'string') return
    if (isOwner(from) && win.issue) void seenOnOpen(win)
    if (!mayReply(from)) return
    const form = forms.get(win.key)
    if (form) win.page.post(from.copy, replyMessage(form, false))
    if (win.selectAt && now() - win.selectAt <= SELECT_MS) win.page.post(from.copy, { type: 'select', tab: 'reply' })
  }

  /** Reply selected in every copy that may reply, and in those connecting soon (a window just opened). */
  function selectReply(win) {
    win.selectAt = now()
    const form = formOf(win.key)
    if (!form.loaded && !form.loading) form.loading = loadForm(form, null)
    for (const c of win.page.copies()) if (mayReply(c.from)) win.page.post(c.copy, { type: 'select', tab: 'reply' })
  }

  /** What a window's page says (the kit's own messages are handled by makePage). `from` is the app's. */
  function onWindowMessage(win, m, from) {
    if (!m || typeof m !== 'object' || win.ended) return
    switch (m.type) {
      case 'replyOpen': {
        // The Reply tab was shown: its issue header and moves are read then, not on every open.
        if (!mayReply(from)) return
        const form = formOf(win.key)
        if (!form.loaded && !form.loading) form.loading = loadForm(form, null)
        else win.page.post(from.copy, replyMessage(form, false))
        return
      }
      case 'edit':
        return editForm(win, m, from)
      case 'post':
        return void postForm(win, m, from).catch((e) => ctx.log.warn(`post ${win.key}: ${e && e.message ? e.message : e}`))
      case 'reload': {
        if (!mayReply(from)) return
        const form = formOf(win.key)
        if (!form.busy && !form.loading) form.loading = loadForm(form, null)
        return
      }
      case 'browser':
        return void openFor(browseUrl(cfg().site, win.key), from)
    }
  }

  /** An http(s) address in the clicking view (the app's link ask there); a missing view opens where the app decides. */
  async function openFor(url, from) {
    if (typeof ctx.openExternal !== 'function') return openUrl(url)
    try {
      await ctx.openExternal(url, from && typeof from.view === 'string' ? { view: from.view } : undefined)
    } catch (e) {
      setNotice(`Could not open ${url}: ${e && e.message ? e.message : e}`, 'error')
    }
  }

  // ---- parts: an issue beside another plugin's window (D13) ----
  //
  // Gmail and Calendar announce what their window shows (`handle.announce({ kind: 'mail' | 'event', refs })`); a ref
  // that is an issue key of a project this plugin knows gets our own part beside their page: a compact issue with
  // Open issue. Their page never sees it (its own frame), and the refs are their data: checked here.

  const partsOf = new Map() // parent overlay id -> { key, handle, page }
  const ANNOUNCE_KINDS = ['mail', 'event']
  // Announcements that named no issue of a project we know yet (a mail opened before the first poll, or while the
  // settings were not ready): kept by overlay id and looked at again after a poll, the stored state's load and a
  // settings change (QA F6: onAnnounce decided once, and the mail never got its part). The app tells a listener of
  // no announcement's end, so an entry goes when it gets a part, when a newer announcement of its overlay replaces it,
  // or past PENDING_MAX (the oldest first); one whose overlay ended meanwhile is refused at part() and dropped then.
  const pendingAnnounce = new Map() // overlay id -> announcement
  const PENDING_MAX = 100

  /** The project keys this plugin knows: the polled issues' and the Mentioned setting's. */
  function knownProjects() {
    const out = new Set(cfg().mentionProjects || [])
    const add = (key) => {
      const k = typeof key === 'string' ? key.split('-')[0] : ''
      if (k) out.add(k)
    }
    for (const name of ['assigned', 'done', 'candidates']) for (const h of (S.lists && S.lists[name]) || []) add(h && h.key)
    if (S.cache && S.cache.issues) for (const k of Object.keys(S.cache.issues)) add(k)
    return out
  }

  /** The first ref that is an issue key of a known project, or null (refs are another plugin's words). */
  function issueRefOf(refs) {
    if (!Array.isArray(refs) || !S.settings.ready) return null
    const projects = knownProjects()
    for (const r of refs.slice(0, 20)) {
      if (typeof r !== 'string' || r.length > 200) continue
      const key = issueKey(r.trim())
      if (key && projects.has(key.split('-')[0])) return key
    }
    return null
  }

  function onAnnounce(a) {
    if (S.stopped || !a || typeof a !== 'object' || !a.overlay || typeof a.overlay.id !== 'string') return
    // Our own windows never get a part of ours.
    if (a.overlay.opener === ctx.pluginId) return
    const id = a.overlay.id
    const key = issueRefOf(a.refs)
    pendingAnnounce.delete(id)
    if (!key && Array.isArray(a.refs) && a.refs.length) {
      pendingAnnounce.set(id, a)
      if (pendingAnnounce.size > PENDING_MAX) pendingAnnounce.delete(pendingAnnounce.keys().next().value)
    }
    const had = partsOf.get(id)
    if (had && had.key === key) return
    if (had) {
      partsOf.delete(id)
      closeQuietly(had.handle)
    }
    if (!key) return
    let handle
    try {
      handle = ctx.overlay.part(id, { file: 'panels/part.html', title: `Jira ${key}` })
    } catch (e) {
      ctx.log.info(`no part for ${key}: ${e && e.message ? e.message : e}`)
      return
    }
    if (typeof handle.onConnect !== 'function') return closeQuietly(handle)
    const page = makePage(handle, { ctx, project: (state, from) => ({ ...state, canOpen: isOwner(from) }), tabs: { ids: [] } })
    const part = { key, handle, page, issue: null, text: '' }
    partsOf.set(id, part)
    const end = () => {
      if (partsOf.get(id) === part) partsOf.delete(id)
      page.dispose()
    }
    handle.result.then(end, end)
    // Open issue: the owner's click only (it opens a window on the owner's screen); never a write.
    page.onMessage((m, from) => {
      if (m && m.type === 'open' && isOwner(from)) void openIssue(key).catch((e) => setNotice(e && e.message ? e.message : String(e), 'error'))
    })
    const text = async () => {
      if (!part.text) {
        const got = await fullIssue(key)
        part.text = readableText(got.issue, { site: cfg().site, mark: got.mark, lane: got.lane })
      }
      return { text: part.text }
    }
    if (typeof handle.onDiscuss === 'function') handle.onDiscuss(() => text())
    if (typeof handle.onAsk === 'function') handle.onAsk((from) => (writer(from) ? text() : null))
    void serviceIssue(key, {}, ctx.pluginId).then(
      (f) => {
        if (partsOf.get(id) !== part) return
        const state = { key: f.key, summary: f.summary, status: f.status, tone: wr.toneOf(f.category), priority: f.priority, type: f.type, assignee: f.assignee, url: f.url }
        page.set(state, { document: f.url })
      },
      (e) => page.fail(cut(`Could not read ${key}: ${e && e.message ? e.message : e}`, 300))
    )
  }

  /** The kept announcements whose refs now name a known project's issue get their part (still checked by issueRefOf). */
  function recheckAnnouncements() {
    if (S.stopped || !pendingAnnounce.size || !S.settings.ready) return
    for (const a of [...pendingAnnounce.values()]) if (issueRefOf(a.refs)) onAnnounce(a)
  }

  if (ctx.overlay && typeof ctx.overlay.onAnnounce === 'function' && typeof ctx.overlay.part === 'function') {
    for (const kind of ANNOUNCE_KINDS) ctx.overlay.onAnnounce(kind, (a) => onAnnounce(a))
  }


  /** The `inbox-item` type of an issue overlay (Inbox's and the buttons' key). */
  function overlayType(key) {
    return { name: 'inbox-item', data: { source: ctx.pluginId, id: key } }
  }
  /**
   * The feed item an `inbox-item` overlay of ours names, or null (the data came from the opener: check it).
   * Only an issue still in the lanes counts: one that left them (Done lane, a lane switched off) is no item
   * Inbox shows, so its overlay gets no buttons, as `act` refuses it.
   */
  function ownItem(info) {
    if (!info || !trustedOpener(info.opener)) return null
    const d = info.type && info.type.data
    if (!d || typeof d !== 'object' || d.source !== ctx.pluginId || typeof d.id !== 'string') return null
    return feedItemOf(d.id)
  }

  /**
   * Whether an overlay's opener may get our item buttons: only we. `opener` is the app's record of who opened it
   * (OverlayInfo), unlike `data`: another plugin opening an overlay that names one of our issues gets none.
   */
  function trustedOpener(opener) {
    return opener === ctx.pluginId
  }

  /**
   * The item's actions but open (Mark read, Mark unread), with `run` = the same code as the feed's `act`; labels
   * follow the item's state. A refused act is shown in the panel's notice and thrown: the app only logs a run that
   * throws, and an answer it does not read would make a failed Mark read silent. Reply is the window's own tab.
   */
  function overlayButtons(info) {
    const item = ownItem(info)
    if (!item) return []
    const run = async (action) => {
      const r = await feedAct(item.id, action)
      if (r && r.ok === false) {
        setNotice(r.message, 'error')
        throw new Error(r.message)
      }
    }
    return item.actions.filter((a) => a.id !== 'open').map((a) => ({ id: a.id, label: a.label, run: () => run(a.id) }))
  }

  if (ctx.overlay && typeof ctx.overlay.buttons === 'function') {
    // Dropped by the app when the plugin stops.
    ctx.overlay.buttons('inbox-item', (info) => overlayButtons(info))
  }

  /** Resolves null once an overlay is up (no refusal within OVERLAY_SETTLE_MS, or it already ended), else main's refusal. */
  function overlayRefusal(handle) {
    let timer
    const wait = new Promise((resolve) => (timer = setTimeout(resolve, io.overlaySettleMs === undefined ? OVERLAY_SETTLE_MS : io.overlaySettleMs, null)))
    return Promise.race([handle.result.then(() => null, (e) => e || new Error('refused')), wait]).finally(() => clearTimeout(timer))
  }

  /**
   * The issue as HTML plus the image assets: the image attachments chosen by images.selectImages,
   * from the cache or downloaded with the token, waited for at most WAIT_MS. With the cached copy
   * (Jira unreachable) only cached images are used. `fold` (the issue window): the header card keeps the key
   * facts as pills and folds the rest under More details (lib/document.js).
   */
  async function issueView({ issue, raw, lane, mark, stale }, note, withAside, budget = {}, fold = false) {
    const attachments = raw ? attachmentsOf(raw) : issue.attachments || []
    // `budget` (the jira service's document(): another plugin embeds the issue) can only lower the limits.
    const { wanted } = budget.maxImages === 0 ? { wanted: [] } : selectImages(attachments, { ...(budget.maxImages ? { max: budget.maxImages } : {}), ...(budget.maxImageChars ? { totalChars: budget.maxImageChars } : {}) })
    let assets = []
    let byAttachment = new Map()
    if (wanted.length) {
      const r = await gatherImages({
        wanted,
        download: stale ? null : (a, signal) => client().attachment(a.id, { maxBytes: MAX_IMAGE_BYTES, signal: signal || abort.signal, timeoutMs: IMAGE_TIMEOUT_MS }),
        cache: imgCache(),
        waitMs: budget.waitMs !== undefined ? Math.min(budget.waitMs, io.imageWaitMs === undefined ? WAIT_MS : io.imageWaitMs) : io.imageWaitMs === undefined ? WAIT_MS : io.imageWaitMs,
        signal: abort.signal,
        ...(budget.maxImageChars ? { totalChars: budget.maxImageChars } : {}),
      })
      assets = r.assets
      byAttachment = r.byAttachment
      for (const f of r.failed) ctx.log.warn(`image ${f.id} of ${issue.key}: ${f.message}`)
      if (r.late) ctx.log.info(`${issue.key}: ${r.late} image(s) not downloaded in time, shown as links (cached for the next open)`)
    }
    const doc = issueDocument({ issue, raw, site: cfg().site, mark, lane, assets: byAttachment, note, aside: Boolean(withAside), fold, ...(budget.maxHtmlBytes ? { maxBytes: budget.maxHtmlBytes } : {}) })
    return { html: doc.html, assets, aside: doc.aside }
  }


  async function issuePrompt(key) {
    const { issue, lane, mark } = await fullIssue(key)
    return { issue, prompt: discussPrompt(issue, readableText(issue, { site: cfg().site, mark, lane })) }
  }

  async function discuss(key, tabId) {
    const pick = pickTab(await ctx.sessions.list(), tabId)
    if (pick.error) return setNotice(pick.error, 'error')
    if (pick.choose) {
      S.choose = { key, tabs: pick.choose }
      return postState()
    }
    S.choose = null
    const { prompt } = await issuePrompt(key)
    const r = await ctx.sessions.send(pick.tabId, prompt)
    setNotice(r && r.delivered ? `Sent ${key} to "${pick.label}".` : `Queued for "${pick.label}": it gets ${key} when Claude is waiting for input.`)
  }

  async function newSession(key) {
    const { prompt } = await issuePrompt(key)
    // The person clicked New session: the window shows the tab (an older app ignores `focus`).
    await ctx.sessions.open({ prompt, focus: true })
    setNotice(`Opened a new Claude tab about ${key}.`)
  }

  async function openBrowser(key) {
    return openUrl(browseUrl(cfg().site, key))
  }

  /** An http(s) address in the system browser (Open in Jira ↗, a link in the issue window). */
  async function openUrl(url) {
    if (!/^https?:\/\//i.test(url)) return setNotice(`Only web links open from here; the address: ${cut(url, 300)}`)
    // cc-cockpit 0.9.1+: the app opens it, as it opens any link. A plugin host's environment has
    // no display or desktop session variables, so xdg-open run from here finds no browser on Linux.
    if (typeof ctx.openExternal === 'function') {
      try {
        await ctx.openExternal(url)
      } catch (e) {
        setNotice(`Could not open ${url}: ${e && e.message ? e.message : e}`, 'error')
      }
      return
    }
    const argv = openerArgv(platform, url)
    if (!argv) return setNotice(`Open ${url} in your browser (no opener on this system).`)
    const r = await ctx.exec(argv, { timeoutMs: 15000 })
    if (r.code !== 0) setNotice(`${argv[0]} failed (${r.code}): ${oneLine(r.stderr) || 'no output'}. The address: ${url}`, 'error')
  }

  async function wrong(key, priority) {
    if (!['urgent', 'action', 'fyi', 'noise'].includes(priority)) return
    await triage.override(SOURCE, key, { priority })
    delete S.sigs[key]
    await classifyChanged(new Set([key]))
    setNotice(`${key} is now ${priority} (your correction). Record why with Wrong? in the Jev triage panel, so it becomes a case for its eval.`)
  }

  async function undoWrong(key) {
    const had = await triage.clear(SOURCE, key)
    delete S.sigs[key]
    await classifyChanged(new Set([key]))
    setNotice(had ? `${key}: your correction is gone.` : `${key} had no correction.`)
  }


  // ---- writing to Jira (0.8.0; design "Writing to Jira"; 0.9.0: the issue window's Reply tab) ----
  //
  // A comment and/or a status change on one issue, made only from the Reply tab of the issue's window, by a
  // person's click. `ccc jira update` prepares a draft there (writes: draft, the default) or writes itself (direct)
  // or is refused (off); the setting is read on every call, for every caller, here in the host: a description can
  // tell Claude to close the ticket, and a skill or a permission rule on Claude's side can be walked around. Every
  // click that writes is checked against the app's `from.access` (owner or write guest; a missing `from` refuses).
  //
  // One form per issue (`forms`), kept here over Esc and shared by every owner and write-guest copy: an edit in
  // one copy reaches the others (last write wins), and "edited" means any copy typed, so a draft from ccc never
  // replaces anyone's words. A read guest's copy never gets the form. A Post is taken only when the values it carries
  // are the form's (a draft or another copy's edit that came in between refuses it): the click binds to what was shown.

  const forms = new Map() // issue key -> form
  const FORMS_MAX = 50 // unsent forms kept; the oldest untouched one goes first (a form holding a draft is never one)
  const FORM_TEXT_MAX = 100000 // what a page may put in the comment box here (Post refuses past wr.MAX_COMMENT)

  function mayWriteOrNotice(from) {
    if (writer(from)) return true
    setNotice('Only the owner or a guest with write access can write to Jira.', 'error')
    return false
  }

  /** `p`, or `fallback` after `ms` (a wait that must not hold a CLI answer forever). */
  function settleWithin(p, ms, fallback) {
    let timer
    return Promise.race([p, new Promise((r) => (timer = setTimeout(r, ms, fallback)))]).finally(() => clearTimeout(timer))
  }

  /** The transitions as the page lists them (plain data; the page builds the options with replylogic.moveOption). */
  const pageTransitions = (list) => list.map((t) => ({ id: t.id, name: t.name, to: t.to, enabled: t.enabled, why: t.why }))

  /**
   * The form of `key`, made empty when there is none (the oldest untouched one goes past FORMS_MAX). Untouched means
   * empty too: a `ccc jira update` draft is `edited: false` (no copy typed it), yet it is Claude's words waiting for
   * the person (S10, a Reply draft survives Esc), so a form with a comment, a move or a marker is never dropped; past
   * FORMS_MAX with nothing empty to drop, the map grows until a Post or a settings change empties forms.
   */
  function formOf(key) {
    let form = forms.get(key)
    if (form) return form
    form = { key, comment: '', transitionId: '', marker: '', asked: '', edited: false, busy: false, v: 0, loaded: false, loading: null, loadError: '', status: '', tone: 'neutral', transitions: [], note: null }
    forms.set(key, form)
    if (forms.size > FORMS_MAX) {
      const old = [...forms.values()].find((f) => f !== form && !f.edited && !f.busy && !windows.has(f.key) && !f.comment && !f.transitionId && !f.marker)
      if (old) forms.delete(old.key)
    }
    return form
  }

  /** The form as a copy gets it; `own`: the copy whose edit this answers keeps its own fields (it may have typed on). */
  function replyMessage(form, own) {
    return {
      type: 'reply',
      v: form.v,
      ...(own ? { own: true } : { comment: form.comment, transitionId: form.transitionId }),
      marker: form.marker,
      asked: form.asked,
      edited: form.edited,
      busy: form.busy,
      loaded: form.loaded,
      loadError: form.loadError,
      status: form.status,
      tone: form.tone,
      transitions: pageTransitions(form.transitions),
      max: wr.MAX_COMMENT,
      note: form.note,
    }
  }

  /** The form to every copy of the issue's window that may reply; `own` names the copy that made the change. */
  function syncForm(form, own) {
    const win = windows.get(form.key)
    if (!win || win.ended) return
    for (const c of win.page.copies()) if (mayReply(c.from)) win.page.post(c.copy, replyMessage(form, c.copy === own))
  }

  /** A line for one copy only (a refused click): the form is unchanged. */
  function noteTo(win, from, text) {
    win.page.post(from.copy, { type: 'replyNote', kind: 'error', text: cut(oneLine(text), 600) })
  }

  /**
   * Read the issue's header and moves for the form (each time Reply opens or a draft fills it: workflows differ per
   * project and status). With `fill` (a draft) the form takes it, unless a copy typed or another fill came while
   * the issue was read (`applied: false`). Resolves `{ ok, applied, asked, error }`; never rejects.
   */
  async function loadForm(form, fill) {
    const v0 = form.v
    let head
    let transitions
    try {
      await ready
      ;[head, transitions] = await Promise.all([client().issueHeader(form.key, abort.signal), client().transitions(form.key, abort.signal)])
    } catch (e) {
      const message = e && e.message ? e.message : String(e)
      form.loadError = cut(oneLine(message), 400)
      form.loading = null
      syncForm(form)
      return { ok: false, error: message }
    } finally {
      if (forms.get(form.key) !== form) forms.set(form.key, form)
    }
    form.loading = null
    const h = header(head.key, head.fields)
    form.status = h.status
    form.tone = wr.toneOf(h.category)
    form.transitions = transitions
    form.loaded = true
    form.loadError = ''
    let asked = ''
    let applied = true
    if (fill) {
      if (form.v !== v0 || form.busy) applied = false
      else {
        let transitionId = ''
        if (fill.status) {
          const m = wr.matchStatus(transitions, fill.status)
          if (m.transition) transitionId = m.transition.id
          else asked = wr.statusProblem(m, fill.status, transitions)
        }
        Object.assign(form, { comment: fill.comment || '', transitionId, marker: fill.marker || '', asked: asked ? `Asked to move: ${asked}` : '', edited: false, note: null })
        form.v++
      }
    } else form.transitionId = keepChoice(transitions, form.transitionId)
    syncForm(form)
    return { ok: true, applied, asked }
  }

  /** A copy typed or chose: the form takes it (last write wins) and the other copies follow. */
  function editForm(win, m, from) {
    if (!mayReply(from)) return
    const form = formOf(win.key)
    if (form.busy) return
    form.comment = typeof m.comment === 'string' ? m.comment.slice(0, FORM_TEXT_MAX) : ''
    form.transitionId = typeof m.transitionId === 'string' ? m.transitionId.slice(0, 200) : ''
    form.edited = true
    form.note = null
    form.v++
    syncForm(form, from.copy)
  }

  const DRAFT_CHANGED = 'The draft just changed: read it again and click once more. Nothing was written.'

  /**
   * Post: what the clicking copy holds, which must be the form (its own edits came first on its port; anything
   * else in between is a draft or another copy's words it had not seen). Then the comment and the move
   * (lib/write.js performWrite: the transitions read again first; a move that is gone or a status that changed
   * writes nothing). The values are checked as input: a comment within the limit, a transition id we listed and
   * that is enabled. A read guest is refused by `from.access`, whatever its page drew.
   */
  async function postForm(win, m, from) {
    if (!writer(from)) {
      if (from && typeof from.copy === 'string') noteTo(win, from, 'Only the owner or a guest with write access can post.')
      return
    }
    const fail = (text) => noteTo(win, from, text)
    if (!writesOn()) return fail(`Not posted: ${wr.OFF_MESSAGE}.`)
    const form = forms.get(win.key)
    if (!form || form.busy) return
    if (!form.loaded) return fail(`${win.key} is not read yet; nothing was written.`)
    const rawComment = typeof m.comment === 'string' ? m.comment : ''
    const transitionId = typeof m.transitionId === 'string' ? m.transitionId : ''
    if (rawComment !== form.comment || transitionId !== form.transitionId) return fail(DRAFT_CHANGED)
    let comment = ''
    if (rawComment.trim()) {
      const c = wr.checkComment(rawComment)
      if (c.error) return fail(`Not posted: ${c.error}.`)
      comment = c.text
    }
    if (transitionId && !form.transitions.some((t) => t.id === transitionId && t.enabled)) return fail('That move is not in the list any more; choose again. Nothing was written.')
    if (!comment && !transitionId) return fail('Nothing to post: write a comment or choose a status.')
    form.busy = true
    form.note = { kind: 'info', text: 'Writing to Jira…' }
    syncForm(form)
    try {
      const r = await wr.performWrite({ client: client(), key: form.key, comment, transitionId, expectStatus: transitionId ? form.status : undefined, guard: writeGuard(null), signal: abort.signal })
      if (r.moved) {
        form.transitions = r.transitions || form.transitions
        if (r.status !== undefined) {
          form.status = r.status
          form.tone = wr.toneOf(r.category)
        }
        form.transitionId = keepChoice(form.transitions, transitionId)
        form.note = { kind: 'error', text: r.error || 'The issue changed meanwhile; nothing was written. Choose again.' }
        return
      }
      if (!r.steps.length) {
        form.note = { kind: 'error', text: cut(oneLine(r.error || 'Nothing was written.'), 600) }
        return
      }
      const commentPosted = r.steps.some((x) => x.step === 'comment' && x.ok)
      if (r.steps.some((x) => x.ok)) await afterWrite(form.key)
      const lines = wr.stepLines(form.key, r.steps)
      if (r.ok) {
        setNotice(lines.join('. ') + '.')
        // Done: the form starts over (the window stays, now showing the new comment and status).
        Object.assign(form, { comment: '', transitionId: '', marker: '', asked: '', edited: false, note: { kind: 'info', text: lines.join('. ') + '.', steps: r.steps } })
        form.v++
        if (!win.ended) void loadWindow(win).catch(() => {})
        if (!form.loading) form.loading = loadForm(form, null)
        return
      }
      // Partial or failed: each step says how it went; a posted comment leaves the box (it is in Jira now), the
      // status choice stays for a retry, against a fresh list.
      if (commentPosted) form.comment = ''
      if (r.steps.some((x) => x.ok)) {
        try {
          const [head, list] = await Promise.all([client().issueHeader(form.key, abort.signal), client().transitions(form.key, abort.signal)])
          const fresh = header(head.key, head.fields)
          form.status = fresh.status
          form.tone = wr.toneOf(fresh.category)
          form.transitions = list
        } catch (e) {
          ctx.log.warn(`re-reading ${form.key} after a partial write: ${e && e.message ? e.message : e}`)
        }
      }
      form.transitionId = keepChoice(form.transitions, transitionId)
      form.note = { kind: 'error', text: lines.join('\n'), steps: r.steps }
      if (commentPosted) form.v++
    } catch (e) {
      form.note = { kind: 'error', text: cut(oneLine(e && e.message ? e.message : String(e)), 600) }
    } finally {
      form.busy = false
      if (forms.get(form.key) !== form) forms.set(form.key, form)
      syncForm(form)
    }
  }

  /**
   * `ccc jira update` in draft mode: the issue's window with Reply selected and the form filled, unless a copy typed
   * in it or a Post is under way (wr.draftDecision: their words are never replaced). `{ decision, load }`.
   */
  async function draftReply(key, draft) {
    await ready
    if (!S.settings.ready) throw notConfigured()
    if (!writesOn()) throw new Error(wr.OFF_MESSAGE)
    const existing = forms.get(key) || null
    const decision = wr.draftDecision(existing)
    if (decision === 'refuse') return { decision }
    const form = formOf(key)
    const load = loadForm(form, draft)
    form.loading = load
    await showWindow(key, { reply: true })
    return { decision, load }
  }

  /**
   * After a write: the issue read again (the cache and the lists the lanes are built from), its seen
   * mark moved to its new `updated` (the person's own change is never unread; unread already ignores
   * their own comments, and a status change of theirs is theirs too), the feed told, triage asked
   * again, and a poll for what the change moved (a Done issue's lane). A failed read is logged: the
   * write itself happened, the next poll catches up. The person's own Mark unread flag stays.
   */
  async function afterWrite(key) {
    try {
      if (!S.cache) await loadSiteState()
      if (!S.cache.me) S.cache.me = await client().myself(abort.signal)
      const raw = await client().issue(key, abort.signal)
      const fresh = header(raw.key, raw.fields)
      for (const name of ['assigned', 'done', 'candidates']) {
        const list = S.lists && S.lists[name]
        if (!Array.isArray(list)) continue
        const i = list.findIndex((x) => x.key === key)
        // closedAt comes from the Done search's own fields, which a full read does not ask for.
        if (i >= 0) list[i] = { ...fresh, closedAt: fresh.closedAt || list[i].closedAt || 0 }
      }
      const kept = compact(raw, S.cache.me.accountId)
      if (rowOf(key) || S.cache.issues[key]) S.cache.issues[key] = kept
      S.written.set(key, { gen: ++S.writeGen, header: fresh, issue: kept })
      if (S.seen) {
        S.seen.marks[key] = Math.max(S.seen.marks[key] || 0, fresh.updatedAt || now())
        bound(S.seen)
      }
      await Promise.all([saveCache(), S.seen ? saveSeen() : null])
    } catch (e) {
      ctx.log.warn(`reading ${key} again after the write failed: ${e && e.message ? e.message : e}`)
    }
    // The service's cached answers may name the old status.
    lookups.clear()
    rebuild()
    postState()
    emitFeed()
    void classifyChanged()
    void pollNow('write')
  }

  /**
   * Checked right before each POST of a write (review R1-2): the settings may have changed during the
   * reads before it. Writing switched off, the site, email or token changed (the client in hand is the
   * old one), or for `ccc` direct the mode no longer `direct`: the write stops there.
   */
  function writeGuard(needMode) {
    const conn = connectionKey(cfg())
    return () => {
      if (S.stopped) return 'the plugin stopped'
      const mode = cfg().writes
      if (mode === 'off') return wr.OFF_MESSAGE
      if (needMode && mode !== needMode) return `the writes setting changed to ${mode}`
      if (connectionKey(cfg()) !== conn) return 'the Jira settings (site, email or token) changed meanwhile'
      return null
    }
  }

  /**
   * `ccc jira update` once cli.js parsed and checked it: the setting read again here (a change since
   * cli.js asked counts), then the draft in the issue's window or the direct write. `{ code, text }`.
   */
  async function cliUpdate(key, o) {
    const mode = cfg().writes
    if (mode === 'off') return { code: 1, text: wr.OFF_MESSAGE }
    if (mode === 'draft') {
      let tab = null
      if (o.tabId) tab = (await ctx.sessions.list().catch(() => [])).find((t) => t && t.tabId === o.tabId) || null
      const r = await draftReply(key, { comment: o.comment || '', status: o.status || null, marker: wr.draftMarker(o.tabId, tab) })
      const editing = `The person is editing a reply to ${key}: their words were left alone and this draft was not opened. Nothing was written.`
      if (r.decision === 'refuse') return { code: 1, text: editing }
      const loaded = await settleWithin(r.load, draftWaitMs, { ok: true, late: true })
      if (loaded && loaded.applied === false) return { code: 1, text: editing }
      const lines = [`Draft opened for ${key}: the person posts it.`]
      if (loaded && loaded.asked) lines.push(`The status was left at Keep status: ${loaded.asked}`)
      if (loaded && loaded.error) lines.push(`Could not read ${key} from Jira: ${oneLine(loaded.error)}`)
      if (loaded && loaded.late) lines.push('The window is still reading the issue.')
      lines.push('Nothing was written: the person decides in the Reply tab. Do not run this again to post it.')
      return { code: 0, text: lines.join('\n') }
    }
    // direct: the client and the settings it was asked under, taken before the first await and kept
    // for the whole write (review R2-1): settings changed during the reads stop it (the guard), and
    // a replacement token or site set meanwhile is never the one that writes.
    const c = client()
    const guard = writeGuard('direct')
    // An unknown or disabled status is refused before anything is written.
    let transitionId = ''
    let fresh
    if (o.status) {
      fresh = await c.transitions(key, o.signal)
      const m = wr.matchStatus(fresh, o.status)
      if (!m.transition) return { code: 1, text: `${key}: ${wr.statusProblem(m, o.status, fresh)} Nothing was written.` }
      transitionId = m.transition.id
    }
    const comment = o.comment ? wr.checkComment(o.comment).text || '' : ''
    const r = await wr.performWrite({ client: c, key, comment, transitionId, fresh, guard, signal: o.signal })
    if (r.steps.some((x) => x.ok)) await afterWrite(key)
    const lines = r.steps.length ? wr.stepLines(key, r.steps) : [`${key}: ${r.error || 'nothing was written'}`]
    return { code: r.ok ? 0 : 1, text: lines.join('\n') }
  }

  // ---- the jira service (v1; design "The jira service") ----
  //
  // Other plugins of this project (bronos.gmail: is this mail about a Done issue? the issue below the
  // mail) ask through `ctx.services.use('jira')`. Answers come from the last poll when it is recent
  // enough for the caller, else from a cache of earlier lookups, else from one small read of the
  // issue's header fields; Jira is never asked faster than the limits in lib/service.js allow.

  const lookups = svc.createTtlCache(svc.LOOKUP_CACHE) // `<site> <key>` -> { at, value } | { at, error }
  const inflight = new Map() // the same key asked twice at once: one request
  const lookupLimit = svc.createLimiter({ ...svc.LIMITS.lookup, now })
  const documentLimit = svc.createLimiter({ ...svc.LIMITS.document, now })
  const DOCUMENT_MAX = { html: HTML_MAX_BYTES, images: MAX_IMAGES, imageChars: MAX_TOTAL_CHARS, waitMs: WAIT_MS }

  function caller() {
    try {
      return (typeof ctx.services.caller === 'function' && ctx.services.caller()) || 'a plugin'
    } catch {
      return 'a plugin'
    }
  }

  function notConfigured() {
    const what = [...S.settings.missing, ...S.settings.problems.filter((p) => p.startsWith('site:') || p.startsWith('email:')).map((p) => p.split(':')[0])]
    return new Error(`jira: the Jira plugin is not configured in this project${what.length ? ` (${[...new Set(what)].join(', ')})` : ''}`)
  }

  /** The header of a key in the last poll's lists (assigned, Done, mention candidates), or null. */
  function polledHeader(key) {
    if (!S.lists) return null
    for (const list of [S.lists.assigned, S.lists.done, S.lists.candidates]) {
      const h = (list || []).find((x) => x.key === key)
      if (h) return h
    }
    return null
  }

  function factsOf(h, source, at) {
    const me = S.cache && S.cache.me ? S.cache.me.accountId : ''
    const row = rowOf(h.key)
    const mine = Boolean(me) && h.assigneeId === me
    const lane = row ? row.lane : mine ? statusLane(h, cfg().onHold) : null
    return svc.issueFacts(h, { me, browse: browseUrl(cfg().site, h.key), lane, source, at })
  }

  async function serviceSite() {
    await ready
    const c = cfg()
    const me = S.cache && S.cache.me
    return {
      ready: S.settings.ready,
      site: S.settings.ready ? c.site : '',
      senders: S.settings.ready ? mailSendersOf(c) : [],
      account: me ? { accountId: me.accountId, displayName: me.displayName || '' } : null,
      ...(S.settings.ready ? {} : { error: notConfigured().message }),
    }
  }

  async function serviceIssue(rawKey, opts, who) {
    const key = svc.checkKey(rawKey)
    const { maxAgeMs } = svc.issueOptions(opts)
    await ready
    if (!S.settings.ready) throw notConfigured()
    const t = now()
    // The last poll's search, when it is as fresh as the caller wants (and the account is known).
    if (S.cache && S.cache.me && t - S.lastPoll <= maxAgeMs) {
      const h = polledHeader(key)
      if (h) return factsOf(h, 'poll', S.lastPoll)
    }
    const ck = `${cfg().site} ${key}`
    const hit = lookups.get(ck)
    if (hit && t - hit.at <= (hit.error ? Math.min(maxAgeMs, svc.NEGATIVE_MS) : maxAgeMs)) {
      if (hit.error) throw new Error(hit.error)
      return factsOf(hit.value, 'fetch', hit.at)
    }
    if (inflight.has(ck)) return inflight.get(ck)
    const p = lookupLimit
      .run(async () => {
        if (!S.cache) await loadSiteState()
        if (!S.cache.me) S.cache.me = await client().myself(abort.signal)
        const raw = await client().issueHeader(key, abort.signal)
        return header(raw.key, raw.fields)
      })
      .then(
        (h) => {
          const at = now()
          lookups.set(ck, { at, value: h })
          return factsOf(h, 'fetch', at)
        },
        (e) => {
          const err = svc.serviceError(e)
          // Jira's answer for this key (none, or not yours to see) is kept; a busy refusal or a network
          // failure is not, so the next call tries again.
          if (e && (e.kind === 'notfound' || e.kind === 'forbidden')) lookups.set(ck, { at: now(), error: err.message })
          if (/^jira: (too many|busy)/.test(err.message)) ctx.log.warn(`jira service: refused a lookup of ${key} for ${who}: ${err.message}`)
          throw err
        },
      )
      .finally(() => inflight.delete(ck))
    inflight.set(ck, p)
    return p
  }

  async function serviceDocument(rawKey, opts, who) {
    const key = svc.checkKey(rawKey)
    const budget = svc.documentOptions(opts, DOCUMENT_MAX)
    await ready
    if (!S.settings.ready) throw notConfigured()
    try {
      return await documentLimit.run(async () => {
        const got = await fullIssue(key)
        const note = got.stale ? `Jira could not be reached, this is the copy from the last poll: ${got.stale}` : ''
        // Not marked read: another plugin showing the issue is not the person opening it here.
        const v = await issueView(got, note, true, budget)
        const k = got.issue.key
        return { key: k, title: `${k}: ${oneLine(got.issue.summary)}`, url: browseUrl(cfg().site, k), html: v.html, aside: v.aside || '', assets: v.assets, ...(got.stale ? { stale: got.stale } : {}) }
      })
    } catch (e) {
      const err = svc.serviceError(e)
      if (/^jira: (too many|busy)/.test(err.message)) ctx.log.warn(`jira service: refused the document of ${key} for ${who}: ${err.message}`)
      throw err
    }
  }

  /**
   * `openIssue(key, { reply? })` for another plugin (Gmail's Open issue): the window as a row click opens
   * it, resolved once it is up (`{ opened: true }`), not when the issue is read. The caller is another
   * plugin acting on the person's click; the app's overlay limits (open windows, opens a minute) apply.
   */
  async function serviceOpenIssue(rawKey, opts, who) {
    const key = svc.checkKey(rawKey)
    const reply = Boolean(opts && typeof opts === 'object' && opts.reply === true)
    try {
      await showWindow(key, { reply })
      return { opened: true }
    } catch (e) {
      ctx.log.info(`jira service: openIssue ${key} for ${who}: ${e && e.message ? e.message : e}`)
      throw svc.serviceError(e)
    }
  }

  if (typeof ctx.services.provide === 'function') {
    ctx.services.provide('jira', {
      site: () => serviceSite(),
      // The caller is read before the first await (it names who a refusal in the log was for).
      issue: (key, opts) => serviceIssue(key, opts, caller()),
      document: (key, opts) => serviceDocument(key, opts, caller()),
      // v2 (0.9.0): the issue's window, as a click on a row opens it; `reply` selects the Reply tab.
      openIssue: (key, opts) => serviceOpenIssue(key, opts, caller()),
    })
  }

  // ---- the inbox-feed service (v2; Inbox's contract, lib/feed.js) ----
  //
  // Inbox (and any plugin that collects `inbox-feed`) reads the issues the panel shows. Answers come
  // from the cache the panel draws from, never from Jira. Jira's seen marks are the plugin's own:
  // markRead / markUnread go through `setRead`, the panel's own path.

  const feedSt = { sent: new Map(), key: null, started: false } // what Inbox was last told: id -> item, and the Sync state it carried

  /** The items of the scope (`limit`: the contract's 1000 by default; `only`: just that id). */
  function feedList(limit, only) {
    return feed.feedItems(allRows(S.view), { mentionedBy, since: now() - cfg().mentionDays * 86400000, limit, only })
  }

  /**
   * One feed item by id, or null: the item feedList(Infinity) holds, without building and sorting
   * every other one (main asks the overlay buttons after every click and setButtons).
   */
  function feedItemOf(id) {
    return feedList(Infinity, id)[0] || null
  }

  /** `ok`, `signedOut` or `error`, with the message the Sync carries. */
  function feedState() {
    // Not set up: nothing was ever read. Jira refused the token (expired, revoked): the cached items
    // still come, marked signed out.
    if (!S.settings.ready) return { state: 'signedOut', message: feed.feedMessage(`Jira is not configured (${missingText(S.settings.missing).join(', ') || S.settings.problems.join('; ')})`) }
    if (S.error && S.errorKind === 'auth') return { state: 'signedOut', message: feed.feedMessage(S.error) }
    if (S.error) return { state: 'error', message: feed.feedMessage(S.error) }
    return { state: 'ok' }
  }

  /** The state as one comparable string: a change of kind or of message is news to Inbox's source line. */
  const stateKey = (st) => `${st.state}|${st.message || ''}`

  /** The Sync: the whole list from the cache, and the baseline the next diff starts from. */
  function feedSync() {
    const items = feedList()
    const st = feedState()
    feedSt.sent = new Map(items.map((i) => [i.id, i]))
    feedSt.key = stateKey(st)
    return { items, ...st, asOf: S.lastPoll || now() }
  }

  function feedEmit(event, data) {
    try {
      ctx.services.emit('inbox-feed', event, data)
    } catch (e) {
      ctx.log.warn(`inbox-feed ${event}:`, e && e.message ? e.message : String(e))
    }
  }

  /**
   * Tell Inbox what changed since it was last told (after a poll, a mark, a settings change): `item`
   * per new or changed issue, `gone` for the missing ones (a Done issue, a lane switched off). A change
   * of the Sync state (kind or message: not set up, a refused token, an error, a recovery) is a `sync`
   * instead: the source is unsure it told everything. Nothing before the first sync (activate's cached
   * view). Never throws: a missing emit (an older app) or a failing one never breaks a poll.
   */
  function emitFeed() {
    if (S.stopped || !feedSt.started || typeof ctx.services.emit !== 'function') return
    try {
      if (stateKey(feedState()) !== feedSt.key) return feedEmit('sync', feedSync())
      const next = feedList()
      const d = feed.diffFeed(feedSt.sent, next)
      feedSt.sent = new Map(next.map((i) => [i.id, i]))
      for (const it of d.items) feedEmit('item', it)
      for (const ids of feed.goneChunks(d.gone)) feedEmit('gone', { ids })
    } catch (e) {
      ctx.log.warn('inbox-feed:', e && e.message ? e.message : String(e))
    }
  }

  void ready.then(() => {
    if (S.stopped || typeof ctx.services.emit !== 'function') return
    feedSt.started = true
    feedEmit('sync', feedSync())
  })

  /**
   * `act(id, 'open')` of the feed: resolves once the issue's window is up (the app did not refuse it),
   * not when the issue is read: Inbox gives every act 10 s, and an open that waited for the read was
   * reported as failed while it was on screen (design-next §3.4: "a source answering act(id, 'open') by
   * opening first"). A failed read after that is the window's error page and this panel's notice; a
   * refusal before it is the act's refusal. An open that ends without anything shown is a refusal too,
   * with the panel notice's text: resolving there answered ok for nothing on screen, and Inbox ended the
   * item's "back" mark (phase-1 review round 3). One guard here, not one per early return.
   */
  function openStarted(open) {
    return new Promise((resolve, reject) => {
      let started = false
      const before = S.notice
      open(() => {
        started = true
        resolve()
      }).then(() => {
        if (started) return
        const n = S.notice !== before && S.notice && S.notice.kind === 'error' ? S.notice.text : ''
        reject(new Error(n || 'the issue could not be shown'))
      }, (e) => {
        if (!started) return reject(e)
        const msg = e && e.message ? e.message : String(e)
        ctx.log.warn(`open: ${msg}`)
        setNotice(`Could not open the issue: ${msg}`, 'error')
      })
    })
  }

  async function feedAct(id, action) {
    await ready
    const refuse = (message) => ({ ok: false, message: feed.feedMessage(message) })
    if (typeof id !== 'string' || typeof action !== 'string') return refuse('jira: act takes an item id and an action id')
    // Only an issue the feed lists with that action: the caller is another plugin, and this call can
    // open an overlay (the jira service's document() is the call for any key, with its limits).
    const item = feedItemOf(id)
    if (!item) return refuse(`jira: ${cut(oneLine(id), 60)} is not in the lanes`)
    if (!item.actions.some((a) => a.id === action)) return refuse(`jira: ${id} has no action "${action.slice(0, 40)}"`)
    try {
      if (action === 'open') await openStarted((started) => openIssue(id, started))
      else await setRead(id, action === 'markRead')
      return { ok: true }
    } catch (e) {
      return refuse(`jira: ${e && e.message ? e.message : e}`)
    }
  }

  if (typeof ctx.services.provide === 'function') {
    ctx.services.provide('inbox-feed', {
      describe: () => ({ ...feed.DESCRIBE, scope: feed.scopeLine(cfg()) }),
      features: () => [...feed.FEATURES],
      async snapshot() {
        await ready
        return feedSync()
      },
      act: (id, action) => feedAct(id, action),
    })
  }

  // ---- panel ----

  function stateMessage() {
    const st = S.settings
    const tOn = triageOn()
    return {
      type: 'state',
      ready: st.ready,
      missing: missingText(st.missing),
      problems: st.problems,
      site: cfg().site,
      account: S.cache && S.cache.me ? S.cache.me.displayName : '',
      lastPoll: S.lastPoll,
      polling: Boolean(S.polling),
      // The app draws the last poll and Refresh in the panel's title bar (0.9.0+): the page then
      // leaves out its own line, which would only repeat it.
      coreHeader,
      error: S.error,
      laneErrors: S.laneErrors,
      deferred: S.stats ? S.stats.deferred : 0,
      triage: { on: tOn, error: tOn ? S.triageError : null },
      // The rows' Reply button (0.8.0): not offered when the writes setting is off.
      writes: S.settings.ready && writesOn(),
      notice: S.notice,
      choose: S.choose,
      unread: S.view.unread,
      lanes: S.view.lanes.map((l) => ({
        id: l.id,
        title: l.title,
        collapsed: Boolean(S.ui.collapsed[l.id]),
        // Only the rows the panel draws are sent: `limit` from the setting, all (capped) after
        // Show all, so a long Backlog does not cost a big message on every poll.
        expanded: Boolean(S.ui.expanded[l.id]),
        limit: cfg().rowsPerLane,
        total: l.rows.length,
        rows: l.rows.slice(0, S.ui.expanded[l.id] ? ROWS_PER_LANE : cfg().rowsPerLane).map(rowJson),
      })),
    }
  }

  function rowJson(x) {
    const i = x.issue
    return {
      key: i.key,
      summary: i.summary,
      status: i.status,
      priority: i.priority,
      type: i.type,
      unread: x.unread,
      newCount: x.newCount,
      lane: x.lane,
      who: x.lane === 'mentioned' ? `mentioned by ${mentionedBy(i) || 'someone'}` : i.assignee || '',
      verdict: x.verdict,
      // Every issue but a Done one can be marked unread (a flag when nobody else did anything).
      canUnread: x.lane !== 'done',
    }
  }

  function postState() {
    if (S.stopped) return
    try {
      ctx.panels.post(PANEL, stateMessage())
    } catch (e) {
      ctx.log.warn('panel post:', e.message)
    }
    setHeader()
  }

  // ---- the title bar (cc-cockpit 0.9.0+; feature-detected, so 0.8.x keeps the in-panel line) ----

  const coreHeader = typeof ctx.panels.header === 'function'
  let lastHeader = ''
  function setHeader() {
    if (!coreHeader || S.stopped) return
    const spec = headerSpec({ ready: S.settings.ready, polling: Boolean(S.polling), lastPoll: S.lastPoll, account: S.cache && S.cache.me ? S.cache.me.displayName : '' }, (io.now || Date.now)())
    // Every state message calls this (a click, a triage answer): unchanged headers are not resent.
    const json = JSON.stringify(spec)
    if (json === lastHeader) return
    lastHeader = json
    try {
      ctx.panels.header(PANEL, spec)
    } catch (e) {
      ctx.log.warn('panel header:', e.message)
    }
  }
  if (coreHeader) {
    ctx.panels.onAction(PANEL, (id) => {
      if (id === 'refresh') void pollNow('header')
    })
  }
  // "just now" turns into "5 min ago" with nothing else happening.
  const headerTimer = coreHeader ? (io.setInterval || setInterval)(setHeader, 60000) : null

  ctx.panels.onMessage(PANEL, async (m, from) => {
    if (!m || typeof m !== 'object') return
    // The page is ours, but its key still goes into a URL path and a Jira request: checked.
    const key = typeof m.key === 'string' ? issueKey(m.key) : null
    try {
      switch (m.type) {
        case 'hello':
          await ready
          return postState()
        case 'refresh':
          return void pollNow('panel')
        case 'toggle':
          if (typeof m.lane === 'string') {
            S.ui.collapsed[m.lane] = !S.ui.collapsed[m.lane]
            ctx.storage.set('ui', S.ui).catch(() => {})
            return postState()
          }
          return
        case 'expand':
          if (typeof m.lane === 'string') {
            S.ui.expanded[m.lane] = !S.ui.expanded[m.lane]
            ctx.storage.set('ui', S.ui).catch(() => {})
            return postState()
          }
          return
        case 'dismiss':
          S.notice = null
          S.choose = null
          return postState()
      }
      if (!key) return
      switch (m.type) {
        case 'open':
          return await openIssue(key)
        case 'discuss':
          return await discuss(key, typeof m.tabId === 'string' ? m.tabId : undefined)
        case 'newSession':
          return await newSession(key)
        case 'browser':
          return await openBrowser(key)
        case 'read':
          return await setRead(key, true)
        case 'unread':
          return await setRead(key, false)
        case 'wrong':
          return await wrong(key, m.priority)
        case 'undoWrong':
          return await undoWrong(key)
        case 'reply':
          // `from` is the app's word on who clicked: a read guest never writes, whatever the page drew.
          if (!mayWriteOrNotice(from)) return
          if (!writesOn()) return setNotice(wr.OFF_MESSAGE, 'error')
          return void (await showWindow(key, { reply: true }))
      }
    } catch (e) {
      ctx.log.warn(`panel ${m.type} ${key || ''}: ${e && e.message ? e.message : e}`)
      setNotice(e && e.message ? e.message : String(e), 'error')
    }
  })

  // ---- CLI ----

  /** What opening an issue shows on this app (for `ccc jira status`). */
  function windowStatus() {
    const o = ctx.overlay || {}
    if (typeof ctx.notes === 'function') return 'the issue window: notes, Ask and Reply in every view'
    if (typeof o.start !== 'function') return 'no overlays on this app'
    return 'the issue window, without notes and Ask (they need cc-cockpit 0.28.0)'
  }

  function status() {
    const st = S.settings
    const c = cfg()
    return {
      ready: st.ready,
      missing: st.missing,
      problems: st.problems,
      site: c.site || (typeof ctx.settings.project.site === 'string' ? ctx.settings.project.site : ''),
      email: c.email,
      tokenSet: Boolean(c.token),
      mode: S.client ? S.client.mode() : null,
      account: S.cache && S.cache.me,
      lastPoll: S.lastPoll,
      polling: Boolean(S.polling),
      pollMinutes: c.pollMinutes,
      writes: c.writes,
      counts: S.lists ? S.view.lanes.map((l) => ({ title: l.title, total: l.rows.length, unread: l.id === 'done' ? 0 : l.rows.filter((r) => r.unread).length })) : null,
      triage: triageOn() ? (S.triageError ? `error: ${S.triageError}` : 'on (bronos.jev-triage)') : 'off: install and enable Jev triage (bronos.jev-triage) to sort the lanes',
      window: windowStatus(),
      deferred: S.stats ? S.stats.deferred : 0,
      error: S.error,
      laneErrors: S.laneErrors,
      issueErrors: S.stats ? S.stats.issueErrors : [],
    }
  }

  ctx.cli.register('jira', async (argv, call) => {
    await ready
    return runCli(
      argv,
      {
        status,
        async refresh() {
          const p = pollNow('cli')
          let timer
          const late = new Promise((r) => {
            timer = setTimeout(() => r('late'), io.cliWaitMs || CLI_WAIT_MS)
          })
          const got = await Promise.race([p.then(() => 'done'), late])
          clearTimeout(timer)
          if (got === 'late') return { pending: true }
          return S.error ? { error: S.error } : {}
        },
        view: () => ({ lanes: S.view.lanes.map((l) => ({ ...l, rows: l.rows.map((x) => ({ ...x, mentionedBy: mentionedBy(x.issue) })) })) }),
        async show(key, signal) {
          const { issue, lane, mark, stale } = await fullIssue(key, signal)
          return readableText(issue, { site: cfg().site, mark, lane }) + (stale ? `\n\n(from the last poll: ${stale})` : '')
        },
        read: (key) => setRead(key, true),
        unread: (key) => setRead(key, false),
        writes: () => cfg().writes,
        update: (key, o) => cliUpdate(key, o),
      },
      call,
    )
  })

  return {
    S,
    pollNow,
    classifyChanged,
    stop() {
      S.stopped = true
      abort.abort()
      if (headerTimer) (io.clearInterval || clearInterval)(headerTimer)
      ;(io.clearTimeout || clearTimeout)(firstPoll)
      if (stopSchedule) stopSchedule()
      return Promise.all([cacheFile.flush().catch(() => {}), images ? images.cache.flush() : null])
    },
  }
}

exports.activate = (ctx) => {
  instance = start(ctx)
  const st = instance.S.settings
  ctx.log.info(st.ready ? `activated for ${st.cfg.site}` : `activated, not configured: missing ${st.missing.join(', ') || '-'}${st.problems.length ? `; ${st.problems.join('; ')}` : ''}`)
}

exports.deactivate = () => {
  const i = instance
  instance = null
  return i ? i.stop() : undefined
}

// For the suites: the host with fakes in place of fetch, the platform and timers.
exports._start = start
