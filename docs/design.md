# Jira (bronos.jira)

Status: design agreed with the user on 2026-11-02; 0.2.0 (same day, after trying 0.1.0): rows
open on click with hover buttons, and the opened issue is styled HTML with attachments (section
"The issue view"). External plugin (own repo, for the marketplace). The first source plugin for
jev-triage. Read-only towards Jira until 0.8.0. 0.3.0: an "Issues per lane" setting with Show all / Hide. 0.4.0: the last
poll and Refresh (an icon) in the panel's title bar on cc-cockpit 0.9.0+ (`ctx.panels.header`,
`lib/header.js`; the page keeps its own line on older apps), and links open through
`ctx.openExternal` on 0.9.1+ (a plugin host has no display variables, so xdg-open found no browser).
0.5.0 (2026-11-03, designed with the user together with bronos.gmail 0.2.0): provides the `jira`
service to other plugins (section "The jira service"); no app change needed.
0.8.0 (designed with the user on 2026-11-24): writes to Jira, a comment and a status change, always
checked by the person by default (section "Writing to Jira"). Read-only before it.

Prior art (port its decisions, not its user-specific text): the older cockpit's Jira connector,
`~/Projects/claude-config/cockpit/connectors/jira.py` and `lib/jirasite.py` (REST v3, API token,
seen state, hints and floor), and the triage design in `~/Projects/cc-cockpit-jev-triage/docs/design.md`.

