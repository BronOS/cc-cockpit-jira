'use strict'
// Settings validation (project scope; design "Auth and settings"). The manifest schema cannot
// say everything (no regexes in schemas: the app refuses them, ReDoS in main), so the host
// checks here what the form cannot: an https site with no path, an email that looks like one,
// project keys. A setting that is missing makes the plugin idle with a clear "what is missing";
// a bad value is a problem shown in the panel and in `ccc jira status`.

const { projectKey } = require('./jql')
const { LANE_IDS } = require('./lanes')
const { hashOf } = require('./util')

const LANE_DEFAULTS = { backlog: true, inProgress: true, mentioned: true, onHold: false, done: false }

/** The site as an origin (`https://x.atlassian.net`); a reason string when it is not usable. */
function checkSite(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return { missing: true }
  let u
  try {
    u = new URL(raw)
  } catch {
    return { problem: `site: "${raw.slice(0, 80)}" is not an address; use https://<name>.atlassian.net` }
  }
  if (u.protocol !== 'https:') return { problem: 'site: only https is allowed (the token travels with every request)' }
  if (u.username || u.password) return { problem: 'site: no user or password in the address; the email and token are their own settings' }
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return { problem: `site: just the address, no path (https://${u.host})` }
  return { site: u.origin }
}

/**
 * @param {Record<string, unknown>} p ctx.settings.project
 * @returns {{ cfg: object, missing: string[], problems: string[], ready: boolean }}
 */
function readSettings(p) {
  const s = p || {}
  const missing = []
  const problems = []
  const site = checkSite(s.site)
  if (site.missing) missing.push('site')
  if (site.problem) problems.push(site.problem)
  const email = typeof s.email === 'string' ? s.email.trim() : ''
  if (!email) missing.push('email')
  else if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) problems.push('email: not an email address')
  // A secret field is absent when unset (never '' or null; `ccc guide settings-secrets`).
  const token = typeof s.apiToken === 'string' && s.apiToken ? s.apiToken : ''
  if (!token) missing.push('apiToken')

  // Nested defaults: a project that never saved `lanes` may arrive without some keys, so each
  // lane falls back on its own default rather than trusting the object to be whole.
  const lanesIn = s.lanes && typeof s.lanes === 'object' ? s.lanes : {}
  const lanes = {}
  for (const id of LANE_IDS) lanes[id] = typeof lanesIn[id] === 'boolean' ? lanesIn[id] : LANE_DEFAULTS[id]

  const onHold = new Set((Array.isArray(s.onHoldStatuses) ? s.onHoldStatuses : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().toLowerCase()))
  const mentionProjects = []
  for (const k of Array.isArray(s.mentionProjects) ? s.mentionProjects : []) {
    const key = projectKey(k)
    if (key) {
      if (!mentionProjects.includes(key)) mentionProjects.push(key)
    } else problems.push(`mentionProjects: "${String(k).slice(0, 40)}" is not a project key (letters, digits, _), skipped`)
  }
  const int = (v, d, lo, hi) => {
    const n = Math.floor(Number(v))
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
  }
  const tokenKind = s.tokenKind === 'classic' || s.tokenKind === 'scoped' ? s.tokenKind : 'auto'
  const triageText = s.triageText === 'summary' ? 'summary' : 'full'
  const cfg = {
    site: site.site || '',
    email,
    token,
    tokenKind,
    lanes,
    onHold,
    doneDays: int(s.doneDays, 14, 1, 365),
    mentionDays: int(s.mentionDays, 7, 1, 90),
    mentionProjects,
    pollMinutes: int(s.pollMinutes, 3, 1, 1440),
    triageText,
  }
  // Ready = enough to talk to Jira. A bad optional value (a project key) is reported but does
  // not stop the plugin; a bad site or email does.
  const ready = !missing.length && !problems.some((x) => x.startsWith('site:') || x.startsWith('email:'))
  return { cfg, missing, problems, ready }
}

/** What to tell the person when something is missing: one line per field, with where to set it. */
function missingText(missing) {
  const lines = []
  if (missing.includes('site')) lines.push('site is not set: ccc plugin config bronos.jira site=https://<name>.atlassian.net')
  if (missing.includes('email')) lines.push('email is not set: ccc plugin config bronos.jira email=<your Atlassian account email>')
  if (missing.includes('apiToken')) lines.push('API token is not set: a person enters it in Settings > This project > Jira (a secret field; `ccc plugin config` cannot set it)')
  return lines
}

/**
 * The fields whose change means a new client. Kept in memory only and hashed, so not even a
 * fragment of the token sits in a string someone might log.
 */
function connectionKey(cfg) {
  return hashOf([cfg.site, cfg.email, cfg.tokenKind, cfg.token])
}

module.exports = { readSettings, checkSite, missingText, connectionKey, LANE_DEFAULTS }
