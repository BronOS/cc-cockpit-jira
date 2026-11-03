'use strict'
// The `jira` service (v1) other plugins of the project call (design "The jira service"): the pure
// parts. The host (dist/host.js) wires them to its cache, its client and the issue view.
//
// - Methods: `site()`, `issue(key, { maxAgeMs? })`, `document(key, { maxHtmlBytes?, maxImages?,
//   maxImageChars?, waitMs? })`. Arguments come from another plugin, so every one is checked here:
//   the key must have the PROJ-123 shape (it goes into a Jira URL path), options are clamped to
//   the plugin's own budgets (a caller can only ask for less).
// - Bounded: a service call is a plain call inside the plugin host, with no rate or size limit
//   from the app (`ccc guide api`, services: "a provider that must protect itself counts and caps
//   its own callers"). So lookups that need Jira run at most 2 at a time and 30 a minute, documents
//   1 at a time and 6 a minute; a call past that is refused at once (no long queue), and the answer
//   of a lookup is cached (TTL) so a mail plugin asking about the same key every poll costs nothing.
// - Results are plain data (the registry copies them with structuredClone). Errors are thrown as
//   `jira: <why>`; nothing here ever carries the token (the client's messages never do either).

const { issueKey } = require('./util')

const LIMITS = {
  lookup: { concurrency: 2, perMinute: 30, queue: 20, what: 'issue lookups' },
  document: { concurrency: 1, perMinute: 6, queue: 3, what: 'issue documents' },
}
// How old an answer `issue()` may be: the caller's maxAgeMs, clamped. The default is a bit more
// than the default poll interval (3 min), so a project that polls finds most keys in the poll.
const MAX_AGE = { def: 300000, min: 15000, max: 3600000 }
const NEGATIVE_MS = 300000 // a key Jira does not know (or hides) is not asked again for 5 min
const LOOKUP_CACHE = 300
const KEY_MAX = 64

/** The issue key of a service argument (`ABC-123`, upper-cased), or null: strings only, bounded. */
function serviceKey(value) {
  if (typeof value !== 'string' || !value || value.length > KEY_MAX) return null
  return issueKey(value)
}

function checkKey(value) {
  const k = serviceKey(value)
  if (!k) throw new Error('jira: not an issue key (the PROJ-123 shape)')
  return k
}

function clampInt(v, def, lo, hi) {
  if (v === undefined || v === null) return def
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return def
  return Math.min(hi, Math.max(lo, n))
}

function options(o) {
  if (o === undefined || o === null) return {}
  if (typeof o !== 'object' || Array.isArray(o)) throw new Error('jira: the options are an object')
  return o
}

/** `issue()`'s options: `{ maxAgeMs }`. */
function issueOptions(o) {
  const x = options(o)
  return { maxAgeMs: clampInt(x.maxAgeMs, MAX_AGE.def, MAX_AGE.min, MAX_AGE.max) }
}

/**
 * `document()`'s options, each at most the plugin's own budget (images.js, document.js): a caller
 * that embeds the issue beside its own content asks for less room.
 * @param {object} o the caller's options
 * @param {{ html: number, images: number, imageChars: number, waitMs: number }} max
 */
function documentOptions(o, max) {
  const x = options(o)
  const out = {
    maxHtmlBytes: clampInt(x.maxHtmlBytes, max.html, 20000, max.html),
    maxImages: clampInt(x.maxImages, max.images, 0, max.images),
    maxImageChars: clampInt(x.maxImageChars, max.imageChars, 0, max.imageChars),
  }
  if (x.waitMs !== undefined) out.waitMs = clampInt(x.waitMs, max.waitMs, 0, max.waitMs)
  return out
}

/**
 * At most `concurrency` running and `perMinute` started in any 60 s; up to `queue` calls wait for a
 * free slot, more are refused at once. `run(fn)` resolves or rejects with fn's outcome.
 */
function createLimiter(o) {
  const now = o.now || Date.now
  const starts = []
  const waiting = []
  let running = 0
  function refuse(text) {
    return Promise.reject(new Error(`jira: ${text}`))
  }
  function next() {
    while (running < o.concurrency && waiting.length) {
      const w = waiting.shift()
      start(w.fn).then(w.resolve, w.reject)
    }
  }
  function start(fn) {
    running++
    starts.push(now())
    return Promise.resolve()
      .then(fn)
      .finally(() => {
        running--
        next()
      })
  }
  return {
    run(fn) {
      const t = now()
      while (starts.length && t - starts[0] >= 60000) starts.shift()
      if (starts.length + waiting.length >= o.perMinute) return refuse(`too many ${o.what} (at most ${o.perMinute} a minute); try again in a minute`)
      if (running < o.concurrency) return start(fn)
      if (waiting.length >= o.queue) return refuse(`busy (${o.what}: ${o.concurrency} at a time, ${o.queue} waiting); try again shortly`)
      return new Promise((resolve, reject) => waiting.push({ fn, resolve, reject }))
    },
    get running() {
      return running
    },
  }
}

/** A bounded map, least recently set first out. */
function createTtlCache(max = LOOKUP_CACHE) {
  const m = new Map()
  return {
    get: (k) => m.get(k),
    set(k, v) {
      m.delete(k)
      m.set(k, v)
      while (m.size > max) m.delete(m.keys().next().value)
    },
    clear: () => m.clear(),
    get size() {
      return m.size
    },
  }
}

/**
 * What `issue()` answers about one issue, from its header fields (model.header).
 * @param {object} h model.header
 * @param {{ me: string, browse: string, lane: string|null, source: 'poll'|'fetch', at: number }} o
 */
function issueFacts(h, o) {
  return {
    key: h.key,
    summary: h.summary || '',
    status: h.status || '',
    // Jira's status category: new (To Do), indeterminate (In Progress), done.
    category: h.category,
    done: h.category === 'done',
    priority: h.priority || '',
    type: h.type || '',
    assignee: h.assignee || '',
    // Whether the signed-in Jira account is the assignee ("mine"); false while the account is unknown.
    mine: Boolean(o.me) && h.assigneeId === o.me,
    lane: o.lane || null,
    url: o.browse,
    updatedAt: h.updatedAt || 0,
    // Where the answer came from and when Jira said so: the last poll's search, or a fetch for this call.
    source: o.source,
    at: o.at,
  }
}

/** An error as the service throws it: `jira: <message>`, a fresh Error with the text only. */
function serviceError(e) {
  const m = e && e.message ? e.message : String(e)
  return new Error(m.startsWith('jira: ') ? m : `jira: ${m}`)
}

module.exports = { serviceKey, checkKey, issueOptions, documentOptions, createLimiter, createTtlCache, issueFacts, serviceError, LIMITS, MAX_AGE, NEGATIVE_MS, LOOKUP_CACHE, KEY_MAX }
