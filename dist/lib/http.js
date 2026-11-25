'use strict'
// Token-to-host safety: the one place the API token leaves the plugin.
//
// The rule (ported from the old cockpit's lib/jirasite.py): the token goes only to the Jira site
// the person configured, or to the Atlassian API gateway for a scoped token, and only over https.
// It is never copied onto a redirect to another host: Jira Cloud sends some URLs (attachments,
// above all) on to a media host that takes a signed address alone, and a token sent there would
// leak to a third party. So redirects are followed by hand (`redirect: 'manual'`): every hop is
// checked, the Authorization header survives only a hop to the very origin it was sent to, and a
// hop to plain http ends the request. fetch's own redirect handling cannot be told any of that
// (it keeps the header on a same-origin hop and drops it cross-origin only in newer versions).
//
// Writes (0.8.0: a comment, a transition) are stricter still: `guardedWrite` follows no redirect at
// all. A redirected POST is a misconfigured proxy or something pointing the body elsewhere, and
// sending a write on (or turning it into a GET, as fetch does on a 303) could post a comment twice or
// somewhere the person did not mean. So any 3xx ends the write with an error and nothing is re-sent.

const GATEWAY = 'https://api.atlassian.com'
const MAX_REDIRECTS = 3
const TIMEOUT_MS = 20000

/** The origin of an https URL (`https://x.atlassian.net`), null for anything else. */
function httpsOrigin(url) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.username || u.password) return null
    return u.origin
  } catch {
    return null
  }
}

/** Why a request failed, as a kind the host and the panel can act on. */
class JiraError extends Error {
  /**
   * @param {string} message what the person reads
   * @param {{ kind: string, status?: number, retryAfter?: number }} info kind: auth (401),
   *   forbidden (403), notfound (404), rate (429), http (another status), network, timeout,
   *   unsafe (a URL the token may not go to), json (a body that is not JSON), toolarge (a body
   *   over the caller's byte limit)
   */
  constructor(message, info) {
    super(message)
    this.name = 'JiraError'
    this.kind = info.kind
    if (info.status !== undefined) this.status = info.status
    if (info.retryAfter !== undefined) this.retryAfter = info.retryAfter
  }
}

/** `Basic base64(email:token)`: what both a classic and a scoped API token use. */
function basicAuth(email, token) {
  return 'Basic ' + Buffer.from(`${email}:${token}`, 'utf8').toString('base64')
}

/**
 * GET `url` with the token, following at most 3 redirects by hand.
 *
 * @param {string} url absolute https URL; its origin must be in `trusted`
 * @param {object} o
 * @param {string} o.auth the Authorization header value
 * @param {Set<string>} o.trusted origins the token may go to (the site, the gateway)
 * @param {typeof fetch} o.fetch injected (tests pass a fake; nothing here reaches the network itself)
 * @param {AbortSignal} [o.signal] the caller's cancel (a `ccc` Ctrl+C, deactivate)
 * @param {string} [o.accept] the Accept header (default JSON; an attachment takes any type)
 * @param {number} [o.timeoutMs] per hop, and the body read after the last hop (default 20 s)
 * @returns {Promise<Response>} the final response (any status; the caller reads it)
 */
