'use strict'
// What the plugin keeps of an issue: its header fields from a search, and from a full read its
// description and activity (comments and the field changes that count, oldest first), with the
// mentions of the person found in the ADF bodies, and the attachments' metadata (the reader's
// images and links; their bytes are fetched only when the issue is opened).

const { adfToText, mentionIds } = require('./adf')
const { parseTime, cut } = require('./util')

// The changelog fields that count as activity besides comments (design "Unread": status,
// assignee, priority). Others (labels, sprint, rank) change all the time and say nothing to
// the person.
const CHANGE_FIELDS = { status: 'status', assignee: 'assignee', priority: 'priority' }

const CUTS = {
  // The cache keeps enough for triage and the rows; a reader (overlay, `ccc jira show`) reads
  // the issue fresh with the large cuts.
  cache: { description: 6000, comment: 3000, events: 60 },
  full: { description: 60000, comment: 20000, events: 500 },
}

/** Jira's date-only `duedate` as ms (0 when missing or unreadable). */
function parseDue(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) ? Date.parse(value) || 0 : 0
}

/** The issue's labels as strings, at most 30 of 100 characters (they go into plain-text tags). */
function jiraLabels(value) {
  if (!Array.isArray(value)) return []
  return value.filter((l) => typeof l === 'string' && l.trim()).map((l) => cut(l.trim(), 100)).slice(0, 30)
}

/** The header of an issue from a search's `fields` (also the start of a full read). */
function header(key, f) {
  const status = (f && f.status) || {}
  const cat = (status.statusCategory && status.statusCategory.key) || ''
  return {
    key,
    project: (f.project && f.project.key) || key.split('-')[0],
    summary: typeof f.summary === 'string' ? f.summary : '',
    status: typeof status.name === 'string' ? status.name : '',
    // Jira's category keys: new (To Do), indeterminate (In Progress), done; 'undefined' is a
    // status nobody categorised, treated like To Do.
    category: cat === 'indeterminate' || cat === 'done' ? cat : 'new',
    priority: (f.priority && f.priority.name) || '',
    type: (f.issuetype && f.issuetype.name) || '',
    assignee: (f.assignee && f.assignee.displayName) || '',
    assigneeId: (f.assignee && f.assignee.accountId) || '',
    reporter: (f.reporter && f.reporter.displayName) || '',
    reporterId: (f.reporter && f.reporter.accountId) || '',
    updated: typeof f.updated === 'string' ? f.updated : '',
    updatedAt: parseTime(f.updated),
    created: parseTime(f.created),
    closedAt: parseTime(f.statuscategorychangedate) || parseTime(f.resolutiondate) || 0,
    // The due date (a plain `2026-11-05`, read as that day's start in UTC), only when set; the feed
    // for Inbox shows it. Left out otherwise so a header without one keeps its shape.
    ...(parseDue(f.duedate) ? { dueAt: parseDue(f.duedate) } : {}),
    // Jira's own labels, for the `label:<name>` tags of the inbox feed; left out when there are none.
    ...(jiraLabels(f.labels).length ? { labels: jiraLabels(f.labels) } : {}),
  }
}

/**
 * A full issue (client.issue) as kept: header, description text, events oldest first.
 *
 * events: `{ id, kind: 'comment'|'change'|'mention', at, by, byId, mine, text, mentionsMe? }`.
 * A `mention` event stands for the description mentioning the person (its time: the last
 * description edit by someone else, else the creation); comments carry `mentionsMe` themselves.
 *
 * @param {object} raw the issue as Jira sent it
 * @param {string} me the person's accountId
 * @param {'cache'|'full'} [size]
 */
