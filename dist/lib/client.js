'use strict'
// The Jira Cloud REST v3 client: GETs, paging, the classic/scoped token choice, and since 0.8.0
// its only writes, a comment and a transition (design "Writing to Jira"; lib/write.js has the rules).
//
// Two kinds of API token exist (design "Auth and settings"):
// - classic: Basic email:token straight to the site (`https://x.atlassian.net/rest/api/3/...`);
// - scoped (made at id.atlassian.com with chosen scopes, e.g. read-only read:jira-work and
//   read:jira-user): the site refuses it with 401; it works only through the gateway,
//   `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/...`, still as Basic email:token.
// With `tokenKind: auto` the client starts on the site and, on a 401, looks the cloudId up
// (`<site>/_edge/tenant_info`, which needs no token, so none is sent) and retries through the
// gateway once. The kind that worked is kept for the client's life (in memory only: nothing
// derived from the token is stored).

const { GATEWAY, JiraError, authError, basicAuth, guardedGet, guardedWrite, readJson, readWrite, readLimited, httpsOrigin } = require('./http')
const { checkComment, commentAdf, parseTransitions } = require('./write')
const { issueKey } = require('./util')

const SEARCH_PAGE = 100
const COMMENT_PAGE = 100
const MAX_COMMENTS = 500
const MAX_HISTORIES = 500
// labels .. parent: only for the details column of the issue view (lib/document.js issueDetails).
const ISSUE_FIELDS = 'summary,status,priority,issuetype,updated,created,assignee,reporter,description,comment,project,attachment,labels,components,fixVersions,duedate,resolution,parent'

// The search's header fields (jql.js SEARCH_FIELDS), for a single issue.
const HEADER_FIELDS = 'summary,status,priority,issuetype,updated,created,assignee,reporter,project,duedate,labels'

/**
 * @param {object} o
 * @param {string} o.site the configured site origin (`https://x.atlassian.net`), already validated
 * @param {string} o.email
 * @param {string} o.token
 * @param {'auto'|'classic'|'scoped'} [o.tokenKind]
 * @param {typeof fetch} o.fetch
 */