Manifest: `services: { provides: { jira: 1 }, uses: { triage: 1, reviewer: 1 } }`; a panel (left or right zone, the
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
- `rowsPerLane` (default 10, 1..300): how many issues a lane shows; a longer lane ends in a
  Show all (N more) / Hide (N) button, remembered per lane like a collapsed one (since 0.3.0).
- `markReadOnOpen` (default off): "Mark an issue read when I open it". Off, opening an issue (a
  row, the feed's `act` open) never changes its seen mark or flag, so Inbox's item stays unread;
  on, an open that reached the screen marks it read. Mark read / Mark unread work either way.
- `onHoldStatuses`: status names counted as On hold (`Waiting`, `Blocked`, ...), case-insensitive.
- `doneDays` (default 14), `mentionDays` (default 7): how far back Done and Mentioned look.
- `mentionProjects`: project keys searched for mentions; empty = the projects of the person's
  assigned issues.
- `pollMinutes` (default 3, min 1): only while the project window is open (a closed project
  does nothing).
- `triageText`: `full` (default: description and comments go to Jev) or `summary` (only key,
  summary, status, priority, type: for employers who object to issue text leaving).
- `writes` (0.8.0, global value plus a per-project override like every project field): what
  `ccc jira update` does. `draft` (default, "Claude drafts, I post"): it opens the reply page
  filled in and writes nothing; `direct` ("ccc writes directly"): it writes; `off` ("Read-only"):
  the command is refused and the panel offers no Reply (the plugin as before 0.8.0, for an employer
  that wants no writes). A scoped token needs `write:jira-work` too for any write.
- `mailSenders` (0.5.0): the addresses the site's notification mails come from, for the `jira`
  service; empty = Jira Cloud's own sender `jira@<site host>`, derived from `site` (nothing
  site-specific in the code). Lower-cased, at most 10; a bad one is a problem line, skipped.

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
the newest activity when the person pressed Mark read (or opened the issue, with `markReadOnOpen`); Mark
unread sets it just before the newest activity of others. The first run marks everything seen as
it is, so only what happens next is new. Stored per project, bounded. Since 0.4.0 Mark unread
works on every issue but Done: it also sets a flag (unread until Mark read, or an open with
`markReadOnOpen`), so an issue
whose activity is all the person's own can be a reminder; flags do not change triage (it goes by
others' activity, `newCount`).

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
A click on a row opens the issue (the overlay); so does Enter or Space on a focused row (each row
is one tab stop; ↑ / ↓ / Home / End move between rows). The other actions are small buttons shown
while the row is hovered or has the focus inside it (in the DOM all the time, only faded out, so
Tab reaches them): ↗ (open in the browser: `ctx.openExternal` on cc-cockpit 0.9.1+, else ctx.exec of
xdg-open/open), Read / Unread, Wrong?
(jev-triage's `triage.override`; the note for its eval goes through the triage panel), Discuss,
New (session). The pure decisions (which buttons, which key does what) are in
`panels/rowlogic.js`, which node:test loads too. A redraw (every state message) puts the keyboard
focus back on the same row or button. A header with the last poll time, a refresh button, and
errors (auth, network) as a notice.

## Discuss with Claude (the reviewer overlay)

- Open: `ctx.services.use('reviewer').annotate({ title: '<KEY>: <summary>', html, assets, url,
  key: 'jira:<KEY>', tabId })`: the issue as HTML with its images (section "The issue view").
  The person selects text to add notes (they anchor on the quoted text), writes a global comment,
  and presses Discuss (the currently open Claude tab by default) or New session. Opening marks the
  issue read. annotate and its HTML mode come with the bundled reviewer in cc-cockpit 0.8.0, so
  the call falls back, once per step and remembered for the run:
  1. `annotate({ html, assets })` rejects with anything but "has no method": a reviewer whose
     annotate takes text only (early 0.8.0 builds). Retry as `annotate({ text })` with the readable
     plain text (header fields, description, comments and changes oldest first, the new ones
     marked `[new]`). Only when that works is "html refused" remembered; when it fails too the
     person sees the error and the next open tries html again.
  2. `service "reviewer" (plugin P) has no method "annotate"` (0.7.x), or no reviewer at all
     (`ctx.services.available('reviewer')` false): the plugin's own overlay page
     (`panels/issue.html`, below).
- Discuss / New session row buttons without annotations: `ctx.sessions.send(activeTabId, text)`
  (the tab with `SessionInfo.active`, else ask: the only live tab, else show an error) and
  `ctx.sessions.open({ prompt })`, with a prompt that starts `About Jira <KEY>: <summary>` (never
  `/`, `!`, `#`, `&`) and carries the same issue text, capped.

## The issue view (0.2.0)

- Built from the ADF of a fresh read (`lib/adfhtml.js`, `lib/document.js`), never from Jira's
  rendered HTML, and safe by construction: every text and attribute value escaped; only the
  reviewer's allow-list tags and classes are written (header card `div.card` with `h1` and
  `div.meta`, comments as `div.card` with `div.card-header` and `.new`, `ul.attachment-list`,
  panels `div.jira-panel.jira-panel-<info|note|warning|error|success>`, `span.mention`,
  `span.status.lozenge`); no style attribute (colours in the ADF are dropped); links only http(s)
  and mailto (relative ones resolved against the site); headings shifted one level (the issue is
  the h1); `media` external is a link, never a remote image.
- Media to attachments: an ADF media node names a media-services file (a uuid, not the REST
  attachment id) and its file name (`attrs.alt`): matched to the issue's `attachment` field by
  name, the newest of a name winning. A downloaded image is `<img data-asset="att<id>">`; one not
  downloaded is a link to `<site>/rest/api/3/attachment/content/<id>`; no match is `[attachment:
  name]`.
- Attachments section, newest first: name, size, author; an image shown in the text says so, a
  downloaded image the text does not show is a figure in the list, the rest are links.
- Images (`lib/images.js`): raster types only (png, jpeg, gif, webp, checked by magic number on
  the bytes), newest first, at most 15, each at most 700 KiB raw (716,800 bytes: a dataUrl of at
  most 955,759 chars, under the reviewer's 1,000,000), all dataUrls at most 7.5 MiB (under 8 MiB);
  an attachment without a size is budgeted at the maximum. Downloads 3 at a time, the open waits at
  most 10 s for them; none starts after that, the running ones finish into the cache (20 s each at
  most) for the next open. With the cached copy (Jira unreachable) only cached images show.
- Download: `client.attachment(id)` builds the URL from the id (digits only) on the client's own
  base (site, or the gateway for a scoped token), never from a `content` link in a response; Jira
  answers 303 to its media host with a signed address, which `guardedGet` follows without the
  token (the rule of jirasite.py's `download`; stricter: once dropped the token never comes back on
  that chain), https only, at most 3 redirects, the body read with a byte limit.
- Cache: `<dataDir>/images/<site hash>-<id>.img` (0600, the folder 0700), at most 300 files and
  64 MiB, least recently used first.
- Size: at most 2,000,000 bytes of HTML (the reviewer's cap is 2 MiB); a description over 1 MB of
  markup becomes its plain text; comments that do not fit give way oldest first, with a line.
- The fallback page (`panels/issue.html`) gets the same HTML in parts of 400,000 chars (a page
  message is at most 1,040,384 chars of JSON) and one message per image, keeps only the builder's
  tags and attributes again (second line of defence), sets an image's src only to a
  `data:image/(png|jpeg|gif|webp);base64,` URL, and posts a link click as `{ open }`, which the
  host opens with xdg-open/open when it is http(s).
- `ccc jira show`, Discuss, New session and triage keep the plain text (`readableText`,
  `triageText`).

## The jira service (v1, 0.5.0)

`ctx.services.provide('jira', { site, issue, document })` in activate. The first consumer is
bronos.gmail (Jira mail: triage hints, the issue below the mail); any plugin of the project can
use it. A call is a plain call inside the plugin host (`ccc guide api`, services: no rate, size or
time limit from the app), so this plugin checks and caps its callers itself (`lib/service.js`):

- `site()` -> `{ ready, site, senders, account }` (`account` `{ accountId, displayName }` once a
  poll or a lookup read `myself`, else null; not configured: `ready: false`, `senders: []`,
  `error`). Never rejects; reads nothing from Jira.
- `issue(key, { maxAgeMs? })` -> `{ key, summary, status, category, done, priority, type,
  assignee, mine, lane, url, updatedAt, source, at }`. `maxAgeMs` (default 300,000, clamped to
  15,000..3,600,000) is how old an answer may be: the last poll's search header when the poll is
  that recent and lists the key (`source: 'poll'`, no request), else the service's own cache of
  earlier answers (300 keys, least recently set out), else `GET /rest/api/3/issue/<key>?fields=`
  the search's header fields only (no comments, no changelog; `source: 'fetch'`). Two calls for
  one key at once share the request. 404 / 403 answers are cached as the error for 5 minutes;
  network failures and refusals are not. `lane`: the panel row's lane, else `statusLane` when
  the issue is the person's, else null. A settings change empties the cache.
- `document(key, { maxHtmlBytes?, maxImages?, maxImageChars?, waitMs? })` -> `{ key, title, url,
  html, aside, assets, stale? }`: `fullIssue` (fresh read, cached copy on failure) and `issueView`
  with the details column, exactly the reviewer's document. The options can only lower the
  plugin's own budgets (2,000,000 bytes, 15 images, 7.5 MiB of data URLs, 10 s wait): `issueDocument`
  takes `maxBytes` (the description at most half of it, else its text, else a note), `selectImages`
  / `gatherImages` the image count and total. Not marked read: another plugin showing the issue is
  not the person opening it here.
- Keys: a string of at most 64 characters with the `issueKey` shape (`[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]{0,9}`,
  upper-cased), else `jira: not an issue key`. Options must be an object.
- Limits: lookups that reach Jira (myself + header) at most 2 at a time, 20 waiting, 30 started a
  minute; documents 1 at a time, 3 waiting, 6 a minute. Past that a call is refused at once (`jira:
  busy ...`, `jira: too many ... a minute`), with a log line naming `ctx.services.caller()` (read
  before the method's first await). Errors are thrown as `jira: <message>`; the client's messages
  carry no token.
- Not configured: `issue` and `document` reject with `jira: the Jira plugin is not configured in
  this project (<missing fields>)`.

## Writing to Jira (0.8.0)

A comment and a status change on one issue, together or alone. The person writes from the reply page;
Claude (any `ccc` caller) prepares one with `ccc jira update`, and with `writes: draft` the person makes the
final decision there.

Why the plugin decides and not Claude's side (agreed 2026-11-24): issue text reaches Claude (Discuss,
`ccc jira show`, triage), so a description can say "close this ticket". A skill is advice the same text
competes with; Claude Code's permission rules (`Bash(ccc jira update:*)` as ask) are a good extra layer per
project but are walked around by `sh -c` or a script and skipped in auto and bypass modes. The setting is
read in the plugin host on every call, for every caller: `CliCall.tabId` tells a Claude tab, but a Claude
that unsets its token looks like the person's shell, so the rule is "ccc drafts, the page writes", not
"Claude drafts". Not a boundary (Claude runs as the person's OS user, and could call the REST API with the
token if it found it); it keeps a prompt-injected Claude from writing to Jira unseen.

### Jira calls (`lib/client.js` gets its first non-GET methods)

- Comment: `POST /rest/api/3/issue/<KEY>/comment` with `{ body: <ADF> }`. The text is plain: a blank line
  starts a paragraph, a single newline is a `hardBreak`; nothing is parsed as markup and there are no
  mentions (they need account ids). At most 32,000 characters (Jira's limit is 32,767), refused before the call.
- Transitions: `GET /rest/api/3/issue/<KEY>/transitions?expand=transitions.fields`, read fresh each time
  the page opens or a Move is about to run (workflows differ per project and per status). A transition
  with a required field that has no default (a resolution screen) is listed but disabled, with "needs
  fields: open in Jira". `POST /rest/api/3/issue/<KEY>/transitions` with `{ transition: { id } }`.
- Same guards as the reads: the client's own base only (site or gateway), https, no redirect followed on
  a write, the key checked as `[A-Z][A-Z0-9_]+-[0-9]+`. A 403 says the token may not write ("a scoped
  token needs write:jira-work"); a 400 shows Jira's `errorMessages` / `errors`, cut.
- Order when both are asked: the comment first, then the transition, so a comment that explains a move
  is never missing after it. Each step reports on its own: a failed transition after a posted comment
  says so, and the page keeps the status choice for a retry (the comment box is cleared, it is posted).
- After a write: the issue is read again (store and lanes), its seen mark set to the new `updated` (the
  person's own change is never unread; unread already ignores the person's own comments), and the feed
  emits its item. The `jira` service gets no write methods (Left out).

### The reply page (`panels/reply.html`, the plugin's own html overlay)

- Opened by the panel row's new Reply button (hover, like Discuss), by a Reply button in the issue
  overlay's toolbar (`ctx.overlay.buttons` on the `inbox-item` type, the same check as the item buttons:
  only on overlays we or our reviewer opened), and by `ccc jira update` in draft mode. Not offered when
  `writes` is `off`.
- Shows the key, summary and current status (a lozenge), the "Move to" choice (Keep status first, then
  the enabled transitions by name, with the target status when it differs from the name), and the
  comment box. One button, its label from the choice: Post comment, Move, or Post and move; disabled
  while nothing would happen. Ctrl/Cmd+Enter does not send: the click is the decision.
- A draft from `ccc` is marked "Draft from Claude" with the tab's name when the caller was a Claude tab
  (`CliCall.tabId`, the app's own value), else "Draft from ccc". The person edits freely; nothing is sent
  until the click.
- One reply page per issue. A new draft for an issue whose page is open replaces it when the person has
  not edited it; when they have, the draft is refused ("the person is editing a reply to <KEY>") and the
  page is left alone.
- Moved meanwhile: the Move re-reads the transitions; when the chosen one is gone, nothing is written (the
  comment neither), the list refreshes and the page says the status changed.
- The owner and write guests (Oleg, 2026-11-25: "with write access, yes"): the plugin is hidden from
  guests unless shown; even shown, a read guest gets no Reply and a write needs `access: write`, checked
  by the host on every click from `from.access`.

### `ccc jira update <KEY> [--status <name>] [-]`

- The comment comes on stdin with `-` (bounded like every plugin command's stdin), the status by
  transition name or target status name, case-insensitive. Either may be left out, not both.
- `draft`: opens the reply page with both filled in and answers at once, without waiting for the
  person (plugin commands are bounded to 30 s): "Draft opened for <KEY>: the person posts it." A
  status that matches no transition, or a disabled one, still opens the page with Keep status and a
  line naming what was asked and what is possible; the answer says so too.
- `direct`: writes (comment, then transition) and answers what happened step by step; an unknown or
  disabled status is refused before anything is written, with the list of possible ones.
- `off`: refused, "writing is off for this project (setting: What ccc jira update does)".
- Exit codes: 0 done or draft opened, 1 refused or failed. The guide topic (`ccc jira help`) says the
  person decides in draft mode, so Claude should not repeat the call to make it happen.

## CLI

`ccc jira status` (site, account, last poll, counts per lane, errors), `ccc jira refresh`,
`ccc jira list [lane]`, `ccc jira show <KEY>` (the readable text), `ccc jira read|unread <KEY>`,
`ccc jira update <KEY> [--status <name>] [-]` (0.8.0, section "Writing to Jira"; the only one with
stdin), `ccc jira help`.

## Left out of v1

The `jira` service has no events (a consumer asks again when it needs to; bronos.gmail caches its
answers with a TTL), and no write methods: other plugins (Autopilot) would draft the same way, a later
version.

Jira Server/DC (PAT), OAuth. Writes beyond a comment and a transition (fields, assignee, mentions,
restricted comments, a transition's own fields). Since 0.2.0 attachments
are shown (images inline, the rest as links) but not scaled down: a picture over 700 KiB is a
link.