function compact(raw, me, size = 'cache') {
  const lim = CUTS[size] || CUTS.cache
  const f = raw.fields || {}
  const h = header(raw.key, f)
  const events = []
  for (const c of (f.comment && f.comment.comments) || []) {
    if (!c || c.id == null) continue
    const a = c.author || {}
    const mine = Boolean(me) && a.accountId === me
    events.push({
      id: `c${c.id}`,
      kind: 'comment',
      at: parseTime(c.created),
      by: a.displayName || 'someone',
      byId: a.accountId || '',
      mine,
      text: cut(adfToText(c.body), lim.comment) || '(comment)',
      ...(!mine && me && mentionIds(c.body).includes(me) ? { mentionsMe: true } : {}),
    })
  }
  let descEditAt = 0
  let descEditBy = ''
  for (const hist of (raw.changelog && raw.changelog.histories) || []) {
    if (!hist || hist.id == null) continue
    const a = hist.author || {}
    const at = parseTime(hist.created)
    const items = (hist.items || []).filter((i) => i && CHANGE_FIELDS[i.field])
    if ((hist.items || []).some((i) => i && i.field === 'description') && a.accountId !== me && at > descEditAt) {
      descEditAt = at
      descEditBy = a.displayName || 'someone'
    }
    if (!items.length) continue
    events.push({
      id: `h${hist.id}`,
      kind: 'change',
      at,
      by: a.displayName || 'someone',
      byId: a.accountId || '',
      mine: Boolean(me) && a.accountId === me,
      text: changeLine(items),
      // "assigned it to the person" (design "Unread"): a change of assignee to them by someone else.
      ...(items.some((i) => i.field === 'assignee' && i.to === me) ? { assignedMe: true } : {}),
    })
  }
  if (me && mentionIds(f.description).includes(me)) {
    const by = descEditAt ? descEditBy : h.reporter || 'someone'
    const byId = descEditAt ? '' : h.reporterId
    if (descEditAt || byId !== me) {
      events.push({ id: 'd', kind: 'mention', at: descEditAt || h.created, by, byId, mine: false, text: `${by} mentioned you in the description`, mentionsMe: true })
    }
  }
  events.sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1))
  return {
    ...h,
    description: cut(adfToText(f.description), lim.description),
    events: events.slice(-lim.events),
    attachments: attachmentsOf(raw),
    full: true,
  }
}

const MAX_ATTACHMENTS = 100

/**
 * The issue's attachments (the `attachment` field) as kept: `{ id, name, mime, size, created, by }`,
 * newest first, at most 100. The id goes into a URL path and a file name, so only digits pass;
 * `size` is null when Jira did not say.
 */
function attachmentsOf(raw) {
  const list = raw && raw.fields && Array.isArray(raw.fields.attachment) ? raw.fields.attachment : []
  const out = []
  for (const a of list) {
    if (!a || typeof a !== 'object') continue
    const id = String(a.id == null ? '' : a.id)
    if (!/^[0-9]{1,20}$/.test(id)) continue
    out.push({
      id,
      name: cut(typeof a.filename === 'string' && a.filename.trim() ? a.filename.trim() : `attachment ${id}`, 200),
      mime: typeof a.mimeType === 'string' ? a.mimeType.toLowerCase().split(';')[0].trim() : '',
      size: Number.isFinite(a.size) && a.size >= 0 ? a.size : null,
      created: parseTime(a.created),
      by: (a.author && typeof a.author.displayName === 'string' && a.author.displayName) || '',
    })
  }
  out.sort((x, y) => y.created - x.created || Number(y.id) - Number(x.id))
  return out.slice(0, MAX_ATTACHMENTS)
}

function changeLine(items) {
  return items.map((i) => `${CHANGE_FIELDS[i.field]}: ${i.fromString || '-'} → ${i.toString || '-'}`).join('; ')
}

/** The newest activity (anyone's), else the last update, else the creation: a lane's order. */
function newestActivity(issue) {
  const ev = issue.events && issue.events.length ? issue.events[issue.events.length - 1].at : 0
  return Math.max(ev, issue.closedAt || 0, issue.updatedAt || 0, issue.created || 0)
}

module.exports = { header, compact, attachmentsOf, newestActivity, CHANGE_FIELDS }
