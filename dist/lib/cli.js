'use strict'
// `ccc jira ...`: parsing and the printed text. The handler gets plain data from the host
// (`deps`), so the suites drive it without an app. Only `update ... -` reads stdin: the manifest
// declares `stdin` with `stdinDash`, so the app reads it only when an argument is exactly `-` and no
// other subcommand waits on a script's open, silent stdin (an app before 0.10.1 ignores stdinDash
// and reads it for every call, bounded by ccc's own deadline).

const { issueKey, ago, stamp, oneLine, cut } = require('./util')
const { LANES, LANE_IDS } = require('./lanes')
const { missingText } = require('./settings')
const { updatePlan, checkComment } = require('./write')

const HELP = `ccc jira: your Jira issues (bronos.jira)

  ccc jira status            site, account, last poll, counts per lane, errors
  ccc jira refresh           poll Jira now and print the counts
  ccc jira list [lane]       the issues of every lane, or of one: ${LANE_IDS.join(', ')}
  ccc jira show <KEY>        the issue as readable text (description, comments, changes; new ones [new])
  ccc jira read <KEY>        mark it read (seen up to its newest activity)
  ccc jira unread <KEY>      mark it unread again
  ccc jira update <KEY> [--status <name>] [-]
                             a comment (plain text on stdin, with -) and/or a status change
                             (--status: a transition name or the target status, any case)
  ccc jira help              this text

update follows the project's setting "What ccc jira update does" (writes):
  draft (default)  fills Reply in the issue window and writes NOTHING: the person reads it, edits it
                   and posts it, or not. The answer comes at once. This is the person's decision:
                   do not run the command again to make it happen, and do not try another way.
  direct           writes: the comment first, then the move; each step is reported.
  off              refused: writing is off for this project.
The comment is plain text: a blank line starts a paragraph, no formatting, no mentions, at most
32,000 characters. Exit 0: written or draft opened; 1: refused or failed.

Settings: ccc plugin config bronos.jira (the API token only in Settings > This project).
`

/**
 * `update <KEY> [--status <name>] [-]` as `{ key, status, dash }` or `{ usage }`. `--status=<name>`
 * works too; a name with spaces is one argument ("In Progress", quoted by the shell).
 */
function parseUpdate(rest) {
  const usage = 'usage: ccc jira update <KEY> [--status <name>] [-]   (the comment on stdin with -)'
  let key = null
  let status = null
  let dash = false
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '-') dash = true
    else if (a === '--status' || a === '-s') {
      if (i + 1 >= rest.length) return { usage: `--status needs a name\n${usage}` }
      status = rest[++i]
    } else if (a.startsWith('--status=')) status = a.slice('--status='.length)
    else if (a.startsWith('-')) return { usage: `unknown option "${cut(a, 40)}"\n${usage}` }
    else if (key === null) key = a
    else return { usage: `one issue at a time\n${usage}` }
  }
  if (key === null) return { usage }
  if (status !== null && !status.trim()) return { usage: `--status needs a name\n${usage}` }
  return { key, status: status === null ? null : status.trim(), dash }
}

/**
 * @param {string[]} argv
 * @param {object} deps from the host: status(), refresh(signal), view(), show(key, signal),
 *   read(key), unread(key), writes() (the setting, read now), update(key, { comment, status,
 *   tabId, signal }) -> { code, stdout?, stderr? }
 * @param {{ stdin?: string, tabId?: string, signal?: AbortSignal }} [call]
 */
async function runCli(argv, deps, call = {}) {
  const [cmd, ...rest] = argv
  const ok = (stdout) => ({ stdout, code: 0 })
  const fail = (stderr, code = 1) => ({ stderr: stderr.endsWith('\n') ? stderr : stderr + '\n', code })
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || (rest[0] === '--help' && cmd)) return ok(HELP)
  switch (cmd) {
    case 'status':
      return ok(statusText(deps.status()))
    case 'refresh': {
      const st = deps.status()
      if (!st.ready) return fail(notReady(st))
      const r = await deps.refresh(call.signal)
      if (r && r.error) return fail(`refresh failed: ${r.error}`)
      // A first poll can read a few hundred issues and outlast `ccc`'s 30 s: the host stops
      // waiting before that, the poll goes on.
      if (r && r.pending) return ok('still polling (a first run reads many issues); ccc jira status shows when it is done\n')
      return ok(countsLine(deps.status()) + '\n')
    }
    case 'list': {
      const lane = rest[0]
      if (lane && !LANE_IDS.includes(lane)) return fail(`unknown lane "${lane}": one of ${LANE_IDS.join(', ')}`, 2)
      const st = deps.status()
      if (!st.ready) return fail(notReady(st))
      if (!st.lastPoll) return fail('no poll yet: run ccc jira refresh')
      return ok(listText(deps.view(), lane))
    }
    case 'show':
    case 'read':
    case 'unread': {
      if (!rest[0]) return fail(`usage: ccc jira ${cmd} <KEY>`, 2)
      const key = issueKey(rest[0])
      if (!key) return fail(`not an issue key: "${cut(rest[0], 40)}" (like ABC-123)`, 2)
      const st = deps.status()
      if (!st.ready) return fail(notReady(st))
      try {
        if (cmd === 'show') return ok((await deps.show(key, call.signal)) + '\n')
        if (cmd === 'read') {
          await deps.read(key)
          return ok(`${key}: marked read\n`)
        }
        await deps.unread(key)
        return ok(`${key}: marked unread\n`)
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    }
    case 'update': {
      const u = parseUpdate(rest)
      if (u.usage) return fail(u.usage, 2)
      const key = issueKey(u.key)
      if (!key) return fail(`not an issue key: "${cut(u.key, 40)}" (like ABC-123)`, 2)
      const st = deps.status()
      if (!st.ready) return fail(notReady(st))
      const comment = u.dash ? String(call.stdin || '') : ''
      const plan = updatePlan(deps.writes(), { comment: comment.trim() ? comment : '', status: u.status })
      if (plan.refuse) return fail(plan.refuse)
      if (plan.usage) return fail(`${plan.usage}${u.dash ? ' (stdin was empty)' : ''}`, 2)
      if (comment.trim()) {
        const c = checkComment(comment)
        if (c.error) return fail(`${key}: ${c.error}; nothing was written`)
      }
      try {
        const r = await deps.update(key, { comment: comment.trim() ? comment : '', status: u.status, mode: plan.mode, tabId: call.tabId, signal: call.signal })
        const out = (t) => (t && !t.endsWith('\n') ? t + '\n' : t || '')
        return r.code === 0 ? { stdout: out(r.text), code: 0 } : { stderr: out(r.text), code: 1 }
      } catch (e) {
        return fail(e && e.message ? e.message : String(e))
      }
    }
    default:
      return fail(`unknown command "${cut(cmd, 40)}"\n\n${HELP}`, 2)
  }
}

