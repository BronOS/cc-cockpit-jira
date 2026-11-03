'use strict'
// Small helpers shared by the other modules: Jira's timestamps, text cuts, a bounded parallel map
// and a stable hash. No I/O here, so every suite can use them as they are.

const crypto = require('node:crypto')

/**
 * Jira's `2026-10-02T09:11:38.441-0400` as ms since the epoch (0 when missing or unreadable).
 * The offset has no colon, which Date.parse does not accept everywhere, so it is added first.
 */
function parseTime(value) {
  if (typeof value !== 'string' || !value) return 0
  const fixed = value.replace(/([+-]\d\d)(\d\d)$/, '$1:$2')
  const ms = Date.parse(fixed)
  return Number.isFinite(ms) ? ms : 0
}

/** `text` cut to at most `max` characters, with an ellipsis that says it was cut. */
function cut(text, max) {
  const s = String(text == null ? '' : text)
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}

/** One line: line breaks and runs of white space become one space (rows, notices, a summary). */
function oneLine(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
}

/**
 * Run `fn` over `items` with at most `limit` running at once (design: concurrency 4, so a first
 * run with 200 mention candidates does not open 200 sockets to Jira). Resolves to
 * `[{ ok: true, value } | { ok: false, error }]` in the items' order: one failing issue never
 * fails the poll.
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      try {
        out[i] = { ok: true, value: await fn(items[i], i) }
      } catch (error) {
        out[i] = { ok: false, error }
      }
    }
  }
  const workers = []
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker())
  await Promise.all(workers)
  return out
}

/** A short stable hash of a JSON value: what a triage item looked like when it was classified. */
function hashOf(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)
}

/** `2026-10-30 14:02`, local time: a person reads it (comments, the last poll). */
function stamp(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** "3 min ago", "2 h ago": the panel header and `ccc jira status`. */
function ago(ms, now = Date.now()) {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s} s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

/** An issue key (`ABC-123`), upper-cased; null for anything else (a path, a JQL fragment). */
function issueKey(value) {
  const s = String(value == null ? '' : value).trim().toUpperCase()
  return /^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]{0,9}$/.test(s) ? s : null
}

module.exports = { parseTime, cut, oneLine, mapLimit, hashOf, stamp, ago, issueKey }