async function guardedGet(url, o) {
  let current = url
  const origin = httpsOrigin(current)
  if (!origin || !o.trusted.has(origin)) {
    // Refused before anything is sent: a bug or a hostile value (a `self` link from a response)
    // must not be able to point the token elsewhere.
    throw new JiraError(`not sending the Jira token to ${safeHost(current)}: only to the Jira site or the Atlassian gateway over https`, { kind: 'unsafe' })
  }
  let withAuth = true
  for (let hop = 0; ; hop++) {
    const headers = { Accept: o.accept || 'application/json' }
    if (withAuth) headers.Authorization = o.auth
    let res
    const timeout = AbortSignal.timeout(o.timeoutMs || TIMEOUT_MS)
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout
    try {
      res = await o.fetch(current, { method: 'GET', headers, redirect: 'manual', signal })
    } catch (e) {
      if (timeout.aborted) throw new JiraError(`Jira did not answer within ${Math.round((o.timeoutMs || TIMEOUT_MS) / 1000)} s`, { kind: 'timeout' })
      if (o.signal && o.signal.aborted) throw new JiraError('cancelled', { kind: 'network' })
      throw new JiraError(`cannot reach ${safeHost(current)}: ${e && e.message ? e.message : e}`, { kind: 'network' })
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!location) return res
    if (hop >= MAX_REDIRECTS) throw new JiraError(`too many redirects from ${safeHost(url)}`, { kind: 'http', status: res.status })
    let next
    try {
      next = new URL(location, current).href
    } catch {
      throw new JiraError('Jira redirected to an address that is not a URL', { kind: 'http', status: res.status })
    }
    const nextOrigin = httpsOrigin(next)
    if (!nextOrigin) throw new JiraError(`Jira redirected to a non-https address (${safeHost(next)}): not followed`, { kind: 'unsafe' })
    // The token follows only to the origin it was just sent to. Once dropped it stays dropped,
    // even if a later hop comes back to the site: that chain is not one Jira's API makes.
    if (nextOrigin !== httpsOrigin(current)) withAuth = false
    current = next
  }
}

/**
 * A response body as a Buffer, refused past `max` bytes (a declared Content-Length over it is
 * refused before reading; a body that keeps coming is cut off at the limit and cancelled). The
 * fetch's signal (guardedGet's timeout) still bounds the time.
 */
async function readLimited(res, max, what) {
  const tooLarge = () => new JiraError(`${what} is over ${max} bytes`, { kind: 'toolarge', status: res.status })
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    if (res.body) await res.body.cancel().catch(() => {})
    throw tooLarge()
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > max) throw tooLarge()
    return buf
  }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
  }
  return Buffer.concat(chunks, total)
}

/** `https://host` of a URL for a message (never its path or query: those may carry ids). */
function safeHost(url) {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return 'an invalid address'
  }
}

/**
 * The response body as JSON, or a JiraError for a status that is not 2xx. Messages say what to
 * do: a 401 is the expired-token case the design names.
 */
async function readJson(res, what) {
  if (res.status >= 200 && res.status < 300) return okBody(res, what)
  throw errorFor(res, await bodyText(res), what)
}

/** A 2xx body as JSON (null when empty: a 204). */
async function okBody(res, what) {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new JiraError(`${what}: Jira answered with something that is not JSON`, { kind: 'json', status: res.status })
  }
}

/** The body of an error answer, '' when it cannot be read (it is only for the message). */
async function bodyText(res) {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

/** The JiraError for a status that is not 2xx, its body already read (`text`). */
function errorFor(res, text, what) {
  const detail = jiraMessage(text)
  const suffix = detail ? ` (${detail})` : ''
  if (res.status === 401) return authError()
  if (res.status === 403) {
    return new JiraError(`${what}: Jira says the token may not do this (403)${suffix}. A scoped token needs read:jira-work and read:jira-user.`, { kind: 'forbidden', status: 403 })
  }
  if (res.status === 404) return new JiraError(`${what}: not found (404)${suffix}`, { kind: 'notfound', status: 404 })
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'))
    return new JiraError(`Jira is rate limiting the plugin (429); it tries again at the next poll`, { kind: 'rate', status: 429, ...(Number.isFinite(ra) ? { retryAfter: ra } : {}) })
  }
  return new JiraError(`${what}: Jira answered ${res.status}${suffix}`, { kind: 'http', status: res.status })
}

/**
 * POST `body` as JSON to `url` with the token, following no redirect: a 3xx ends the write with an
 * error and nothing is sent again (see the top of this file). The same origin rule as guardedGet.
 *
 * @param {string} url absolute https URL; its origin must be in `trusted`
 * @param {object} o
 * @param {string} o.method 'POST'
 * @param {unknown} o.body sent as JSON
 * @param {string} o.auth
 * @param {Set<string>} o.trusted
 * @param {typeof fetch} o.fetch
 * @param {string} o.what what the person reads in a message ("comment on ABC-1")
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.timeoutMs]
 * @returns {Promise<Response>} the response, never a 3xx (the caller reads it with readWrite)
 */
