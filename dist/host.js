'use strict'
// bronos.jira: your Jira Cloud issues in lanes, sorted by jev-triage; since 0.8.0 a comment and a
// status change from the reply page (section "writing to Jira" below; design "Writing to Jira").
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
const { pickTab, openerArgv, isMissingAnnotate } = require('./lib/actions')
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
// The reply page's own decisions (a classic script the page loads too): the toolbar's label follows them.
const { replyAction, keepChoice } = require('../panels/replylogic')
const path = require('node:path')

const PANEL = 'main'
const SOURCE = 'jira' // the triage source name: verdicts, overrides and cases group by it
const TRIAGE_CHUNK = 500 // triage.classify takes at most 500 items a call
const ROWS_PER_LANE = 300 // the panel message stays far below the 1 MiB post limit
const CLI_WAIT_MS = 25000 // `ccc` gives a handler 30 s
// How long the reviewer's prepare and cancel may take: host-local calls, far under this.
const REVIEWER_WAIT_MS = 2000
// ctx.overlay.start gives no "shown" signal: main's refusal (3 open, 10 a minute) rejects the handle's
// `result` within one host-to-main round trip, while an overlay that opened settles only when it
// closes. Our reader page counts as up once this long passed without a rejection (the bundled
// reviewer's prepare and annotate wait the same).
const OVERLAY_SETTLE_MS = 500
// The reviewer an older app's overlays are trusted from (one without ctx.services.provider, which
// cannot name the provider a project picked): the bundled one, since a `cockpit.*` id loads only from
// the app's own bundle. A newer app names the picked `reviewer` instead (reviewerId), so a
// replacement reviewer gets our item buttons and the bundled one, not picked, does not.
const FALLBACK_REVIEWER_ID = 'cockpit.reviewer'
const IMAGE_TIMEOUT_MS = 20000 // one attachment download, redirects and body included
// The reader page gets the html in parts: a page message is at most 1,040,384 chars of JSON
// (`ccc guide panels`), and JSON can double a string (quotes, backslashes).
const PAGE_HTML_PART = 400000
// The reply page (0.8.0): how long a CLI draft waits for the page to read the issue and take the
// draft (the answer comes before ccc's 30 s), and how long a toolbar click waits for the page's values.
const DRAFT_WAIT_MS = 20000
const PAGE_ANSWER_MS = 5000

let instance = null

/**
 * The host, with its I/O injectable for the suites (`fetch`, the platform, timers). The app calls
 * `activate(ctx)`, which uses the real ones.
 */
