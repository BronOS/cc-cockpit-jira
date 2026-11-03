'use strict'
// The plugin's own seen state (Jira has none; design "Unread"), ported from the old connector.
//
// A mark per issue: the time (ms) of the newest activity of others the person has seen. An issue
// is unread while it has activity of others after its mark: a comment, a change of status /
// assignee / priority, an assignment to them, a mention. For a Mentioned issue (not theirs) only
// mentions count: the comments of a team's busy issue are not the person's business until they
// are named in one.
//
// The first run marks everything seen as it is, so only what happens next is new. "First run"
// lasts until a poll read every issue it found: a poll that deferred some reads (the per-poll
// budget) leaves `seeded` false, and the deferred ones are marked as they arrive, instead of
// showing up as a wall of unread on the next poll.

const MAX_MARKS = 3000

/** A fresh state for one site and account (marks of another account mean nothing here). */
function emptySeen(site, accountId) {
  return { site, accountId, seeded: false, marks: {} }
}

/** The stored state when it belongs to this site and account, else a fresh one. */
function loadSeen(stored, site, accountId) {
  if (stored && stored.site === site && stored.accountId === accountId && stored.marks && typeof stored.marks === 'object') {
    return { site, accountId, seeded: Boolean(stored.seeded), marks: { ...stored.marks } }
  }
  return emptySeen(site, accountId)
}

/** The events that count for unread in this lane: others' activity, or only mentions. */
function counted(issue, lane) {
  const ev = (issue.events || []).filter((e) => !e.mine)
  return lane === 'mentioned' ? ev.filter((e) => e.mentionsMe) : ev
}

/** The events of others after the mark (all of them when the issue was never marked). */
function newEvents(issue, mark, lane) {
  const m = typeof mark === 'number' ? mark : -Infinity
  return counted(issue, lane).filter((e) => e.at > m)
}

function isUnread(issue, mark, lane) {
  return newEvents(issue, mark, lane).length > 0
}

/** The time of the newest counted activity, 0 when there is none. */
function newestCounted(issue, lane) {
  let at = 0
  for (const e of counted(issue, lane)) if (e.at > at) at = e.at
  return at
}

/**
 * Mark the issues not marked yet as seen as they are, while the state is not seeded. Mutates and
 * returns `seen`.
 * @param {{ issue: object, lane: string }[]} entries every fully read issue of this poll
 * @param {boolean} complete the poll read everything it found (nothing deferred)
 */
function seed(seen, entries, complete) {
  if (seen.seeded) return seen
  for (const { issue, lane } of entries) {
    if (!(issue.key in seen.marks)) seen.marks[issue.key] = newestCounted(issue, lane)
  }
  if (complete && entries.length) seen.seeded = true
  return seen
}

/**
 * Seen = the newest activity at the moment the person opened it or pressed Mark read (all
 * activity, so a later mention in a Mentioned issue is still new). An issue with no activity of
 * others keeps a mark of `now`, which nothing earlier can pass.
 */
function markRead(seen, issue, now = Date.now()) {
  const newest = newestCounted(issue, 'any')
  seen.marks[issue.key] = newest || now
  return bound(seen)
}

/**
 * Unread again: the mark just before the newest counted activity of others. Throws when there is
 * none (nothing to be unread about).
 */
function markUnread(seen, issue, lane) {
  const newest = newestCounted(issue, lane)
  if (!newest) throw new Error(`${issue.key}: nothing from others on this issue to mark unread`)
  seen.marks[issue.key] = newest - 1
  return bound(seen)
}

/** At most MAX_MARKS marks: the oldest ones go first (issues nobody touched for long). */
function bound(seen, max = MAX_MARKS) {
  const keys = Object.keys(seen.marks)
  if (keys.length <= max) return seen
  keys.sort((a, b) => seen.marks[a] - seen.marks[b])
  for (const k of keys.slice(0, keys.length - max)) delete seen.marks[k]
  return seen
}

module.exports = { emptySeen, loadSeen, newEvents, isUnread, newestCounted, seed, markRead, markUnread, bound, MAX_MARKS }