function createClient(o) {
  const site = httpsOrigin(o.site)
  if (!site) throw new JiraError('the site must be an https address', { kind: 'unsafe' })
  const auth = basicAuth(o.email, o.token)
  const fetchFn = o.fetch
  const want = o.tokenKind || 'auto'
  // mode: null until a request settled it ('classic' or 'scoped').
  let mode = want === 'classic' ? 'classic' : null
  let cloudId = null

  /** The cloudId of the site, from its public tenant_info (no token on this request). */
  async function lookupCloudId(signal) {
    let res
    try {
      res = await fetchFn(`${site}/_edge/tenant_info`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        // Nothing secret goes out, but a redirect elsewhere still means this is not a Jira site.
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      })
    } catch (e) {
      throw new JiraError(`cannot read ${site}/_edge/tenant_info for a scoped token: ${e && e.message ? e.message : e}`, { kind: 'network' })
    }
    if (res.status !== 200) throw new JiraError(`${site} has no tenant_info (${res.status}): is it a Jira Cloud site?`, { kind: 'http', status: res.status })
    let body
    try {
      body = await res.json()
    } catch {
      body = null
    }
    const id = body && body.cloudId
    // The id goes into a URL path: only the characters a cloudId has (a UUID), nothing that
    // could add a path segment or a query.
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new JiraError(`${site}/_edge/tenant_info gave no usable cloudId`, { kind: 'json' })
    return id
  }

  function baseFor(m) {
    return m === 'scoped' ? `${GATEWAY}/ex/jira/${cloudId}` : site
  }

  async function getOnce(m, path, params, signal, extra = {}) {
    const qs = params ? new URLSearchParams(params).toString() : ''
    const url = baseFor(m) + path + (qs ? `?${qs}` : '')
    // Only the origin of this request's base: a scoped client never sends to the site, a classic
    // one never to the gateway.
    const trusted = new Set([httpsOrigin(baseFor(m))])
    return guardedGet(url, { auth, trusted, fetch: fetchFn, signal, ...extra })
  }

  /** GET a REST path (`/rest/api/3/myself`) as JSON. */
  async function get(path, params, what = path, signal) {
    if (mode === null && want === 'scoped') {
      cloudId = await lookupCloudId(signal)
      mode = 'scoped'
    }
    if (mode !== null) return readJson(await getOnce(mode, path, params, signal), what)
    // auto, not settled yet: the site first.
    const res = await getOnce('classic', path, params, signal)
    if (res.status !== 401) {
      const body = await readJson(res, what)
      mode = 'classic'
      return body
    }
    await res.text().catch(() => '')
    try {
      cloudId = await lookupCloudId(signal)
    } catch (e) {
      // No gateway to try: the site's 401 is the answer (a wrong classic token, most likely).
      // The lookup's own failure goes in the log line the host writes, not in front of the person.
      const err = authError()
      err.detail = e.message
      throw err
    }
    const viaGateway = await getOnce('scoped', path, params, signal)
    // A 401 here too: the token is wrong for both, readJson says so.
    const body = await readJson(viaGateway, what)
    mode = 'scoped'
    return body
  }

  /**
   * Every issue a JQL finds, in its order, up to `cap` (`/rest/api/3/search/jql`, paged by
   * nextPageToken). `truncated` says the cap cut the list.
   */
  async function search(jql, fields, cap, signal) {
    const issues = []
    let token = null
    let truncated = false
    // Every page adds at least one issue or the loop ends, so `cap` pages bound it even when a
    // server keeps handing out tokens.
    for (let page = 0; page <= cap; page++) {
      const params = { jql, maxResults: String(Math.min(SEARCH_PAGE, cap - issues.length)), fields: fields.join(',') }
      if (token) params.nextPageToken = token
      const body = (await get('/rest/api/3/search/jql', params, 'search', signal)) || {}
      const got = Array.isArray(body.issues) ? body.issues : []
      for (const i of got) {
        if (i && typeof i.key === 'string' && i.fields && typeof i.fields === 'object') issues.push({ key: i.key, fields: i.fields })
      }
      token = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : null
      if (issues.length >= cap) {
        truncated = Boolean(token) || issues.length > cap
        break
      }
      if (!token || body.isLast === true || got.length === 0) break
    }
    return { issues: issues.slice(0, cap), truncated }
  }

  /**
   * One issue in full: fields, all comments (paged past the first page, at most 500) and its
   * changelog (paged, at most 500 histories). Comment and changelog pages go by startAt.
   */
  async function issue(key, signal) {
    const path = `/rest/api/3/issue/${encodeURIComponent(key)}`
    const raw = await get(path, { fields: ISSUE_FIELDS, expand: 'changelog' }, `issue ${key}`, signal)
    if (!raw || !raw.fields) throw new JiraError(`issue ${key}: Jira sent no fields`, { kind: 'json' })
    const c = raw.fields.comment || {}
    const comments = Array.isArray(c.comments) ? [...c.comments] : []
    let total = Number.isFinite(c.total) ? c.total : comments.length
    while (comments.length < Math.min(total, MAX_COMMENTS)) {
      const page = (await get(`${path}/comment`, { startAt: String(comments.length), maxResults: String(COMMENT_PAGE), orderBy: 'created' }, `comments of ${key}`, signal)) || {}
      const got = Array.isArray(page.comments) ? page.comments : []
      if (!got.length) break
      comments.push(...got)
      if (Number.isFinite(page.total)) total = page.total
    }
    raw.fields.comment = { comments: dedupe(comments), total }
    const ch = raw.changelog || {}
    const histories = Array.isArray(ch.histories) ? [...ch.histories] : []
    const htotal = Number.isFinite(ch.total) ? ch.total : histories.length
    while (histories.length < Math.min(htotal, MAX_HISTORIES)) {
      const page = (await get(`${path}/changelog`, { startAt: String(histories.length), maxResults: '100' }, `changelog of ${key}`, signal)) || {}
      const got = Array.isArray(page.values) ? page.values : []
      if (!got.length) break
      histories.push(...got)
      if (page.isLast === true) break
    }
    raw.changelog = { histories: dedupe(histories), total: htotal }
    return raw
  }

  /**
   * One issue's header fields only (the `jira` service's `issue(key)` when the poll has no fresh copy):
   * no comments, no changelog, so one small request.
   */
  async function issueHeader(key, signal) {
    const raw = await get(`/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: HEADER_FIELDS }, `issue ${key}`, signal)
    if (!raw || !raw.fields || typeof raw.key !== 'string') throw new JiraError(`issue ${key}: Jira sent no fields`, { kind: 'json' })
    return { key: raw.key, fields: raw.fields }
  }

  async function myself(signal) {
    const me = await get('/rest/api/3/myself', null, 'myself', signal)
    if (!me || typeof me.accountId !== 'string') throw new JiraError('Jira did not say who the token belongs to (myself)', { kind: 'json' })
    return { accountId: me.accountId, displayName: typeof me.displayName === 'string' ? me.displayName : '' }
  }

  /**
   * An attachment's bytes (the reader's images), at most `maxBytes`. The address is built from
   * the attachment id on the client's own base (site or gateway), never taken from the `content`
   * link of a response, so nothing Jira sends can point the token elsewhere. The site answers with
   * a redirect to its media host, which guardedGet follows without the token.
   *
   * @param {string} id the attachment id (digits)
   * @param {{ maxBytes: number, signal?: AbortSignal, timeoutMs?: number }} o
   * @returns {Promise<Buffer>}
   */
  async function attachment(id, o) {
    const sid = String(id)
    if (!/^[0-9]{1,20}$/.test(sid)) throw new JiraError('an attachment id is digits only', { kind: 'unsafe' })
    // The token kind is settled by the first API call (an Open has read the issue just before).
    if (mode === null) await myself(o.signal)
    const res = await getOnce(mode, `/rest/api/3/attachment/content/${sid}`, null, o.signal, { accept: '*/*', ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) })
    if (res.status !== 200) {
      // readJson turns a 4xx/5xx into the usual message; another 2xx (204) is no picture either.
      await readJson(res, `attachment ${sid}`)
      throw new JiraError(`attachment ${sid}: Jira answered ${res.status}`, { kind: 'http', status: res.status })
    }
    return readLimited(res, o.maxBytes, `attachment ${sid}`)
  }

  /**
   * A write (POST) to a REST path on the client's own base. The token kind is settled by a read
   * first when nothing settled it yet: a write is never the request that probes site vs gateway (an
   * auto client retrying a write through the gateway after the site's 401 would be a second write
   * attempt). No redirect is followed (guardedWrite).
   */
  async function post(path, body, what, signal, guard) {
    if (mode === null) await myself(signal)
    // The caller's last word, after the token-kind read above (review R2-2): settings changed during
    // it (writing switched off, another token) stop the write here, before anything is sent.
    const stop = typeof guard === 'function' ? guard() : null
    if (stop) throw new JiraError(stop, { kind: 'stopped' })
    const trusted = new Set([httpsOrigin(baseFor(mode))])
    const res = await guardedWrite(baseFor(mode) + path, { method: 'POST', body, auth, trusted, fetch: fetchFn, what, signal })
    return readWrite(res, what)
  }

  /** The key as it goes into a write's path: exactly an issue key (util.issueKey), else refused. */
  function writeKey(key) {
    const k = issueKey(key)
    if (!k || k !== key) throw new JiraError(`not an issue key: "${String(key).slice(0, 40)}"`, { kind: 'unsafe' })
    return k
  }

  /**
   * Post a comment: plain text as ADF (lib/write.js commentAdf), at most 32,000 characters, refused
   * before the call when empty or longer. `opts.guard()` is asked right before the POST (a message
   * stops it: a JiraError of kind `stopped`). Resolves `{ id }`.
   */
  async function comment(key, text, signal, opts = {}) {
    const k = writeKey(key)
    const c = checkComment(text)
    if (c.error) throw new JiraError(`comment on ${k}: ${c.error}`, { kind: 'invalid' })
    const body = await post(`/rest/api/3/issue/${k}/comment`, { body: commentAdf(c.text) }, `comment on ${k}`, signal, opts.guard)
    return { id: body && body.id != null ? String(body.id) : '' }
  }

  /**
   * The transitions possible now, with their fields (`expand=transitions.fields`), so one that needs
   * a field without a default is known to be disabled (lib/write.js parseTransitions). Read fresh
   * every time: workflows differ per project and per status.
   */
  async function transitions(key, signal) {
    const k = writeKey(key)
    return parseTransitions(await get(`/rest/api/3/issue/${k}/transitions`, { expand: 'transitions.fields' }, `transitions of ${k}`, signal))
  }

  /** Run a transition by id (digits only): `{ transition: { id } }`, no fields. */
  async function transition(key, id, signal, opts = {}) {
    const k = writeKey(key)
    const sid = String(id)
    if (!/^[0-9]{1,10}$/.test(sid)) throw new JiraError('a transition id is digits only', { kind: 'unsafe' })
    await post(`/rest/api/3/issue/${k}/transitions`, { transition: { id: sid } }, `moving ${k}`, signal, opts.guard)
  }

  return {
    get,
    search,
    comment,
    transitions,
    transition,
    issue,
    issueHeader,
    myself,
    attachment,
    /** 'classic' | 'scoped' | null (not settled yet). */
    mode: () => mode,
  }
}

/** Items by id, first one kept: a page boundary that moved (a new comment) can repeat one. */
function dedupe(list) {
  const seen = new Set()
  const out = []
  for (const x of list) {
    const id = x && x.id != null ? String(x.id) : null
    if (id !== null && seen.has(id)) continue
    if (id !== null) seen.add(id)
    out.push(x)
  }
  return out
}

module.exports = { createClient, ISSUE_FIELDS, HEADER_FIELDS }