function notReady(st) {
  const lines = ['Jira is not configured yet:', ...missingText(st.missing).map((l) => `  ${l}`), ...st.problems.map((p) => `  ${p}`)]
  return lines.join('\n')
}

function countsLine(st) {
  if (!st.counts) return 'no poll yet'
  return st.counts.map((c) => `${c.title} ${c.total}${c.unread ? ` (${c.unread} unread)` : ''}`).join(' · ') || 'no lane is on'
}

/** `ccc jira status`. */
function statusText(st, now = Date.now()) {
  const lines = []
  lines.push(`site      ${st.site || '(not set)'}${st.mode ? ` (${st.mode} token)` : ''}`)
  lines.push(`email     ${st.email || '(not set)'}`)
  lines.push(`token     ${st.tokenSet ? 'set' : 'not set'}`)
  if (!st.ready) {
    lines.push('', 'Not configured:')
    for (const l of missingText(st.missing)) lines.push(`  ${l}`)
    for (const p of st.problems) lines.push(`  ${p}`)
    lines.push('', 'Nothing is polled until site, email and the API token are set.')
    return lines.join('\n') + '\n'
  }
  lines.push(`account   ${st.account ? `${st.account.displayName || '?'} (${st.account.accountId})` : '(not known yet)'}`)
  lines.push(`last poll ${st.lastPoll ? `${stamp(st.lastPoll)} (${ago(st.lastPoll, now)})` : 'none yet'}${st.polling ? ', polling now' : ''}; every ${st.pollMinutes} min while this project is open`)
  lines.push(`lanes     ${countsLine(st)}`)
  lines.push(`triage    ${st.triage}`)
  lines.push(`opens in  ${st.window}`)
  if (st.writes) lines.push(`writes    ${WRITES_TEXT[st.writes] || st.writes}`)
  if (st.deferred) lines.push(`pending   ${st.deferred} issues still to read in full (next polls)`)
  for (const p of st.problems) lines.push(`problem   ${p}`)
  if (st.error) lines.push(`error     ${st.error}`)
  for (const [lane, msg] of Object.entries(st.laneErrors || {})) lines.push(`error     ${lane}: ${msg}`)
  for (const e of (st.issueErrors || []).slice(0, 5)) lines.push(`error     ${e.key}: ${e.message}`)
  return lines.join('\n') + '\n'
}

// `ccc jira status`'s line for the writes setting: what `update` does now.
const WRITES_TEXT = {
  draft: 'draft: ccc jira update fills Reply in the issue window; the person posts it',
  direct: 'direct: ccc jira update writes the comment and the move itself',
  off: 'off: read-only, ccc jira update is refused and the panel offers no Reply',
}

const DOT = { urgent: 'U', action: 'A', fyi: 'f', noise: '.' }

/** `ccc jira list [lane]`: one line per issue, `*` for unread, the triage letter. */
function listText(view, lane) {
  const out = []
  for (const l of view.lanes) {
    if (lane && l.id !== lane) continue
    out.push(`${l.title} (${l.rows.length})`)
    for (const r of l.rows) {
      const i = r.issue
      const t = r.verdict ? DOT[r.verdict.priority] || '?' : ' '
      const who = r.lane === 'mentioned' ? `mentioned by ${r.mentionedBy || '?'}` : i.assignee || ''
      out.push(`  ${r.unread ? '*' : ' '} ${t} ${i.key.padEnd(12)} ${cut(oneLine(i.status), 18).padEnd(18)} ${cut(oneLine(i.summary), 70)}${who && r.lane === 'mentioned' ? `  (${who})` : ''}`)
    }
  }
  if (lane && !view.lanes.some((l) => l.id === lane)) {
    const title = (LANES.find((l) => l.id === lane) || {}).title || lane
    return `${title}: this lane is off (the lanes setting)\n`
  }
  out.push('', '* unread   triage: U urgent, A action, f fyi, . noise')
  return out.join('\n') + '\n'
}

module.exports = { runCli, statusText, listText, parseUpdate, HELP }
