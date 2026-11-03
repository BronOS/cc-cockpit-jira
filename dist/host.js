'use strict'
// bronos.jira: your Jira Cloud issues in lanes, sorted by jev-triage, read-only towards Jira.
// Plain JavaScript with no build step; the pure logic is in ./lib (node:test suites in test/).
// Design: docs/design.md. The app API: `ccc guide api` (this file uses only what it documents).
//
// Life of a project window: activate reads the settings and the stored state, then polls every
// `pollMinutes` while the window is open (a closed project has no host, so it does nothing). A
// poll searches, reads changed issues in full, updates the seen marks, asks triage about what
// changed, and posts the state to the panel. Nothing is polled until site, email and token are set.

const { readSettings, connectionKey, missingText } = require('./lib/settings')
const { createClient } = require('./lib/client')
const { compact } = require('./lib/model')
const { poll, buildView, allRows, loadCache } = require('./lib/poll')
const { loadSeen, seed, markRead, markUnread, emptySeen } = require('./lib/seen')
const { triageItem, mentionedBy } = require('./lib/triage')
const { readableText, browseUrl, discussPrompt } = require('./lib/readable')
const { pickTab, openerArgv, isMissingAnnotate } = require('./lib/actions')
const { runCli } = require('./lib/cli')
const { jsonFile } = require('./lib/store')
const { hashOf, oneLine, cut, issueKey } = require('./lib/util')