async function guardedWrite(url, o) {
  const origin = httpsOrigin(url)
  if (!origin || !o.trusted.has(origin)) {
    throw new JiraError(`not sending the Jira token to ${safeHost(url)}: only to the Jira site or the Atlassian gateway over https`, { kind: 'unsafe' })
  }
  const ms = o.timeoutMs || TIMEOUT_MS
  const timeout = AbortSignal.timeout(ms)
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout
  let res
  try {
    res = await o.fetch(url, {
      method: o.method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: o.auth },
      body: JSON.stringify(o.body),
      redirect: 'manual',
      signal,
    })
  } catch (e) {
    // A write that timed out or was cancelled may still have reached Jira: never "nothing happened".
    if (timeout.aborted) throw new JiraError(`${o.what}: Jira did not answer within ${Math.round(ms / 1000)} s; it may or may not have been saved, check the issue in Jira`, { kind: 'timeout' })
    if (o.signal && o.signal.aborted) throw new JiraError(`${o.what}: cancelled; it may or may not have been saved, check the issue in Jira`, { kind: 'network' })
    throw new JiraError(`cannot reach ${safeHost(url)}: ${e && e.message ? e.message : e}`, { kind: 'network' })
  }
  // `opaqueredirect`: a fetch that hides a manual redirect's status (a browser's; Node's gives the 3xx).
  if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
    if (res.body) await res.body.cancel().catch(() => {})
    throw new JiraError(`${o.what}: Jira answered with a redirect${res.status ? ` (${res.status})` : ''}; a write is never sent on, so it was not made`, { kind: 'unsafe', status: res.status })
  }
  return res
}

/**
 * The answer to a write as JSON (null for a 204), or its JiraError. 403 and 400 get the write's own
 * words (design "Writing to Jira"): a token that may read but not write, and Jira's reason for
 * refusing the body (a required field, a workflow condition), cut.
 */
async function readWrite(res, what) {
  // A 2xx is a write that happened, whatever its body: a body that cannot be read or parsed (a
  // proxy's page, a reset stream) must not read as "not posted", or a retry posts it twice (R1-4).
  if (res.status >= 200 && res.status < 300) return okBody(res, what).catch(() => null)
  const text = await bodyText(res)
  const detail = jiraMessage(text)
  if (res.status === 403) {
    throw new JiraError(`${what}: Jira says the token may not write here (403)${detail ? ` (${detail})` : ''}. A scoped token needs write:jira-work; your account also needs the permission in this project.`, { kind: 'forbidden', status: 403 })
  }
  if (res.status === 400) throw new JiraError(`${what}: Jira refused it (400)${detail ? `: ${detail}` : ', with no reason given'}`, { kind: 'http', status: 400 })
  throw errorFor(res, text, what)
}

/** The 401 the design names: a token that expired or is wrong, and where to make a new one. */
function authError() {
  return new JiraError('Jira refused the token (401): it expired or is wrong, or the email does not match it. Create a new one at id.atlassian.com > Security > API tokens and set it in Settings > This project.', { kind: 'auth', status: 401 })
}

/** Jira's error body (`{ errorMessages: [...], errors: {...} }`) as one short line. */
function jiraMessage(text) {
  try {
    const body = JSON.parse(text)
    const parts = [...(Array.isArray(body.errorMessages) ? body.errorMessages : []), ...Object.values(body.errors || {})]
    const msg = parts.filter((p) => typeof p === 'string').join('; ')
    if (msg) return msg.slice(0, 300)
    if (typeof body.message === 'string') return body.message.slice(0, 300)
  } catch {
    // Not JSON (an HTML error page from a proxy): no detail rather than markup in a notice.
  }
  return ''
}

module.exports = { GATEWAY, JiraError, authError, basicAuth, guardedGet, guardedWrite, readJson, readWrite, readLimited, httpsOrigin, safeHost, jiraMessage }
