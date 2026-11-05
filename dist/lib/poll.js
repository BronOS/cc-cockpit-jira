'use strict'
// One poll (design "Fetching"): the searches, then the full read of every shown issue whose
// `updated` changed since the cached copy; and the view the panel, the CLI and triage share.
//
// - Assigned: one search feeds Backlog, In progress and On hold; it runs when one of them is on
//   (or Mentioned needs the person's projects). Only issues of a shown lane are read in full.
// - Done: its own search, only when the lane is on; header fields are enough (always noise).
// - Mentioned: its own search, only when the lane is on, then each candidate read in full and
//   scanned for a mention of the person within mentionDays.
// - A failed Done or Mentioned search keeps the last list of that lane (the old connector's rule:
//   the board never loses the open issues over a side lane); a failed assigned search fails the
//   poll. A failed issue read is counted and logged, the rest go on.
// - At most `budget` full reads per poll (a first run with 500 assigned and 200 candidates would
//   otherwise run for minutes); the rest are read on the next polls (`deferred`).

const { assignedJql, doneJql, mentionedJql, SEARCH_FIELDS, DONE_FIELDS, CAPS } = require('./jql')
const { header, compact } = require('./model')
const { statusLane, sortRows, LANES } = require('./lanes')
const { mapLimit } = require('./util')
const { newEvents, isFlagged } = require('./seen')

const CONCURRENCY = 4
const BUDGET = 120
const MAX_CACHED = 800

/** A fresh cache for one site and account. */
function emptyCache(site, email) {
  return { site, email, me: null, issues: {} }
}

/** The stored cache when it belongs to this site and email, else a fresh one. */
function loadCache(stored, site, email) {
  if (stored && stored.site === site && stored.email === email && stored.issues && typeof stored.issues === 'object') {
    return { site, email, me: stored.me || null, issues: stored.issues }
  }
  return emptyCache(site, email)
}

/**
 * @param {object} o
 * @param {ReturnType<import('./client').createClient>} o.client
 * @param {object} o.cfg settings.readSettings(...).cfg
 * @param {object} o.cache loadCache(...); its `issues` and `me` are updated in place
 * @param {object} [o.prev] the last poll's lists (kept for a lane whose search failed)
 * @param {number} [o.now]
 * @param {number} [o.budget]
 * @param {AbortSignal} [o.signal]
 */
async function poll(o) {
  const { client, cfg, cache } = o
  const now = o.now || Date.now()
  const budget = o.budget === undefined ? BUDGET : o.budget
  const prev = o.prev || {}
  const signal = o.signal

  if (!cache.me) {
    const me = await client.myself(signal)
    cache.me = me
  }
  const me = cache.me.accountId
  const L = cfg.lanes
  const statusLanesOn = L.backlog || L.inProgress || L.onHold
  const laneErrors = {}
  const truncated = {}

  let assigned = []
  if (statusLanesOn || (L.mentioned && !cfg.mentionProjects.length)) {
    const r = await client.search(assignedJql(), SEARCH_FIELDS, CAPS.assigned, signal)
    assigned = r.issues.map((i) => header(i.key, i.fields))
    if (r.truncated) truncated.assigned = CAPS.assigned
  }
  // Only the shown lanes: a hidden lane is never read in full nor sent to triage.
  const shownAssigned = statusLanesOn ? assigned.filter((h) => L[statusLane(h, cfg.onHold)]) : []

  let done = []
  if (L.done) {
    try {
      const r = await client.search(doneJql(cfg.doneDays), DONE_FIELDS, CAPS.done, signal)
      done = r.issues.map((i) => header(i.key, i.fields))
      if (r.truncated) truncated.done = CAPS.done
    } catch (e) {
      if (e && e.kind === 'auth') throw e
      laneErrors.done = e.message
      done = prev.done || []
    }
  }

  let candidates = []
  if (L.mentioned) {
    const projects = cfg.mentionProjects.length ? cfg.mentionProjects : [...new Set(assigned.map((h) => h.project))]
    const jql = mentionedJql(projects, cfg.mentionDays)
    if (jql) {
      try {
        const r = await client.search(jql, SEARCH_FIELDS, CAPS.mentioned, signal)
        const mine = new Set(assigned.map((h) => h.key))
        candidates = r.issues.map((i) => header(i.key, i.fields)).filter((h) => !mine.has(h.key) && h.assigneeId !== me)
        if (r.truncated) truncated.mentioned = CAPS.mentioned
      } catch (e) {
        if (e && e.kind === 'auth') throw e
        laneErrors.mentioned = e.message
        candidates = prev.candidates || []
      }
    } else {
      laneErrors.mentioned = 'no project to search: you have no assigned issues; list project keys in the mentionProjects setting'
    }
  }

  // Full reads: what is new or changed since the cached copy, assigned first.
  const wanted = [...shownAssigned, ...candidates]
  const stale = wanted.filter((h) => {
    const c = cache.issues[h.key]
    return !c || !c.full || c.updated !== h.updated
  })
  const now_ = stale.slice(0, budget)
  const deferred = stale.length - now_.length
  const results = await mapLimit(now_, CONCURRENCY, async (h) => compact(await client.issue(h.key, signal), me))
  const issueErrors = []
  results.forEach((r, i) => {
    const key = now_[i].key
    if (r.ok) cache.issues[key] = r.value
    else {
      // An expired token shows on the first read already; the poll says so once instead of
      // listing every issue with the same 401.
      if (r.error && r.error.kind === 'auth') throw r.error
      issueErrors.push({ key, message: r.error && r.error.message ? r.error.message : String(r.error) })
    }
  })

  // Bounded cache: the issues the lists still name, newest first, at most MAX_CACHED.
  const keep = new Set(wanted.map((h) => h.key))
  const kept = Object.keys(cache.issues).filter((k) => keep.has(k))
  kept.sort((a, b) => (cache.issues[b].updatedAt || 0) - (cache.issues[a].updatedAt || 0))
  const issues = {}
  for (const k of kept.slice(0, MAX_CACHED)) issues[k] = cache.issues[k]
  cache.issues = issues

  return {
    lists: { assigned: shownAssigned, done, candidates },
    stats: { searched: assigned.length + done.length + candidates.length, fetched: now_.length - issueErrors.length, deferred, issueErrors, truncated },
    laneErrors,
    at: now,
  }
}

