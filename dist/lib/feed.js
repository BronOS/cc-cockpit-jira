'use strict'
// The `inbox-feed` service (v1, Inbox's contract): the pure mapping from the panel's rows to the
// feed items. The host (dist/host.js) wires it to its cache and its issue view.
//
// - Built from the rows the panel's lanes show (poll.buildView), never from an API call: Inbox
//   reads every provider every minute and on each `changed`, so a read must cost nothing.
// - `level` is the plugin's own triage: the verdict of jev-triage when there is one, else the
//   rule the plugin hands triage as its hint or floor (triage.hintFor), so a row without a verdict
//   (triage off, an error, not judged yet) still ranks the way the status implies.
// - `rev` is the issue's `updated` string: any change on the issue (comment, status, assignee)
//   moves it, which is what Inbox's "done until it changes" compares. Not the seen state: that
//   changes when the person opens the issue, and Done would then come back by itself.
// - Everything is capped here too (the consumer caps again; it never trusts a feed): a summary can
//   be long, and the feed is plain data copied on every call.

const { hintFor } = require('./triage')
const { cut, oneLine } = require('./util')
const { RANK } = require('./lanes')

const DESCRIBE = { label: 'Jira', badge: 'JIRA', color: 'blue', kind: 'issues' }
const LIMIT = { def: 50, min: 1, max: 50 }
const CAPS = { title: 300, from: 120, where: 120, message: 300 }

/** The `items()` limit: an integer 1..50, 50 when absent or not a number. */
function feedLimit(value) {
  if (value === undefined || value === null) return LIMIT.def
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return LIMIT.def
  return Math.min(LIMIT.max, Math.max(LIMIT.min, n))
}

/** The arguments of `items()`: nothing or `{ limit }`; anything else is refused (another plugin calls it). */
function itemsOptions(o) {
  if (o === undefined || o === null) return { limit: LIMIT.def }
  if (typeof o !== 'object' || Array.isArray(o)) throw new Error('jira: the options are an object')
  return { limit: feedLimit(o.limit) }
}

/** The triage level of a row: the verdict, else what the status and priority imply. */
function levelOf(row) {
  const v = row.verdict && row.verdict.priority
  if (typeof v === 'string' && v in RANK) return v
  const h = hintFor(row.lane, Boolean(row.newCount > 0 || row.unread), row.issue.priority)
  const p = (h.hint && h.hint.priority) || h.floor
  return p in RANK ? p : 'fyi'
}

/** "assigned to you · High", "mentioned by Bob Jones · Medium". */
function fromOf(row, mentionedBy) {
  const who = row.lane === 'mentioned' ? `mentioned by ${mentionedBy(row.issue) || 'someone'}` : 'assigned to you'
  return [who, row.issue.priority].filter(Boolean).join(' · ')
}

/**
 * One row as a FeedItem.
 * @param {{ issue: object, lane: string, unread: boolean, verdict?: object|null, newCount?: number }} row
 * @param {(issue: object) => string} mentionedBy triage.mentionedBy
 */
function toItem(row, mentionedBy) {
  const i = row.issue
  const at = Number.isFinite(i.updatedAt) && i.updatedAt > 0 ? i.updatedAt : 0
  const item = {
    id: i.key,
    rev: String(i.updated || at),
    title: cut(oneLine(`${i.key} ${i.summary || ''}`), CAPS.title),
    from: cut(fromOf(row, mentionedBy), CAPS.from),
    where: cut(oneLine(i.status), CAPS.where),
    at,
    level: levelOf(row),
    unread: Boolean(row.unread),
  }
  // A Done issue's due date says nothing any more.
  if (Number.isFinite(i.dueAt) && i.dueAt > 0 && row.lane !== 'done') item.dueAt = i.dueAt
  return item
}

/**
 * The feed items of the view's rows: best first (level, then the newest update), at most `limit`,
 * noise left out unless nothing else is there.
 * @param {object[]} rows poll.allRows(view)
 * @param {{ limit?: number, mentionedBy: (issue: object) => string }} o
 */
function buildItems(rows, o) {
  const limit = feedLimit(o.limit)
  const seen = new Set()
  const all = []
  for (const r of rows) {
    // An issue can sit in two lanes only through a stale cache; the feed id is the key, so once.
    if (!r || !r.issue || !r.issue.key || seen.has(r.issue.key)) continue
    seen.add(r.issue.key)
    all.push(toItem(r, o.mentionedBy))
  }
  all.sort((a, b) => RANK[a.level] - RANK[b.level] || b.at - a.at || (a.id < b.id ? -1 : 1))
  const real = all.filter((x) => x.level !== 'noise')
  return (real.length ? real : all).slice(0, limit)
}

/** An error message for `items().message`: one capped line, never more than the plugin's own text. */
function feedMessage(text) {
  return cut(oneLine(text), CAPS.message)
}

module.exports = { DESCRIBE, CAPS, LIMIT, feedLimit, itemsOptions, levelOf, toItem, buildItems, feedMessage }