const PANEL = 'main'
const SOURCE = 'jira' // the triage source name: verdicts, overrides and cases group by it
const TRIAGE_CHUNK = 500 // triage.classify takes at most 500 items a call
const ROWS_PER_LANE = 300 // the panel message stays far below the 1 MiB post limit
const CLI_WAIT_MS = 25000 // `ccc` gives a handler 30 s

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
    laneErrors: {},
    stats: null,
    verdicts: {}, // key -> { priority, kind, confidence, by }
    sigs: {}, // key -> hash of the triage item it was judged on
    triageError: null,
    classifying: Promise.resolve(),
    annotateMissing: false, // set when a call proved the reviewer has no annotate
    ui: { collapsed: {} },
    notice: null, // { text, kind: 'info'|'error' } after an action, until dismissed or replaced
    choose: null, // { key, tabs } when Discuss needs the person to pick a tab
    stopped: false,
  }

  const cfg = () => S.settings.cfg

  // ---- stored state ----

  const ready = (async () => {
    const ui = await ctx.storage.get('ui').catch(() => undefined)
    if (ui && typeof ui === 'object' && ui.collapsed && typeof ui.collapsed === 'object') S.ui = { collapsed: { ...ui.collapsed } }
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
    S.polling = (async () => {
      try {
        await ready
        if (!S.cache || S.cache.site !== cfg().site || S.cache.email !== cfg().email) await loadSiteState()
        const r = await poll({ client: client(), cfg: cfg(), cache: S.cache, prev: S.lists || undefined, now: now(), signal: abort.signal })
        S.lists = r.lists
        S.lastPoll = r.at
        S.stats = r.stats
        S.laneErrors = r.laneErrors
        S.error = null
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
        ctx.log.error(`poll (${reason}) failed: ${S.error}${e && e.detail ? ` (${e.detail})` : ''}`)
      } finally {
        S.polling = null
        postState()
      }
    })()
    postState()
    return S.polling
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
    if (S.settings.ready) reschedule()
    rebuild()
    postState()
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
      const issue = compact(await client().issue(key, signal || abort.signal), S.cache.me.accountId, 'full')
      return { issue, lane, mark }
    } catch (e) {
      const cached = S.cache && S.cache.issues[key]
      if (cached) {
        ctx.log.warn(`reading ${key} fresh failed, using the cached copy: ${e.message}`)
        return { issue: row ? row.issue : cached, lane, mark, stale: e.message }
      }
      throw e
    }
  }

  async function setRead(key, read) {
    await ready
    if (!S.seen) throw new Error('no poll yet: the seen marks start with the first poll (ccc jira refresh)')
    const row = rowOf(key)
    const issue = row ? row.issue : S.cache && S.cache.issues[key]
    if (!issue || !issue.full) throw new Error(`${key} is not in the lanes (only shown issues have a seen mark)`)
    if (read) markRead(S.seen, issue, now())
    else markUnread(S.seen, issue, row ? row.lane : 'any')
    await saveSeen()
    rebuild()
    postState()
    // Unread changes the hint, so the item's hash: only this issue is judged again.
    void classifyChanged()
  }

  function setNotice(text, kind = 'info') {
    S.notice = { text: cut(oneLine(text), 400), kind }
    postState()
  }

  async function openIssue(key) {
    const { issue, lane, mark, stale } = await fullIssue(key)
    const site = cfg().site
    const text = readableText(issue, { site, mark, lane }) + (stale ? `\n\n(Jira could not be reached, this is the copy from the last poll: ${stale})` : '')
    const url = browseUrl(site, key)
    // Opening marks it read (design); the text above already has its [new] marks.
    if (S.seen && issue.full) {
      markRead(S.seen, issue, now())
      await saveSeen()
      rebuild()
      postState()
      void classifyChanged()
    }
    if (annotateOn()) {
      const sessions = await ctx.sessions.list().catch(() => [])
      const pick = pickTab(sessions)
      try {
        await reviewer.annotate({ title: `${key}: ${oneLine(issue.summary)}`, text, url, key: `jira:${key}`, ...(pick.tabId ? { tabId: pick.tabId } : {}) })
        return
      } catch (e) {
        if (!isMissingAnnotate(e)) {
          setNotice(`The reviewer could not open ${key}: ${e.message}`, 'error')
          return
        }
        // cc-cockpit before 0.8.0: no annotate. Remember it for this run and use our own page.
        S.annotateMissing = true
        ctx.log.info('reviewer has no annotate (cc-cockpit before 0.8.0): using the plain reader')
        postState()
      }
    }
    await plainReader(issue, text, url)
  }

  /** Without annotations: our own read-only page with Discuss, New session and ↗. */
  async function plainReader(issue, text, url) {
    let handle
    try {
      handle = ctx.overlay.start({ kind: 'html', file: 'panels/issue.html', title: `${issue.key}: ${cut(oneLine(issue.summary), 80)}`, size: 'large' })
    } catch (e) {
      setNotice(`Cannot open the reader: ${e.message}`, 'error')
      return
    }
    handle.post({ key: issue.key, summary: issue.summary, text, url })
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
    await ctx.sessions.open({ prompt })
    setNotice(`Opened a new Claude tab about ${key}.`)
  }

  async function openBrowser(key) {
    const url = browseUrl(cfg().site, key)
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
      error: S.error,
      laneErrors: S.laneErrors,
      deferred: S.stats ? S.stats.deferred : 0,
      triage: { on: tOn, error: tOn ? S.triageError : null },
      annotate: annotateOn(),
      notice: S.notice,
      choose: S.choose,
      unread: S.view.unread,
      lanes: S.view.lanes.map((l) => ({
        id: l.id,
        title: l.title,
        collapsed: Boolean(S.ui.collapsed[l.id]),
        total: l.rows.length,
        rows: l.rows.slice(0, ROWS_PER_LANE).map(rowJson),
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
      canUnread: x.lane !== 'done' && Boolean(i.full) && (i.events || []).some((e) => !e.mine),
    }
  }

  function postState() {
    if (S.stopped) return
    try {
      ctx.panels.post(PANEL, stateMessage())
    } catch (e) {
      ctx.log.warn('panel post:', e.message)
    }
  }

  ctx.panels.onMessage(PANEL, async (m) => {
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
      counts: S.lists ? S.view.lanes.map((l) => ({ title: l.title, total: l.rows.length, unread: l.id === 'done' ? 0 : l.rows.filter((r) => r.unread).length })) : null,
      triage: triageOn() ? (S.triageError ? `error: ${S.triageError}` : 'on (bronos.jev-triage)') : 'off: install and enable Jev triage (bronos.jev-triage) to sort the lanes',
      annotate: annotateOn() ? 'reviewer.annotate (notes on the issue text)' : 'plain reader (reviewer.annotate needs cc-cockpit 0.8.0)',
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
      ;(io.clearTimeout || clearTimeout)(firstPoll)
      if (stopSchedule) stopSchedule()
      return cacheFile.flush().catch(() => {})
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
