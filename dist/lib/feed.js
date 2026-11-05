'use strict'
// The `inbox-feed` service (v2, 0.7.0) this plugin provides to Inbox: the pure parts. The host
// (dist/host.js) wires them to its view and its existing open and mark paths.
//
// - Built only from the cached view the panel shows (poll.buildView), never an API call: Inbox
//   calls `snapshot()` whenever a provider joins and a service call has no rate limit from the app.
// - The scope is the view itself: the issues of the Backlog, In progress, On hold and Mentioned
//   lanes (so a hidden lane, `mentionDays` and the caps of the searches already apply). The Done
//   lane is not in it: a closed or resolved issue is no longer the person's business, so it leaves
//   the feed as `gone`. Nothing is dropped for being quiet and there is no count cap below the
//   contract's 1000: what matters is decided by Inbox's rules, not here.
// - Triage verdicts stay in this plugin's lanes: the feed carries facts, in the places a person's
//   rules match (`labels`: assigned / mentioned / priority:high / type:bug / due:YYYY-MM-DD /
//   assignee:<name> / label:<jira label>; `place`: the project key and the status name).
// - `rev` is the issue's `updated` string: any change on the issue (comment, status, assignee)
//   moves it, which is what Inbox's "done until it changes" compares. Not the seen state: that
//   changes when the person opens the issue, and Done would then come back by itself.
// - `diffFeed` is how events are made: after each poll and each mark the host compares the list with
//   what it last told and emits `item` for any changed field and `gone` for a missing id.
// - Plain data only (the registry copies it with structuredClone); every string is cut to the
//   contract's caps here too, since Inbox treats a source as untrusted.

const { cut, oneLine } = require('./util')
const { newestActivity } = require('./model')

const DESCRIBE = Object.freeze({ label: 'Jira', badge: 'JIRA', color: 'blue', kind: 'issues' })
const FEATURES = Object.freeze([])
const MAX_ITEMS = 1000
const MAX_GONE = 500
const CUTS = { title: 300, preview: 1000, name: 120, label: 40, labels: 20, status: 60, scope: 120, message: 300 }
const ACTION_LABELS = { open: 'Open', markRead: 'Mark read', markUnread: 'Mark unread' }
const LANE_TITLES = { backlog: 'Backlog', inProgress: 'In progress', onHold: 'On hold' }

/**
 * `scope` of describe(): what the feed holds, from the settings, right for every combination of
 * lanes (a hidden lane is not fetched, and the Done lane is never in the feed).
 */
function scopeLine(cfg) {
  const lanes = (cfg && cfg.lanes) || {}
  const parts = []
  const open = Object.keys(LANE_TITLES).filter((id) => lanes[id] !== false && lanes[id] !== undefined)
  if (open.length === Object.keys(LANE_TITLES).length) parts.push('my open issues')
  else if (open.length) parts.push(`my issues in ${open.map((id) => LANE_TITLES[id]).join(', ')}`)
  if (lanes.mentioned) {
    const d = Math.max(1, Math.floor(Number(cfg.mentionDays) || 0))
    parts.push(`mentions of the last ${d === 1 ? 'day' : `${d} days`}`)
  }
  return cut(parts.length ? parts.join(' + ') : 'nothing (every lane Inbox lists is off)', CUTS.scope)
}