/**
 * The issue for a row: the cached full copy with the current header laid over it (the search is
 * newer for status and summary), or the header alone when it was never read in full.
 */
function current(cache, h) {
  const c = cache.issues[h.key]
  if (!c) return { ...h, events: [], description: '', full: false }
  const { updated, ...fresh } = h
  const out = { ...c, ...fresh, updated: c.updated }
  // A header without labels or a due date means the issue has none now; the cached copy's must not stay.
  if (!fresh.labels) delete out.labels
  if (!fresh.dueAt) delete out.dueAt
  return out
}

/**
 * The lanes as shown (only the enabled ones), each row `{ issue, lane, unread, newCount, mark }`,
 * sorted by triage priority then the newest activity.
 * @param {{ cfg: object, lists: object, cache: object, seen: object, verdicts?: Record<string, object>, now?: number }} o
 */
function buildView(o) {
  const { cfg, lists, cache, seen } = o
  const verdicts = o.verdicts || {}
  const now = o.now || Date.now()
  const byLane = Object.fromEntries(LANES.map((l) => [l.id, []]))
  const row = (issue, lane) => {
    const mark = seen.marks[issue.key]
    const fresh = issue.full ? newEvents(issue, mark, lane) : []
    // Unread: others did something since the mark, or the person flagged it (Mark unread).
    return { issue, lane, mark, unread: fresh.length > 0 || isFlagged(seen, issue.key), newCount: fresh.length, verdict: verdicts[issue.key] || null }
  }
  for (const h of (lists && lists.assigned) || []) {
    const lane = statusLane(h, cfg.onHold)
    if (cfg.lanes[lane] && lane !== 'done') byLane[lane].push(row(current(cache, h), lane))
  }
  if (cfg.lanes.done) for (const h of (lists && lists.done) || []) byLane.done.push({ issue: { ...h, events: [], full: false }, lane: 'done', unread: false, newCount: 0, verdict: verdicts[h.key] || null })
  if (cfg.lanes.mentioned) {
    const since = now - cfg.mentionDays * 86400000
    for (const h of (lists && lists.candidates) || []) {
      const issue = current(cache, h)
      if (issue.full && issue.events.some((e) => e.mentionsMe && !e.mine && e.at >= since)) byLane.mentioned.push(row(issue, 'mentioned'))
    }
  }
  const lanes = LANES.filter((l) => cfg.lanes[l.id]).map((l) => ({ id: l.id, title: l.title, rows: sortRows(byLane[l.id]) }))
  const unread = lanes.filter((l) => l.id !== 'done').reduce((n, l) => n + l.rows.filter((r) => r.unread).length, 0)
  return { lanes, unread }
}

/** Every row of a view, lane by lane. */
function allRows(view) {
  return view.lanes.flatMap((l) => l.rows)
}

module.exports = { poll, buildView, allRows, current, emptyCache, loadCache, BUDGET, CONCURRENCY, MAX_CACHED }
