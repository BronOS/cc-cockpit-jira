'use strict'
// The three searches (design "Fetching"). Only validated values reach a query: day counts are
// integers the settings check clamped, project keys passed the key check and are quoted anyway,
// so no setting can widen a search (`ABC) OR (project is not EMPTY`).

/** The fields every search asks for: enough for a lane, a row and the "did it change" test. */
const SEARCH_FIELDS = ['summary', 'status', 'priority', 'issuetype', 'updated', 'assignee', 'reporter', 'project']
const DONE_FIELDS = [...SEARCH_FIELDS, 'statuscategorychangedate', 'resolutiondate']

const CAPS = { assigned: 500, done: 100, mentioned: 200 }

/** A Jira project key (`ABC`, `ABC_2`), upper-cased; null for anything else. */
function projectKey(value) {
  const s = String(value == null ? '' : value).trim().toUpperCase()
  return /^[A-Z][A-Z0-9_]{0,49}$/.test(s) ? s : null
}

function days(n, max) {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v) || v < 1) return 1
  return Math.min(v, max)
}

function assignedJql() {
  return 'assignee = currentUser() AND statusCategory != Done ORDER BY priority ASC, updated DESC'
}

function doneJql(doneDays) {
  return `assignee = currentUser() AND statusCategory = Done AND statusCategoryChangedDate >= -${days(doneDays, 365)}d ORDER BY statusCategoryChangedDate DESC`
}

/**
 * Candidates for Mentioned: recently updated issues of the given projects that are not the
 * person's (assigned ones keep a mention in their own lane). Null when no project is left after
 * the key check: an empty `project in ()` is a JQL error, and no project means nothing to search.
 */
function mentionedJql(projects, mentionDays) {
  const keys = [...new Set((projects || []).map(projectKey).filter(Boolean))]
  if (!keys.length) return null
  const list = keys.map((k) => `"${k}"`).join(', ')
  return `project in (${list}) AND updated >= -${days(mentionDays, 90)}d AND (assignee != currentUser() OR assignee is EMPTY) ORDER BY updated DESC`
}

module.exports = { SEARCH_FIELDS, DONE_FIELDS, CAPS, projectKey, assignedJql, doneJql, mentionedJql }
