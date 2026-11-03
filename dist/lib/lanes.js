'use strict'
// Lanes (design "Lanes"): from the status category, To Do -> Backlog, In Progress -> In progress
// unless the status is one of `onHoldStatuses` (then On hold), Done -> Done; plus Mentioned for
// issues that are not the person's. Inside a lane: triage priority, then the newest activity.

const { newestActivity } = require('./model')

const LANES = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'inProgress', title: 'In progress' },
  { id: 'mentioned', title: 'Mentioned' },
  { id: 'onHold', title: 'On hold' },
  { id: 'done', title: 'Done' },
]
const LANE_IDS = LANES.map((l) => l.id)

/** The status lane of an issue assigned to the person. */
function statusLane(issue, onHold) {
  if (issue.category === 'done') return 'done'
  // A status named in onHoldStatuses wins over its category: "Waiting for customer" may be
  // categorised In Progress or To Do depending on the workflow, and either way it is not the
  // person's to move now.
  if (onHold && onHold.has(String(issue.status || '').trim().toLowerCase())) return 'onHold'
  if (issue.category === 'indeterminate') return 'inProgress'
  return 'backlog'
}

const RANK = { urgent: 0, action: 1, fyi: 2, noise: 3 }

/**
 * Rows of one lane in the panel's order. `verdict` is the triage verdict or null: without one (no
 * triage, an error) a row sorts after the judged ones, by its activity.
 * @param {{ issue: object, verdict?: { priority: string } | null }[]} rows
 */
function sortRows(rows) {
  const rank = (r) => (r.verdict && r.verdict.priority in RANK ? RANK[r.verdict.priority] : 4)
  return [...rows].sort((a, b) => rank(a) - rank(b) || newestActivity(b.issue) - newestActivity(a.issue) || (a.issue.key < b.issue.key ? -1 : 1))
}

module.exports = { LANES, LANE_IDS, statusLane, sortRows, RANK }
