'use strict'
// What jev-triage gets for one issue (its `triage` v1 service, source `jira`): the item text,
// the hint or floor (the old connector's rules), and short fields rules can match.
//
// Hints (design "Triage"), the cheapest layer, so Jev only sees what the status cannot decide:
// - Done -> noise.
// - nothing new: In progress (not On hold) -> action; anything else -> noise. A Critical issue
//   nobody touched since the person last looked is not urgent (2026-10-02 in the old cockpit: an
//   issue stayed red after delivery though nobody wrote since).
// - unread with priority High / Highest / Critical (or Blocker) -> urgent.
// - any other unread one goes to Jev with `floor` = what the status implies (In progress:
//   action, else fyi), so Jev cannot bury it.
// - Mentioned: no hint, floor fyi (a mention is at least worth reading).

const { cut, oneLine, stamp } = require('./util')
const { newEvents } = require('./seen')

const URGENT_PRIORITIES = new Set(['highest', 'high', 'critical', 'blocker'])

/** `2-High` and `High` alike: the name without a numeric scheme prefix, lower case. */
function priorityName(p) {
  return String(p || '').replace(/^\s*\d+\s*-\s*/, '').trim().toLowerCase()
}

/**
 * @returns {{ hint?: { priority: string }, floor?: string }}
 */
function hintFor(lane, unread, priority) {
  if (lane === 'done') return { hint: { priority: 'noise' } }
  if (lane === 'mentioned') return { floor: 'fyi' }
  if (!unread) return { hint: { priority: lane === 'inProgress' ? 'action' : 'noise' } }
  if (URGENT_PRIORITIES.has(priorityName(priority))) return { hint: { priority: 'urgent' } }
  return { floor: lane === 'inProgress' ? 'action' : 'fyi' }
}

const TEXT_CUTS = { description: 1500, event: 1200, context: 3, newEvents: 12 }

/** The first line of every triage text: also all of it in `summary` mode. */
function firstLine(issue) {
  const meta = [issue.type, issue.status, issue.priority].filter(Boolean).join(', ')
  return `Jira ${issue.key}${meta ? ` (${meta})` : ''} in ${issue.project}: ${oneLine(issue.summary)}`
}

function eventLine(e) {
  const when = stamp(e.at)
  if (e.kind === 'comment') return `- ${e.by} commented${when ? ` (${when})` : ''}: ${cut(e.text, TEXT_CUTS.event)}`
  if (e.kind === 'mention') return `- ${e.text}${when ? ` (${when})` : ''}`
  return `- ${e.by} changed ${e.text}${when ? ` (${when})` : ''}`
}

/**
 * The text Jev reads. `full`: the header line, who reported / is assigned, the description (cut),
 * then the new activity since seen, marked as new, and up to three earlier events as context.
 * `summary`: the header line only (for employers who object to issue text leaving).
 *
 * @param {object} issue a kept issue (model.compact, or a search header for Done)
 * @param {{ mode: 'full'|'summary', lane: string, mark?: number, meName?: string }} o
 */
function triageText(issue, o) {
  const head = firstLine(issue)
  if (o.mode === 'summary') return head
  const lines = [head]
  const assignee = o.lane === 'mentioned' ? (issue.assignee ? `assigned to ${issue.assignee}` : 'unassigned') : 'assigned to the person (you)'
  lines.push(`Reported by ${issue.reporter || 'unknown'}; ${assignee}.`)
  if (o.lane === 'mentioned') {
    const by = mentionedBy(issue)
    lines.push(`The person is not assigned; ${by ? `${by} mentioned them` : 'they were mentioned'} in it.`)
  }
  if (issue.description) lines.push('', 'Description:', cut(issue.description, TEXT_CUTS.description))
  if (issue.full) {
    const fresh = newEvents(issue, o.mark, o.lane === 'mentioned' ? 'any' : o.lane)
    const events = issue.events || []
    const firstNew = fresh.length ? events.indexOf(fresh[0]) : events.length
    const context = events.slice(Math.max(0, firstNew - TEXT_CUTS.context), firstNew)
    if (context.length) lines.push('', 'Earlier (context only):', ...context.map(eventLine))
    if (fresh.length) {
      const shown = fresh.slice(-TEXT_CUTS.newEvents)
      lines.push('', `New since the person last looked (${fresh.length}):`, ...shown.map(eventLine))
    } else {
      lines.push('', 'Nothing new since the person last looked.')
    }
  }
  return lines.join('\n')
}

/** Who mentioned the person last (the row's "mentioned by X"), '' when nobody did. */
function mentionedBy(issue) {
  const m = (issue.events || []).filter((e) => e.mentionsMe && !e.mine)
  return m.length ? m[m.length - 1].by : ''
}

/**
 * One triage item. Field values are short strings (jev-triage rules match them, case-insensitive).
 * @param {{ issue: object, lane: string, unread: boolean, mark?: number }} row
 * @param {'full'|'summary'} mode
 */
function triageItem(row, mode) {
  const { issue, lane, unread } = row
  const item = {
    id: issue.key,
    text: triageText(issue, { mode, lane, mark: row.mark }),
    fields: {
      project: issue.project || '',
      status: issue.status || '',
      type: issue.type || '',
      priority: issue.priority || '',
      lane,
      assignee: issue.assignee || '',
      reporter: issue.reporter || '',
    },
  }
  const h = hintFor(lane, unread, issue.priority)
  if (h.hint) item.hint = h.hint
  if (h.floor) item.floor = h.floor
  return item
}

module.exports = { hintFor, triageText, triageItem, firstLine, priorityName, mentionedBy }