function start(ctx, io = {}) {
  const fetchFn = io.fetch || globalThis.fetch
  const platform = io.platform || process.platform
  const now = io.now || Date.now
  const triage = ctx.services.use('triage')
  const reviewer = ctx.services.use('reviewer')
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
    annotateMissing: false, // set when a call proved the reviewer has no annotate
    htmlRejected: null, // the reviewer's message when annotate took text but refused html (0.7/early 0.8)
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
  // Writing to Jira (0.8.0): the open reply pages by issue key (openReply), and whether writes are on.
  const replies = new Map()
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
  function annotateOn() {
    return !S.annotateMissing && ctx.services.available('reviewer')
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
    // Writing turned off, or another site or account: an open reply page would write where the
    // person no longer means to. Closed (its text was the person's to post; nothing was written).
    if (after.writes === 'off' || before.site !== after.site || before.email !== after.email || connectionKey(before) !== connectionKey(after)) {
      for (const page of replies.values()) closeQuietly(page.handle)
    }
    // The service's answers belong to the old site or account (and the senders may have changed).
    lookups.clear()
    if (S.settings.ready) reschedule()
    rebuild()
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

  /**
   * Open: the issue as styled HTML with its images in the reviewer (cc-cockpit 0.8.0), else as
   * plain text in the reviewer (a reviewer whose annotate takes text only), else in our own page.
   * The chain, each step taken once a call proved the one before is not there:
   *   annotate({ html, assets }) -> rejected (not "no method") -> annotate({ text })
   *   -> "no method annotate" (0.7.0) or no reviewer -> panels/issue.html with the same HTML.
   * A refusal of html is remembered for the run only when the text call then worked, so a
   * failure that has nothing to do with html (the overlay could not open) does not switch modes.
   * The reviewer's overlay is up before the issue is read (its prepare, where it has one): reading
   * the issue with its comments and images takes seconds, with nothing on screen meanwhile
   * (real-work feedback 8). The annotate below fills that overlay; a failed read with no cached copy
   * turns it into the error page with Try again where the reviewer has `fail` (failView); whatever
   * else happens (an older reviewer's failed read, our own reader page) closes it in the finally.
   * `onStarted` (feed act) runs only once something is on screen: the prepared overlay, our reader
   * page, or (neither: a reviewer without prepare, a prepare that failed or ran past its wait) the
   * filled view at the end. Called earlier, a failed read reached only this panel's notice while
   * the person clicked in Inbox, and Inbox ended the item's "back" mark for an open never seen.
   */
  async function openIssue(key, onStarted) {
    const shown = () => {
      if (onStarted) onStarted()
    }
    const pre = await prepareView(key)
    // Without the reviewer our own reader page is the overlay, so it is up before the issue is read
    // (`ready: 'manual'`: its loader stays until the page has drawn the issue).
    const early = pre || annotateOn() ? null : startReader(key)
    // Our page counts once main did not refuse it (a refused one fails the open in plainReader).
    if (pre) shown()
    else if (early) void early.refusal.then((e) => e || shown())
    try {
      await showIssue(key, pre, early, shown)
    } finally {
      // A loader turned into the read's error page (failView) stays: it is the person's to close.
      if (pre && !pre.failed) await cancelView(pre)
      if (early && !early.used) closeQuietly(early.handle)
    }
  }

  // Issues whose reviewer loader shows a failed read with Try again (failView): reviewer key -> issue key.
  const failedViews = new Map()

  /**
   * A read that failed after the reviewer's loader was up, with no cached copy to show instead
   * (fullIssue falls back to the last poll's copy of an issue in the lanes): the loader shows the
   * error with Try again (the reviewer's `fail`, cc-cockpit 0.13.2) instead of closing. Cancelling it,
   * as before, made a network outage flash the overlay open and shut with no reason on screen: the
   * error reached only this panel's notice, which a click in Inbox never shows. The act contract
   * stays: the loader was on screen, so the feed's act answered ok at prepare; no seen mark is set
   * (seen() never ran). True when the reviewer took it; false (an older reviewer without 'fail', the
   * person closed the loader meanwhile) leaves the cancel to openIssue's finally, as before.
   */
  async function failView(pre, key, e) {
    const msg = oneLine(e && e.message ? e.message : String(e))
    const head = (e && (e.kind === 'network' || e.kind === 'timeout')) || /^cannot reach /i.test(msg) ? "Can't reach Jira" : 'Could not load this issue'
    try {
      const features = await within(reviewer.features(), REVIEWER_WAIT_MS)
      if (!Array.isArray(features) || !features.includes('fail')) return false
      // Try again only when its click can reach us (the event `action`).
      const retry = typeof reviewer.on === 'function'
      const r = await within(reviewer.fail({ key: pre.key, message: cut(`${head}: ${msg}`, 300), retry }), REVIEWER_WAIT_MS)
      if (!(r && r.failed)) return false
      if (retry) failedViews.set(pre.key, key)
      return true
    } catch (err) {
      ctx.log.warn(`reviewer.fail: ${err && err.message ? err.message : err}`)
      return false
    }
  }

  /**
   * Try again on an error page of ours (the reviewer's event `action` { key, id: 'retry', caller }):
   * the normal open again, so the reviewer takes the page back to its loader (prepare), and the
   * issue or the error once more fills it. Events reach every consumer: only our own key counts.
   */
  async function onReviewerAction(d) {
    if (!d || d.caller !== ctx.pluginId || d.id !== 'retry' || typeof d.key !== 'string') return
    const key = failedViews.get(d.key)
    if (key === undefined) return
    failedViews.delete(d.key)
    try {
      await openIssue(key)
    } catch (e) {
      // As a panel click's open: the log and the notice, beside the error page the retry put up again.
      ctx.log.warn(`retry open: ${e && e.message ? e.message : e}`)
      setNotice(e && e.message ? e.message : String(e), 'error')
    }
  }
  if (typeof reviewer.on === 'function') reviewer.on('action', (d) => void onReviewerAction(d).catch((e) => ctx.log.warn(`reviewer action: ${e && e.message ? e.message : e}`)))

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
   * Whether an overlay's opener may get our item buttons: we (the reader page) or the reviewer we hand
   * the item to. `opener` is the app's record of who opened it (OverlayInfo), unlike `data`: another
   * plugin opening an overlay that names one of our issues gets none of our item buttons.
   */
  function trustedOpener(opener) {
    if (opener === ctx.pluginId) return true
    const reviewer = reviewerId()
    return typeof reviewer === 'string' && reviewer !== '' && opener === reviewer
  }

  /**
   * The plugin our `reviewer` calls reach right now, asked at button time (the project's pick can
   * change while we run), or null when none does. An older app without ctx.services.provider: the
   * bundled reviewer. A throw (not expected: `reviewer` is in our uses) trusts no reviewer.
   */
  function reviewerId() {
    if (typeof ctx.services.provider !== 'function') return FALLBACK_REVIEWER_ID
    try {
      return ctx.services.provider('reviewer')
    } catch {
      return null
    }
  }

  /**
   * The item's actions but open, with `run` = the same code as the feed's `act`; labels follow the item's state.
   * A refused act is shown in the panel's notice and thrown: the app only logs a run that throws, and an
   * answer it does not read would make a failed Mark read silent.
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
    const out = item.actions.filter((a) => a.id !== 'open').map((a) => ({ id: a.id, label: a.label, run: () => run(a.id) }))
    // Reply (0.8.0): the reply page above this overlay, unless writing is off. The click's `from`
    // (the app's word) must be the owner or a write guest; the setting is read again at the click.
    if (writesOn()) {
      out.push({
        id: 'reply',
        label: 'Reply',
        run: async (_info, from) => {
          if (!mayWriteOrNotice(from)) throw new Error('only the owner or a guest with write access can reply')
          try {
            await openReply(item.id)
          } catch (e) {
            setNotice(e && e.message ? e.message : String(e), 'error')
            throw e
          }
        },
      })
    }
    return out
  }

  /** What Discuss with Claude sends for an issue overlay: key and summary, status and the latest comment, capped. */
  function overlayDiscuss(key) {
    const item = feedItemOf(key)
    if (!item) return null
    const status = item.place && item.place.status ? item.place.status : ''
    return { text: cut([`Jira issue: ${item.title}`, status ? `Status: ${status}` : '', item.preview ? `Latest: ${item.preview}` : ''].filter(Boolean).join('\n'), 4000) }
  }

  if (ctx.overlay && typeof ctx.overlay.buttons === 'function') {
    // Dropped by the app when the plugin stops.
    ctx.overlay.buttons('inbox-item', (info) => overlayButtons(info))
  }

  /** Resolves null once an overlay is up (no refusal within OVERLAY_SETTLE_MS, or it already ended), else main's refusal. */
  function overlayRefusal(handle) {
    let timer
    const wait = new Promise((resolve) => (timer = setTimeout(resolve, OVERLAY_SETTLE_MS, null)))
    return Promise.race([handle.result.then(() => null, (e) => e || new Error('refused')), wait]).finally(() => clearTimeout(timer))
  }

  /** `p`, or a rejection after `ms`: a service call has no timeout of its own. */
  function within(p, ms) {
    let timer
    return Promise.race([p, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('the reviewer did not answer in time')), ms)))]).finally(() => clearTimeout(timer))
  }

  /**
   * Opens the reviewer's overlay of an issue now, with its loader, under the key and title the
   * annotate gives it (the summary from the last poll): `{ key }` when it did, else null (no reviewer
   * with annotate, or one without prepare, which rejects with "has no method": the overlay then comes
   * with the annotate, as before).
   */
  async function prepareView(key) {
    if (!annotateOn()) return null
    const row = rowOf(key)
    const title = row && row.issue.summary ? `${key}: ${oneLine(row.issue.summary)}` : key
    try {
      // The type goes with prepare: the reviewer fixes an overlay's type when it starts, so the
      // annotate that fills a prepared overlay cannot add it later (an older reviewer ignores it).
      await within(reviewer.prepare({ key: `jira:${key}`, title: title.slice(0, 200), type: overlayType(key) }), REVIEWER_WAIT_MS)
      return { key: `jira:${key}` }
    } catch {
      return null
    }
  }

  /** Closes a prepared overlay no annotate filled; a no-op once one did. */
  async function cancelView(pre) {
    await within(reviewer.cancel({ key: pre.key }), REVIEWER_WAIT_MS).catch((e) => ctx.log.warn(`reviewer.cancel: ${e && e.message ? e.message : e}`))
  }

  async function showIssue(key, pre, early, shown = () => {}) {
    let got
    try {
      got = await fullIssue(key)
    } catch (e) {
      // The loader shows the failure (and openIssue leaves it); the error still goes on to the
      // panel's notice and the log, as before.
      if (pre) pre.failed = await failView(pre, key, e)
      throw e
    }
    const { issue, lane, mark, stale } = got
    const site = cfg().site
    const staleNote = stale ? `Jira could not be reached, this is the copy from the last poll: ${stale}` : ''
    const text = readableText(issue, { site, mark, lane }) + (stale ? `\n\n(${staleNote})` : '')
    const url = browseUrl(site, key)
    const title = `${key}: ${oneLine(issue.summary)}`
    // Opening marks it read only with the markReadOnOpen setting (off by default: an issue opened to
    // glance at it, from Inbox above all, lost the unread mark the person kept as a to-do). This is
    // the one place an open touches the seen marks (the panel row and the feed's act 'open' both come
    // through showIssue; the overlay buttons have no open; the CLI cannot open), so with the setting
    // off an open changes nothing: no saveSeen, no emitFeed, so Inbox never gets an item event with
    // read: true for a mere open, and Mark unread's flag stays. Mark read / Mark unread (setRead)
    // work either way. Read at show time: a settings change during the read counts.
    // With the setting on: the text and the HTML already have their new marks. Applied
    // only once the issue is on screen (the same places shown() runs): marking it right after the
    // read left an issue seen, and pushed read: true to Inbox, for an open then refused or a loader
    // the person closed (annotate's { opened: false }) (phase-1 review round 4).
    // Never throws: it runs inside the annotate tries, where a throw would read as a reviewer refusal.
    const seen = async () => {
      shown()
      if (!S.seen || !issue.full || !cfg().markReadOnOpen) return
      try {
        markRead(S.seen, issue, now())
        await saveSeen()
        rebuild()
        postState()
        emitFeed()
        void classifyChanged()
      } catch (e) {
        ctx.log.warn(`marking ${key} seen: ${e && e.message ? e.message : e}`)
      }
    }
    const opened = (r) => !(r && r.opened === false)
    // Two builds at most: the reviewer's (with the details column when it takes one) and our own
    // reader page's (no column: the facts stay in the header card there).
    const docs = {}
    const view = async (aside = false) => (docs[aside] = docs[aside] || (await issueView(got, staleNote, aside)))
    if (annotateOn()) {
      const pick = pickTab(await ctx.sessions.list().catch(() => []))
      // An older reviewer ignores `type`.
      const base = { title, url, key: `jira:${key}`, type: overlayType(key), ...(pick.tabId ? { tabId: pick.tabId } : {}) }
      let htmlError = null
      if (!S.htmlRejected) {
        // The details column needs a reviewer with `aside` (cc-cockpit 0.9.1+). No service says which
        // options it takes, so the app's ctx.openExternal (the same release) stands in for that.
        const v = await view(typeof ctx.openExternal === 'function')
        try {
          const r = await reviewer.annotate({ ...base, html: v.html, ...(v.aside ? { aside: v.aside } : {}), ...(v.assets.length ? { assets: v.assets } : {}) })
          if (opened(r)) await seen()
          return
        } catch (e) {
          if (isMissingAnnotate(e)) {
            noAnnotate()
          } else {
            htmlError = e && e.message ? e.message : String(e)
            ctx.log.info(`reviewer refused the html of ${key} (${htmlError}); trying text`)
          }
        }
      }
      if (!S.annotateMissing) {
        try {
          const r = await reviewer.annotate({ ...base, text })
          if (htmlError) {
            S.htmlRejected = htmlError
            ctx.log.info('reviewer.annotate takes text only (cc-cockpit before 0.8.0 html mode): using text for this run')
            postState()
          }
          if (opened(r)) await seen()
          return
        } catch (e) {
          if (!isMissingAnnotate(e)) {
            setNotice(`The reviewer could not open ${key}: ${e.message}${htmlError && htmlError !== e.message ? ` (html: ${htmlError})` : ''}`, 'error')
            return
          }
          noAnnotate()
        }
      }
    }
    // Our own page instead of the reviewer's: its loader goes first (it cannot show this page).
    if (pre) await cancelView(pre)
    await plainReader(issue, await view(), url, early, shown, seen)
  }

  // cc-cockpit before 0.8.0: no annotate. Remember it for this run and use our own page.
  function noAnnotate() {
    S.annotateMissing = true
    ctx.log.info('reviewer has no annotate (cc-cockpit before 0.8.0): using the plugin\'s reader page')
    postState()
  }

  /**
   * The issue as HTML plus the image assets: the image attachments chosen by images.selectImages,
   * from the cache or downloaded with the token, waited for at most WAIT_MS. With the cached copy
   * (Jira unreachable) only cached images are used.
   */
  async function issueView({ issue, raw, lane, mark, stale }, note, withAside, budget = {}) {
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
    const doc = issueDocument({ issue, raw, site: cfg().site, mark, lane, assets: byAttachment, note, aside: Boolean(withAside), ...(budget.maxHtmlBytes ? { maxBytes: budget.maxHtmlBytes } : {}) })
    return { html: doc.html, assets, aside: doc.aside }
  }

  /**
   * Starts the reader page's overlay (before the issue is read when it can); null when the app refuses.
   * The overlay API cannot retitle an open overlay, so with no cached summary the title is the bare key
   * (no dangling `KEY: `).
   */
  function startReader(key, issue) {
    const row = issue ? null : rowOf(key)
    const summary = issue ? issue.summary : row ? row.issue.summary : ''
    try {
      const handle = ctx.overlay.start({ kind: 'html', file: 'panels/issue.html', title: summary ? `${key}: ${cut(oneLine(summary), 80)}` : key, size: 'large', ready: 'manual', type: overlayType(key) })
      if (typeof handle.onDiscuss === 'function') handle.onDiscuss(() => overlayDiscuss(key))
      // `refusal`: null once the page is up (OVERLAY_SETTLE_MS without a rejection, or the person
      // closed it), else main's refusal; `ended` turns true once the overlay ended.
      const started = { handle, used: false, ended: false, refusal: overlayRefusal(handle) }
      const end = () => (started.ended = true)
      handle.result.then(end, end)
      return started
    } catch (e) {
      setNotice(`Cannot open the reader: ${e.message}`, 'error')
      return null
    }
  }

  /**
   * Without the reviewer's annotate: our own read-only page with Discuss, New session and ↗. It
   * gets the same HTML (built by escaping, see lib/adfhtml.js) in parts, then one message per
   * image, so no message passes the page limit. A link click in the page comes back as `{ open }`.
   */
  async function plainReader(issue, view, url, early, shown = () => {}, seen = shown) {
    const started = early || startReader(issue.key, issue)
    if (!started) return
    started.used = true
    // start() returns a handle even for an overlay main refuses; the refusal only rejects `result`.
    const refused = await started.refusal
    if (refused) return setNotice(`Cannot open the reader: ${refused.message}`, 'error')
    // On screen now; the wait below lasts until the person closes the page (feed act answers here).
    shown()
    const handle = started.handle
    const parts = []
    for (let i = 0; i < view.html.length; i += PAGE_HTML_PART) parts.push(view.html.slice(i, i + PAGE_HTML_PART))
    let posted = false
    try {
      // With the app's overlay toolbar (Discuss with Claude, New session) the page drops its own two buttons.
      const toolbar = typeof ctx.overlay.buttons === 'function' && typeof handle.onDiscuss === 'function'
      handle.post({ type: 'doc', key: issue.key, summary: issue.summary, url, parts: parts.length, assets: view.assets.length, ...(toolbar ? { toolbar: true } : {}) })
      parts.forEach((part, i) => handle.post({ type: 'html', i, part }))
      for (const a of view.assets) handle.post({ type: 'asset', id: a.id, dataUrl: a.dataUrl })
      posted = true
    } catch (e) {
      ctx.log.warn(`posting ${issue.key} to the reader: ${e.message}`)
      // ready: 'manual' means the page never draws, so never says ready, and the loader would stay.
      setNotice(`Cannot show ${issue.key}: ${e.message}`, 'error')
      closeQuietly(handle)
    }
    // Seen only when the issue reached a page still open: a post after the person closed the loader
    // is a silent no-op, so they never saw it.
    if (posted && !started.ended) await seen()
    handle.onMessage((m) => {
      if (m && typeof m.open === 'string') void openUrl(m.open).catch((e) => setNotice(e.message, 'error'))
    })
    const res = await handle.result.catch((e) => {
      setNotice(`The reader failed: ${e.message}`, 'error')
      return null
    })
    const action = res && res.kind === 'value' && res.value && typeof res.value === 'object' ? res.value.action : null
    if (action === 'discuss') await discuss(issue.key)
    else if (action === 'newSession') await newSession(issue.key)
    else if (action === 'browser') await openBrowser(issue.key)
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

  /** An http(s) address in the system browser (the ↗ button, a link in the reader page). */
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


  // ---- writing to Jira (0.8.0; design "Writing to Jira") ----
  //
  // A comment and/or a status change on one issue, made only on the reply page (panels/reply.html),
  // one page per issue, by the person's click. `ccc jira update` prepares a page (writes: draft, the
  // default) or writes itself (direct) or is refused (off); the setting is read on every call, for
  // every caller, here in the host: a description can tell Claude to close the ticket, and a skill or
  // a permission rule on Claude's side can be walked around. Every click that writes is checked
  // against the app's `from.access` (owner or write guest). The pure rules are in lib/write.js.

  function mayWriteOrNotice(from) {
    if (wr.mayWrite(from)) return true
    setNotice('Only the owner or a guest with write access can write to Jira.', 'error')
    return false
  }

  /** `p`, or `fallback` after `ms` (a wait that must not hold a CLI answer or a click forever). */
  function settleWithin(p, ms, fallback) {
    let timer
    return Promise.race([p, new Promise((r) => (timer = setTimeout(r, ms, fallback)))]).finally(() => clearTimeout(timer))
  }

  function postReply(page, m) {
    if (page.closed) return
    try {
      page.handle.post(m)
    } catch (e) {
      ctx.log.warn(`reply page ${page.key}: ${e && e.message ? e.message : e}`)
    }
  }

  /** The toolbar's one button, its label from the page's current values (replylogic.replyAction). */
  function updateButton(page) {
    if (!page.toolbar || page.closed) return
    const a = replyAction(page.form.comment, page.form.transitionId)
    const spec = [{ id: 'send', label: a.label, primary: true, disabled: a.disabled || !page.loaded || page.busy, ...(page.busy ? { busy: true } : {}) }]
    const json = JSON.stringify(spec)
    if (json === page.button) return
    page.button = json
    try {
      page.handle.setButtons(spec)
    } catch (e) {
      ctx.log.warn(`reply page buttons: ${e && e.message ? e.message : e}`)
    }
  }

  /** The transitions as the page lists them (plain data; the page builds the options with replylogic.moveOption). */
  const pageTransitions = (list) => list.map((t) => ({ id: t.id, name: t.name, to: t.to, enabled: t.enabled, why: t.why }))

  /**
   * Read the issue's header and its transitions for the page (each time the page opens or a draft
   * replaces its content: workflows differ per project and status) and post them. With `fill` (a
   * draft, or the empty form of a Reply click) the page replaces its fields and answers `filled`;
   * one the person typed into since the last fill keeps its words and answers `applied: false`
   * (the race of a draft arriving while they type), which counts as edited.
   * Resolves `{ ok, applied, asked, error }`; never rejects.
   */
  async function loadReply(page, fill) {
    const key = page.key
    let head
    let transitions
    try {
      await ready
      ;[head, transitions] = await Promise.all([client().issueHeader(key, abort.signal), client().transitions(key, abort.signal)])
    } catch (e) {
      const message = e && e.message ? e.message : String(e)
      postReply(page, { type: 'loadError', key, message: cut(oneLine(message), 400) })
      return { ok: false, error: message }
    }
    const h = header(head.key, head.fields)
    page.status = h.status
    page.tone = wr.toneOf(h.category)
    page.transitions = transitions
    page.loaded = true
    let asked = ''
    let n = null
    let form = null
    if (fill) {
      let transitionId = ''
      if (fill.status) {
        const m = wr.matchStatus(transitions, fill.status)
        if (m.transition) transitionId = m.transition.id
        else asked = wr.statusProblem(m, fill.status, transitions)
      }
      n = ++page.seq
      form = { comment: fill.comment || '', transitionId, marker: fill.marker || '', asked: asked ? `Asked to move: ${asked}` : '', n }
    } else {
      page.form.transitionId = keepChoice(transitions, page.form.transitionId)
    }
    const acked = n !== null ? waitFor(page, n) : null
    if (n !== null) page.fillPending = n
    postReply(page, {
      type: 'issue',
      key,
      summary: h.summary,
      status: h.status,
      tone: wr.toneOf(h.category),
      url: browseUrl(cfg().site, key),
      transitions: pageTransitions(transitions),
      toolbar: page.toolbar,
      max: wr.MAX_COMMENT,
      ...(form ? { fill: form } : { keep: page.form.transitionId }),
    })
    let applied = true
    if (acked) {
      // A page that never answers (it did not load) took nothing the person could have edited.
      const ack = await settleWithin(acked, DRAFT_WAIT_MS, { applied: true, late: true })
      applied = !(ack && ack.applied === false)
      // No answer in time: taken as drawn (as the page does on load); a late answer still corrects it.
      if (ack && ack.late) filled(page, n, true)
      if (applied) page.form = { comment: form.comment, transitionId: form.transitionId }
      else page.edited = true
    }
    updateButton(page)
    return { ok: true, applied, asked }
  }

  /** The page drew fill `n` (or kept the person's words over it): the revision a click is bound to. */
  function filled(page, n, applied) {
    if (page.fillPending === n) page.fillPending = null
    if (applied && n > page.shownRev) page.shownRev = n
  }

  const DRAFT_CHANGED = 'The draft just changed: read it again and click once more. Nothing was written.'

  /** A promise for the page's answer number `n` (`filled`, `values`); null when the page closes first. */
  function waitFor(page, n) {
    return new Promise((resolve) => page.waiting.set(n, resolve))
  }
  function answer(page, n, value) {
    const w = page.waiting.get(n)
    if (!w) return false
    page.waiting.delete(n)
    w(value)
    return true
  }

  /**
   * The reply page of `key`: focused when it is open (a Reply click), else opened. With `draft`
   * (`ccc jira update` in draft mode: `{ comment, status, marker }`) an open page the person has
   * not touched gets the draft instead of its content; one they edited (or are posting) is left
   * alone and the draft refused (wr.draftDecision). Resolves `{ decision, load }`, `load` the
   * page's read of the issue (loadReply); throws when the plugin is not set up, writing is off, or
   * the app refused the overlay.
   */
  async function openReply(key, draft) {
    await ready
    if (!S.settings.ready) throw notConfigured()
    if (!writesOn()) throw new Error(wr.OFF_MESSAGE)
    const existing = replies.get(key) || null
    if (existing && !draft) {
      existing.handle.focus()
      return { decision: 'focus', load: existing.loading }
    }
    if (draft) {
      const d = wr.draftDecision(existing)
      if (d === 'refuse') return { decision: 'refuse' }
      if (d === 'replace') {
        existing.handle.focus()
        existing.loading = loadReply(existing, draft)
        return { decision: 'replace', load: existing.loading }
      }
    }
    const row = rowOf(key)
    const summary = row && row.issue.summary ? `: ${cut(oneLine(row.issue.summary), 70)}` : ''
    // Open first, read after (`ready: 'manual'`): the page drops its loader once it drew the issue.
    // No `type`: a reply page is no issue overlay, so no item buttons or Discuss land on it.
    const handle = ctx.overlay.start({
      kind: 'html',
      file: 'panels/reply.html',
      title: `Reply to ${key}${summary}`,
      size: 'default',
      ready: 'manual',
      discuss: false,
      buttons: [{ id: 'send', label: 'Post comment', primary: true, disabled: true }],
    })
    const page = {
      key,
      handle,
      // An app with overlay toolbar buttons gets the one button there (the style guide: an overlay has
      // one action bar, the app's); an older one, the page's own.
      toolbar: typeof handle.onButton === 'function' && typeof handle.setButtons === 'function',
      form: { comment: '', transitionId: '' },
      transitions: [],
      status: '',
      tone: 'neutral',
      loaded: false,
      edited: false,
      busy: false,
      closed: false,
      seq: 0,
      waiting: new Map(),
      button: null,
      loading: null,
      // Review R1-1: the fill (draft) number the page last said it drew, and one posted but not yet
      // acknowledged. A click is bound to what the page showed: a submission must carry `shownRev`,
      // and none is taken while a fill is on its way.
      shownRev: 0,
      fillPending: null,
    }
    replies.set(key, page)
    const end = () => {
      page.closed = true
      if (replies.get(key) === page) replies.delete(key)
      for (const w of page.waiting.values()) w(null)
      page.waiting.clear()
    }
    handle.result.then(end, end)
    if (page.toolbar) handle.onButton('send', (from) => sendFromToolbar(page, from))
    handle.onMessage((m, from) => onReplyMessage(page, m, from))
    page.loading = loadReply(page, draft || { comment: '', status: null, marker: '' })
    const refused = await overlayRefusal(handle)
    if (refused) {
      end()
      throw new Error(`Cannot open the reply page: ${refused.message}`)
    }
    return { decision: 'open', load: page.loading }
  }

  function onReplyMessage(page, m, from) {
    if (!m || typeof m !== 'object' || page.closed) return
    switch (m.type) {
      case 'edit':
        // The person typed or chose: from now on a draft from ccc never replaces this page.
        page.edited = true
        page.form = { comment: typeof m.comment === 'string' ? m.comment : '', transitionId: typeof m.transitionId === 'string' ? m.transitionId : '' }
        return updateButton(page)
      case 'filled':
        if (!Number.isInteger(m.n)) return
        filled(page, m.n, m.applied !== false)
        answer(page, m.n, { applied: m.applied !== false })
        return
      case 'values':
        if (Number.isInteger(m.n)) answer(page, m.n, m)
        return
      case 'submit':
        // The page's own button, only on an app without toolbar buttons (else the toolbar is the one button).
        if (!page.toolbar) return void send(page, m, from)
        return
      case 'browser':
        return void openBrowser(page.key).catch((e) => setNotice(e.message, 'error'))
      case 'reload':
        if (!page.busy) page.loading = loadReply(page, page.loaded ? null : { comment: page.form.comment, status: null, marker: '' })
        return
    }
  }

  /**
   * The toolbar's button: the click is the decision, so what is written is what the page holds at
   * that moment, asked from the page (its `edit` messages could still be on the way), not the last
   * copy the host saw. A page that does not answer writes nothing.
   */
  async function sendFromToolbar(page, from) {
    if (!wr.mayWrite(from)) return postReply(page, { type: 'error', message: 'Only the owner or a guest with write access can post.' })
    if (page.busy) return
    // A draft on its way to the page may already be drawn there while the person read the old one.
    if (page.fillPending !== null) return postReply(page, { type: 'error', message: DRAFT_CHANGED })
    // Locked while the page answers: a draft arriving now is refused (wr.draftDecision), so it cannot
    // land between the click and the values.
    page.busy = true
    let values
    try {
      const n = ++page.seq
      const got = waitFor(page, n)
      postReply(page, { type: 'collect', n })
      values = await settleWithin(got, PAGE_ANSWER_MS, null)
    } finally {
      page.busy = false
    }
    if (!values) return postReply(page, { type: 'error', message: 'The page did not answer; nothing was written. Try again.' })
    // No await from here into send's own lock: nothing can slip in between.
    return send(page, values, from)
  }

  /**
   * Write what the page holds: the comment, then the move (lib/write.js performWrite: the
   * transitions read again first; a move that is gone or a status that changed writes nothing).
   * The values come from our own page, but are checked as input: a comment within the limit, a
   * transition id we listed and that is enabled.
   */
  async function send(page, values, from) {
    if (page.busy || page.closed) return
    const fail = (message) => postReply(page, { type: 'error', message: cut(oneLine(message), 600) })
    if (!wr.mayWrite(from)) return fail('Only the owner or a guest with write access can post.')
    if (!writesOn()) return fail(`Not posted: ${wr.OFF_MESSAGE}.`)
    if (!page.loaded) return fail(`${page.key} is not read yet; nothing was written.`)
    if (page.fillPending !== null || values.rev !== page.shownRev) return fail(DRAFT_CHANGED)
    const rawComment = typeof values.comment === 'string' ? values.comment : ''
    const transitionId = typeof values.transitionId === 'string' ? values.transitionId : ''
    let comment = ''
    if (rawComment.trim()) {
      const c = wr.checkComment(rawComment)
      if (c.error) return fail(`Not posted: ${c.error}.`)
      comment = c.text
    }
    if (transitionId && !page.transitions.some((t) => t.id === transitionId && t.enabled)) return fail('That move is not in the list any more; choose again. Nothing was written.')
    if (!comment && !transitionId) return fail('Nothing to post: write a comment or choose a status.')
    page.busy = true
    updateButton(page)
    postReply(page, { type: 'busy', on: true })
    try {
      const r = await wr.performWrite({ client: client(), key: page.key, comment, transitionId, expectStatus: transitionId ? page.status : undefined, guard: writeGuard(null), signal: abort.signal })
      if (r.moved) {
        page.transitions = r.transitions || page.transitions
        if (r.status !== undefined) {
          page.status = r.status
          page.tone = wr.toneOf(r.category)
        }
        page.form.transitionId = keepChoice(page.transitions, transitionId)
        postReply(page, { type: 'transitions', status: page.status, tone: page.tone, transitions: pageTransitions(page.transitions), keep: page.form.transitionId, message: r.error })
        return
      }
      if (!r.steps.length) return fail(r.error || 'Nothing was written.')
      const commentPosted = r.steps.some((x) => x.step === 'comment' && x.ok)
      if (r.steps.some((x) => x.ok)) await afterWrite(page.key)
      const lines = wr.stepLines(page.key, r.steps)
      if (r.ok) {
        setNotice(lines.join('. ') + '.')
        page.busy = false
        closeQuietly(page.handle)
        return
      }
      // Partial or failed: each step says how it went; a posted comment leaves the box (it is in
      // Jira now), the status choice stays for a retry, against a fresh list.
      if (commentPosted) page.form.comment = ''
      if (r.steps.some((x) => x.ok)) {
        try {
          const [head, list] = await Promise.all([client().issueHeader(page.key, abort.signal), client().transitions(page.key, abort.signal)])
          const fresh = header(head.key, head.fields)
          page.status = fresh.status
          page.tone = wr.toneOf(fresh.category)
          page.transitions = list
        } catch (e) {
          ctx.log.warn(`re-reading ${page.key} after a partial write: ${e && e.message ? e.message : e}`)
        }
      }
      page.form.transitionId = keepChoice(page.transitions, transitionId)
      postReply(page, { type: 'result', steps: r.steps, lines, clearComment: commentPosted, status: page.status, tone: page.tone, transitions: pageTransitions(page.transitions), keep: page.form.transitionId })
    } catch (e) {
      fail(e && e.message ? e.message : String(e))
    } finally {
      page.busy = false
      postReply(page, { type: 'busy', on: false })
      updateButton(page)
    }
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
   * cli.js asked counts), then the draft page or the direct write. `{ code, text }`.
   */
  async function cliUpdate(key, o) {
    const mode = cfg().writes
    if (mode === 'off') return { code: 1, text: wr.OFF_MESSAGE }
    if (mode === 'draft') {
      let tab = null
      if (o.tabId) tab = (await ctx.sessions.list().catch(() => [])).find((t) => t && t.tabId === o.tabId) || null
      const r = await openReply(key, { comment: o.comment || '', status: o.status || null, marker: wr.draftMarker(o.tabId, tab) })
      const editing = `The person is editing a reply to ${key}: their page was left alone and this draft was not opened. Nothing was written.`
      if (r.decision === 'refuse') return { code: 1, text: editing }
      const loaded = await settleWithin(r.load, DRAFT_WAIT_MS, { ok: true, late: true })
      if (loaded && loaded.applied === false) return { code: 1, text: editing }
      const lines = [`Draft opened for ${key}: the person posts it.`]
      if (loaded && loaded.asked) lines.push(`The status was left at Keep status: ${loaded.asked}`)
      if (loaded && loaded.error) lines.push(`The page could not read ${key} from Jira: ${oneLine(loaded.error)}`)
      if (loaded && loaded.late) lines.push('The page is still reading the issue.')
      lines.push('Nothing was written: the person decides on the page. Do not run this again to post it.')
      return { code: 0, text: lines.join('\n') }
    }
    // direct: an unknown or disabled status is refused before anything is written.
    let transitionId = ''
    let fresh
    if (o.status) {
      fresh = await client().transitions(key, o.signal)
      const m = wr.matchStatus(fresh, o.status)
      if (!m.transition) return { code: 1, text: `${key}: ${wr.statusProblem(m, o.status, fresh)} Nothing was written.` }
      transitionId = m.transition.id
    }
    const comment = o.comment ? wr.checkComment(o.comment).text || '' : ''
    const r = await wr.performWrite({ client: client(), key, comment, transitionId, fresh, guard: writeGuard('direct'), signal: o.signal })
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

  if (typeof ctx.services.provide === 'function') {
    ctx.services.provide('jira', {
      site: () => serviceSite(),
      // The caller is read before the first await (it names who a refusal in the log was for).
      issue: (key, opts) => serviceIssue(key, opts, caller()),
      document: (key, opts) => serviceDocument(key, opts, caller()),
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
   * `act(id, 'open')` of the feed: resolves once the open has started (the reviewer's overlay
   * prepared, or our own reader page up), not when it is over; with neither (a reviewer without
   * prepare, or a prepare that failed) once the issue is shown, so a failed read is still the act's
   * refusal. The rest (reading the issue, the
   * annotate, and without the reviewer the wait for our reader page to close) runs on: Inbox gives
   * every act 10 s, and an open that waited for all that was reported as failed while it was on
   * screen (design-next §3.4: "a source answering act(id, 'open') by opening first"). A failure
   * after the start goes to this panel's notice; one before it is the act's refusal.
   * An open that ends without anything shown (the reviewer refused the issue, the app refused our
   * reader page: paths that set the panel's notice and return) is a refusal too, with that notice's
   * text: resolving there answered ok for nothing on screen, and Inbox ended the item's "back" mark
   * (phase-1 review round 3). One guard here, not one per early return.
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
      annotate: annotateOn(),
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
          return void (await openReply(key))
      }
    } catch (e) {
      ctx.log.warn(`panel ${m.type} ${key || ''}: ${e && e.message ? e.message : e}`)
      setNotice(e && e.message ? e.message : String(e), 'error')
    }
  })

  // ---- CLI ----

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
      annotate: annotateOn()
        ? S.htmlRejected
          ? `reviewer.annotate, text only (its html mode needs cc-cockpit 0.8.0: ${S.htmlRejected})`
          : 'reviewer.annotate (the issue as HTML with its images, notes on it)'
        : 'the plugin\'s reader page (reviewer.annotate needs cc-cockpit 0.8.0)',
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
