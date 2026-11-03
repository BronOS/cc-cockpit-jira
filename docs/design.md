# Jira (bronos.jira)

Status: design agreed with the user on 2026-11-02. External plugin (own repo, for the
marketplace). The first source plugin for jev-triage. Read-only towards Jira.

Prior art (port its decisions, not its user-specific text): the older cockpit's Jira connector,
`~/Projects/claude-config/cockpit/connectors/jira.py` and `lib/jirasite.py` (REST v3, API token,
seen state, hints and floor), and the triage design in `~/Projects/cc-cockpit-jev-triage/docs/design.md`.

Manifest: `services: { uses: { triage: 1, reviewer: 1 } }`; a panel (left or right zone, the
person's choice; default right) with lanes; CLI `ccc jira`.

## Auth and settings (project scope: a work project and a personal one use different sites)

- `site`: `https://<name>.atlassian.net` (https only).
- `email`: the Atlassian account email.
- `apiToken`: secret field. Classic API token: Basic `email:token` to the site. Scoped token
  (id.atlassian.com, e.g. read-only `read:jira-work`, `read:jira-user`): requests go to
  `https://api.atlassian.com/ex/jira/<cloudId>/...` (cloudId from `<site>/_edge/tenant_info`).
  Support both: try the site first, and on 401 with a scoped token fall back to the gateway
  (or a setting `tokenKind: classic | scoped`, default auto). Tokens expire: a 401 shows a clear
  "token expired or wrong: create a new one at id.atlassian.com > Security > API tokens" notice.
- The token is sent only to the site or the Atlassian gateway over https, never on a redirect to
  another host (jirasite.py's rule: attachments redirect to other hosts).
- `lanes`: which lanes to show, each a boolean: `backlog` (default on), `inProgress` (on),
  `mentioned` (on), `onHold` (off), `done` (off). A hidden lane is not fetched (when it needs its
  own query) and never sent to triage.
- `onHoldStatuses`: status names counted as On hold (`Waiting`, `Blocked`, ...), case-insensitive.
- `doneDays` (default 14), `mentionDays` (default 7): how far back Done and Mentioned look.
- `mentionProjects`: project keys searched for mentions; empty = the projects of the person's
  assigned issues.
- `pollMinutes` (default 3, min 1): only while the project window is open (a closed project
  does nothing).
- `triageText`: `full` (default: description and comments go to Jev) or `summary` (only key,
  summary, status, priority, type: for employers who object to issue text leaving).

## Fetching (Jira Cloud REST v3)

- `GET /rest/api/3/myself` once: accountId, displayName.
- Assigned: `/rest/api/3/search/jql` with `assignee = currentUser() AND statusCategory != Done
  ORDER BY priority ASC, updated DESC` (fields: summary, status, priority, issuetype, updated,
  assignee, reporter), paged by `nextPageToken`, capped (500).
- Done (when the lane is on): `assignee = currentUser() AND statusCategory = Done AND
  statusCategoryChangedDate >= -<doneDays>d`, capped (100).
- Mentioned (when the lane is on): `project in (<mentionProjects>) AND updated >= -<mentionDays>d
  AND (assignee != currentUser() OR assignee is EMPTY) ORDER BY updated DESC`, capped (200). JQL
  cannot search mentions (they are accountIds inside ADF), so the plugin fetches each candidate
  whose `updated` changed and scans its description and comments for an ADF `mention` node with
  the person's accountId, made within `mentionDays`.
- Full issue (`/rest/api/3/issue/<key>?fields=...&expand=changelog`, comments paged) only when
  the search's `updated` differs from the cached one. Cache per project in the plugin's data dir,
  bounded. Concurrency bounded (4). Errors per issue do not fail the poll.
- An assigned issue where the person was mentioned stays in its status lane (marked unread);
  Mentioned holds only issues not assigned to them.

## Lanes

From the status category: To Do -> Backlog, In Progress -> In progress, except a status named in
`onHoldStatuses` -> On hold; Done -> Done; plus Mentioned. Order inside a lane: triage priority
(urgent, action, fyi, noise), then the newest activity.

## Unread (the plugin's own seen state; Jira has none)

An issue is unread while someone else commented, changed its status / assignee / priority,
assigned it to the person, or mentioned them after the time they last saw it. Seen = the time of
the newest activity when the person opened the issue (the overlay) or pressed Mark read; Mark
unread sets it just before the newest activity of others. The first run marks everything seen as
it is, so only what happens next is new. Stored per project, bounded.

## Triage (jev-triage `triage` v1, source `jira`)

- item: `{ id: key, text, hint?, floor?, fields: { project, status, type, priority, lane, assignee, reporter } }`.
- text (`triageText: full`): `Jira <key> (<type>, <status>, <priority>) in <project>: <summary>`,
  who reported / is assigned, the description (cut), then the new activity since seen (others'
  comments with author, field changes), marked as new; earlier comments as context. `summary`:
  only the first line.
- hints (the old connector's rules): Done -> noise; nothing new and In progress (not On hold) ->
  action; nothing new otherwise -> noise; unread with priority High / Highest / Critical ->
  urgent. Anything else unread goes to Jev with `floor` = what the status implies (In progress:
  action, else fyi). Mentioned: no hint, floor fyi.
- Classify only what is shown and changed since the last classify; listen to the triage
  `change` event and re-classify those ids. Without the triage plugin (`ctx.services.available`)
  the panel works unsorted and says triage is off.

## Panel

Lanes as collapsible sections (only the enabled ones), each row: key, summary, status, a triage
dot (priority colour, hollow below 0.5 confidence), unread mark, assignee or "mentioned by X".
Row actions: Open (the overlay), Discuss, New session, ↗ (open in the browser via the app's
link handling or ctx.exec of xdg-open/open), Mark read / unread, Wrong? (jev-triage's
`triage.override` plus its case: or simply point to the triage panel). A header with the last
poll time, a refresh button, and errors (auth, network) as a notice.

## Discuss with Claude (the reviewer overlay)

- Open: `ctx.services.use('reviewer').annotate({ title: '<KEY>: <summary>', text, url, key:
  'jira:<KEY>' })` where `text` is the issue as readable plain text: header fields, description
  (ADF -> plain text with lists, code blocks, links, mentions as @Name), then comments oldest
  first with author and date, the new ones marked `[new]`. The person selects text to add notes,
  writes a global comment, and presses Discuss (the currently open Claude tab by default) or New
  session. Opening marks the issue read. (annotate is added to the bundled reviewer in cc-cockpit
  0.8.0; check `ctx.services.available('reviewer')` and fall back below when missing or when the
  call rejects with an unknown-method error.)
- Discuss / New session row buttons without annotations: `ctx.sessions.send(activeTabId, text)`
  (the tab with `SessionInfo.active`, else ask: the only live tab, else show an error) and
  `ctx.sessions.open({ prompt })`, with a prompt that starts `About Jira <KEY>: <summary>` (never
  `/`, `!`, `#`, `&`) and carries the same issue text, capped.

## CLI

`ccc jira status` (site, account, last poll, counts per lane, errors), `ccc jira refresh`,
`ccc jira list [lane]`, `ccc jira show <KEY>` (the readable text), `ccc jira read|unread <KEY>`,
`ccc jira help`. No stdin.

## Left out of v1

Writing to Jira (comments, transitions), attachments and images, Jira Server/DC (PAT), OAuth.