/** `2026-11-05` of a due date in ms (a plain date read as UTC midnight, as model.header does). */
function dueDay(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Who did the last thing: the one who mentioned the person (Mentioned lane), else the last other person's event, else the reporter. */
function actorOf(issue, lane, mentionedBy) {
  if (lane === 'mentioned' && mentionedBy) {
    const by = mentionedBy(issue)
    if (by) return by
  }
  const events = (issue.events || []).filter((e) => e && !e.mine && e.by && e.by !== 'someone')
  if (events.length) return events[events.length - 1].by
  return issue.reporter || ''
}

/** The latest comment's text, else the start of the description. */
function previewOf(issue) {
  const comments = (issue.events || []).filter((e) => e && e.kind === 'comment' && e.text)
  const text = comments.length ? comments[comments.length - 1].text : issue.description || ''
  return cut(oneLine(text), CUTS.preview)
}

/**
 * One row of the view as a FeedItem.
 * @param {{ issue: object, lane: string, unread: boolean }} row poll.buildView's row
 * @param {{ mentionedBy?: (issue: object) => string, since?: number }} [o]
 *   `since`: ms; an assigned issue where someone mentioned the person after it counts as mentioned
 */
function issueItem(row, o = {}) {
  const i = row.issue
  const lane = row.lane
  const at = Number.isFinite(i.updatedAt) && i.updatedAt > 0 ? i.updatedAt : newestActivity(i)
  const mentioned = lane === 'mentioned' || (o.since !== undefined && (i.events || []).some((e) => e && e.mentionsMe && !e.mine && e.at >= o.since))
  const item = {
    id: i.key,
    rev: cut(String(i.updated || at || 1), 100),
    title: cut(oneLine(`${i.key} ${i.summary || ''}`), CUTS.title),
    time: Math.max(1, Number(at) || 0),
    read: !row.unread,
    place: { kind: 'project', name: cut(oneLine(i.project || String(i.key).split('-')[0]), CUTS.name) },
    actions: [{ id: 'open', label: ACTION_LABELS.open }, row.unread ? { id: 'markRead', label: ACTION_LABELS.markRead } : { id: 'markUnread', label: ACTION_LABELS.markUnread }],
  }
  const status = cut(oneLine(i.status || ''), CUTS.status)
  if (status) item.place.status = status
  const preview = previewOf(i)
  if (preview) item.preview = preview
  const by = cut(oneLine(actorOf(i, lane, o.mentionedBy)), CUTS.name)
  if (by) item.from = { name: by }
  // Assigned to the person (the three status lanes) or only mentioned in it.
  item.to = lane === 'mentioned' ? 'cc' : 'direct'
  if (mentioned) item.mentionsMe = true
  const labels = [lane === 'mentioned' ? 'mentioned' : 'assigned']
  if (lane !== 'mentioned' && mentioned) labels.push('mentioned')
  if (i.priority) labels.push(`priority:${oneLine(i.priority)}`)
  if (i.type) labels.push(`type:${oneLine(i.type)}`)
  if (Number.isFinite(i.dueAt) && i.dueAt > 0) labels.push(`due:${dueDay(i.dueAt)}`)
  // Who has it, when it is not the person: a rule can tell "mentioned on Ann's issue" from an unowned one.
  if (lane === 'mentioned') labels.push(i.assignee ? `assignee:${oneLine(i.assignee)}` : 'unassigned')
  for (const l of Array.isArray(i.labels) ? i.labels : []) if (typeof l === 'string' && oneLine(l)) labels.push(`label:${oneLine(l)}`)
  const seen = new Set()
  const clean = []
  for (const l of labels) {
    const s = cut(oneLine(l), CUTS.label)
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase())
      clean.push(s)
    }
  }
  if (clean.length) item.labels = clean.slice(0, CUTS.labels)
  return item
}

/**
 * The whole scope as items, newest first (then the id, a stable order), at most `limit`
 * (default 1000, the contract's cap; `act` passes Infinity to check an id against everything).
 * `only` builds just that id's item (a lookup, not a list: no other issue is built or sorted).
 * @param {object[]} rows poll.allRows(view)
 * @param {{ mentionedBy?: (issue: object) => string, since?: number, limit?: number, only?: string }} [o]
 */
function feedItems(rows, o = {}) {
  const byId = new Map()
  for (const r of rows) {
    // The Done lane is out of the scope; an issue can sit in two lanes only through a stale cache,
    // and the feed id is the key, so once.
    if (!r || !r.issue || !r.issue.key || r.lane === 'done' || byId.has(r.issue.key)) continue
    if (o.only !== undefined && r.issue.key !== o.only) continue
    byId.set(r.issue.key, issueItem(r, o))
  }
  const limit = o.limit === undefined ? MAX_ITEMS : o.limit
  return [...byId.values()].sort((a, b) => b.time - a.time || (a.id < b.id ? -1 : 1)).slice(0, limit)
}

/** JSON with sorted keys: two items are the same when this is. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

/**
 * What changed between the list last told and the list now.
 * @param {object[] | Map<string, object>} prev items last told
 * @param {object[]} next items now
 * @returns {{ items: object[], gone: string[] }} `items`: new or changed (any field), `gone`: ids missing now
 */
function diffFeed(prev, next) {
  const before = prev instanceof Map ? prev : new Map((prev || []).map((i) => [i.id, i]))
  const now = new Set(next.map((i) => i.id))
  const items = next.filter((i) => !before.has(i.id) || stable(before.get(i.id)) !== stable(i))
  const gone = [...before.keys()].filter((id) => !now.has(id))
  return { items, gone }
}

/** `gone` ids in the events' bound (1-500 per event). */
function goneChunks(ids) {
  const out = []
  for (let i = 0; i < ids.length; i += MAX_GONE) out.push(ids.slice(i, i + MAX_GONE))
  return out
}

/** An error message for a Sync: one capped line. */
function feedMessage(text) {
  return cut(oneLine(text), CUTS.message)
}

module.exports = { DESCRIBE, FEATURES, MAX_ITEMS, MAX_GONE, ACTION_LABELS, scopeLine, issueItem, feedItems, diffFeed, goneChunks, feedMessage }
