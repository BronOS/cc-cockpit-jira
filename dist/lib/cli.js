'use strict'
// `ccc jira ...`: parsing and the printed text. The handler gets plain data from the host
// (`deps`), so the suites drive it without an app. No subcommand reads stdin (the manifest does
// not declare it: with `stdin: true` every subcommand would wait for an open pipe).

const { issueKey, ago, stamp, oneLine, cut } = require('./util')
const { LANES, LANE_IDS } = require('./lanes')
const { missingText } = require('./settings')

const HELP = `ccc jira: your Jira issues, read-only (bronos.jira)

  ccc jira status            site, account, last poll, counts per lane, errors
  ccc jira refresh           poll Jira now and print the counts
  ccc jira list [lane]       the issues of every lane, or of one: ${LANE_IDS.join(', ')}
  ccc jira show <KEY>        the issue as readable text (description, comments, changes; new ones [new])
  ccc jira read <KEY>        mark it read (seen up to its newest activity)
  ccc jira unread <KEY>      mark it unread again
  ccc jira help              this text

Settings: ccc plugin config bronos.jira (the API token only in Settings > This project).
`

/**
 * @param {string[]} argv
 * @param {object} deps from the host: status(), refresh(signal), view(), show(key, signal),
 *   read(key), unread(key)
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
  lines.push(`annotate  ${st.annotate}`)
  if (st.deferred) lines.push(`pending   ${st.deferred} issues still to read in full (next polls)`)
  for (const p of st.problems) lines.push(`problem   ${p}`)
  if (st.error) lines.push(`error     ${st.error}`)
  for (const [lane, msg] of Object.entries(st.laneErrors || {})) lines.push(`error     ${lane}: ${msg}`)
  for (const e of (st.issueErrors || []).slice(0, 5)) lines.push(`error     ${e.key}: ${e.message}`)
  return lines.join('\n') + '\n'
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

module.exports = { runCli, statusText, listText, HELP }
