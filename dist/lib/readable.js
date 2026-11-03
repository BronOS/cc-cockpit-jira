'use strict'
// The issue as readable plain text: what the reviewer overlay shows (reviewer.annotate), what
// `ccc jira show` prints, and what Discuss / New session hand to Claude (design "Discuss with
// Claude"): header fields, the description, then comments and field changes oldest first with
// author and date, the new ones (since the person's mark) marked `[new]`.

const { cut, stamp, oneLine } = require('./util')
const { newEvents } = require('./seen')

/**
 * @param {object} issue a kept issue (model.compact, ideally the `full` size)
 * @param {{ site: string, mark?: number, lane?: string }} o
 */
function readableText(issue, o) {
  const fresh = new Set(newEvents(issue, o.mark, o.lane === 'mentioned' ? 'any' : o.lane || 'any').map((e) => e.id))
  const lines = [
    `${issue.key}: ${oneLine(issue.summary)}`,
    `Type: ${issue.type || '-'}    Status: ${issue.status || '-'}    Priority: ${issue.priority || '-'}`,
    `Project: ${issue.project || '-'}    Reporter: ${issue.reporter || '-'}    Assignee: ${issue.assignee || 'unassigned'}`,
    `Created: ${stamp(issue.created) || '-'}    Updated: ${stamp(issue.updatedAt) || '-'}`,
    `URL: ${browseUrl(o.site, issue.key)}`,
    '',
    'Description',
    '-----------',
    issue.description || '(no description)',
  ]
  const events = (issue.events || []).filter((e) => e.kind !== 'mention')
  if (events.length) {
    const comments = events.filter((e) => e.kind === 'comment').length
    lines.push('', `Activity (${comments} comment${comments === 1 ? '' : 's'}, oldest first)`, '------------------------------')
    for (const e of events) {
      const tag = fresh.has(e.id) ? '[new] ' : ''
      if (e.kind === 'comment') {
        lines.push('', `${tag}${e.by}, ${stamp(e.at)}:`, e.text)
      } else {
        lines.push('', `${tag}${e.by}, ${stamp(e.at)}: changed ${e.text}`)
      }
    }
  }
  return lines.join('\n')
}

/** The issue's page on the site. The key passed the key check, so it needs no encoding. */
function browseUrl(site, key) {
  return `${site}/browse/${encodeURIComponent(key)}`
}

const PROMPT_MAX = 16000

/**
 * What Discuss and New session hand to Claude: it starts `About Jira <KEY>: <summary>` (never
 * `/`, `!`, `#` or `&`, which the app refuses: they would be a slash command, a bash line, a
 * memory note or a background task), then the readable text, capped.
 */
function discussPrompt(issue, text, max = PROMPT_MAX) {
  const head = `About Jira ${issue.key}: ${oneLine(issue.summary)}`
  const body = `${head}\n\nThe issue as it is now (read-only; the plugin does not write to Jira):\n\n${text}`
  return cut(body, max)
}

module.exports = { readableText, browseUrl, discussPrompt, PROMPT_MAX }
