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
   *   unsafe (a URL the token may not go to), json (a body that is not JSON)
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
    const headers = { Accept: 'application/json' }
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
  if (res.status >= 200 && res.status < 300) {
    const text = await res.text()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      throw new JiraError(`${what}: Jira answered with something that is not JSON`, { kind: 'json', status: res.status })
    }
  }
  let detail = ''
  try {
    detail = jiraMessage(await res.text())
  } catch {
    // The body is only for the message; a failed read keeps the status alone.
  }
  const suffix = detail ? ` (${detail})` : ''
  if (res.status === 401) throw authError()
  if (res.status === 403) {
    throw new JiraError(`${what}: Jira says the token may not do this (403)${suffix}. A scoped token needs read:jira-work and read:jira-user.`, { kind: 'forbidden', status: 403 })
  }
  if (res.status === 404) throw new JiraError(`${what}: not found (404)${suffix}`, { kind: 'notfound', status: 404 })
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'))
    throw new JiraError(`Jira is rate limiting the plugin (429); it tries again at the next poll`, { kind: 'rate', status: 429, ...(Number.isFinite(ra) ? { retryAfter: ra } : {}) })
  }
  throw new JiraError(`${what}: Jira answered ${res.status}${suffix}`, { kind: 'http', status: res.status })
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

module.exports = { GATEWAY, JiraError, authError, basicAuth, guardedGet, readJson, httpsOrigin, safeHost }
