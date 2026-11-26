# Jira for cc-cockpit

`bronos.jira` shows your Jira Cloud issues in a cc-cockpit panel, in lanes, with unread marks,
sorted by [Jev triage](https://github.com/BronOS/cc-cockpit-jev-triage), and hands an issue to Claude
to discuss. Since 0.8.0 it writes two things to Jira, a **comment** and a **status change**, and only
when you click Post in the issue window's Reply tab: Claude can draft one with `ccc jira update`, you
post it (see "Writing to Jira"). Nothing else is ever edited.

- **Lanes**: Backlog, In progress, Mentioned, On hold, Done (choose which ones in the settings).
- **Unread**: Jira has no read state, so the plugin keeps its own. An issue is unread while someone
  else commented, changed its status / assignee / priority, assigned it to you or mentioned you
  after you last looked. The first run marks everything as seen, so only what happens next is new.
  Unread rows have an accent bar, bold text and a "new" / "N new" pill. **Mark unread** works on any
  issue (except Done) as a reminder ("unread" pill), cleared by Mark read; it does not change triage.
  Opening an issue leaves it unread unless you turn on `markReadOnOpen` (off by default).
- **Triage**: each lane is sorted by priority (urgent, action, fyi, noise), then the newest
  activity. Simple cases are decided by the plugin's own hints (Done is noise, an unread High
  issue is urgent, ...); the rest is judged by Jev through jev-triage.
- **The issue window** (0.9.0): click a row and the issue opens in its own window as a styled page
  (description, comments, attachments with their images), with a side column: **Ask** (questions about
  the issue, answered beside it), **Reply** (a comment and/or a status change) and your notes on
  selected text. **Discuss with Claude** in its toolbar sends the issue to the Claude tab you are looking
  at. `ccc jira update` drafts a reply for you to post (the `writes` setting).
- **Parts** (0.9.0): a mail or calendar window that names one of your projects' issues (Gmail's Jira
  mail) shows a small card of the issue beside it, with **Open issue**.
- `ccc jira ...` from any tab of the project.
- **For other plugins** (0.5.0): the `jira` service tells them an issue's status and shows the issue
  in their own views. The [Gmail plugin](https://github.com/BronOS/cc-cockpit-gmail) uses it for Jira
  mail: hints for triage and the issue below the mail (see "The jira service").

## Requirements

- cc-cockpit with plugin API 1. **0.9.0 needs cc-cockpit 0.27.0 or later** (overlays in every view: the
  app tells the plugin which screen and which person each copy of the window is). What the window has,
  by app:
  - 0.28.0 or later: the styled issue with its images, notes, Ask, Reply, Discuss, and parts beside
    other plugins' windows;
  - 0.27.x: the styled issue, Reply and Discuss; no notes, no Ask, no parts (`ccc jira status` says so);
  - older: an issue does not open (fail closed: the panel says which version it needs). Use Jira 0.8.0
    there.
  The row buttons Discuss / New session work the same everywhere. The reviewer is no longer used.
- **Jev triage (`bronos.jev-triage`) for sorting**, which in turn needs the Jev plugin
  (`bronos.jev`). Without it the lanes work unsorted and the panel says triage is off.
- Jira Cloud (`https://<name>.atlassian.net`). Jira Server / Data Center is not supported.

## Create an API token

1. Sign in at <https://id.atlassian.com/manage-profile/security/api-tokens>
   (id.atlassian.com > Security > API tokens).
2. Either **Create API token** (a classic token: it can do what your account can), or **Create
   API token with scopes** (recommended): pick the Jira app and the scopes **`read:jira-work`** and
   **`read:jira-user`**, plus **`write:jira-work`** for comments and status changes (Reply,
   `ccc jira update`). Without it the plugin reads as before and a write says the token may not
   write (403); with `writes` off nothing asks for it.
3. Copy the token (it is shown once) and enter it in cc-cockpit: **Settings > This project > Jira >
   API token**. It is stored encrypted in the OS keychain; `ccc plugin config` cannot set it.

Tokens expire (the date is chosen when you create one). When Jira refuses the token, the panel
says "token expired or wrong": create a new one and replace it in the same place.

How the token is used: Basic `email:token` over https. A classic token goes to your site; a token
with scopes only works through the Atlassian API gateway
(`https://api.atlassian.com/ex/jira/<cloudId>/...`, the cloudId read from your site's public
`/_edge/tenant_info`, which gets no token). With **Token kind: Auto** the plugin tries the site and
falls back to the gateway when the site refuses the token. The token is sent only to those two
hosts and never follows a redirect to another host.

## Settings (per project)

Settings > This project > Jira, or from a tab: `ccc plugin config bronos.jira <key>=<value>`
(everything but the token). A work project and a personal one can use different sites.

| Setting | Default | |
|---|---|---|
| `site` | | `https://<name>.atlassian.net`, https only, no path |
| `email` | | your Atlassian account email |
| `apiToken` | | secret, Settings only |
| `tokenKind` | `auto` | `auto`, `classic` or `scoped` |
| `lanes` | backlog, inProgress, mentioned on; onHold, done off | a hidden lane is not fetched and never sent to triage |
| `rowsPerLane` | 10 | issues a lane shows; the rest behind Show all at the bottom of the lane (remembered per lane) |
| `markReadOnOpen` | off | "Mark an issue read when I open it": off, opening an issue (from the panel or from Inbox) leaves it unread until Mark read; on, opening marks it read |
| `onHoldStatuses` | `[]` | status names counted as On hold (`Waiting`, `Blocked`), any letter case |
| `doneDays` | 14 | how far back Done looks |
| `mentionDays` | 7 | how far back Mentioned looks |
| `mentionProjects` | `[]` | project keys searched for mentions; empty: the projects of your assigned issues |
| `pollMinutes` | 3 | only while the project's window is open |
| `triageText` | `full` | `full` or `summary` (see Privacy) |
| `writes` | `draft` | "What ccc jira update does": `draft` (Claude drafts, I post), `direct` (ccc writes directly) or `off` (read-only: no Reply, the command refused); see "Writing to Jira" |
| `mailSenders` | `[]` | addresses Jira's notification mails come from, for other plugins (Gmail); empty: `jira@<your site's host>` |

```sh
ccc plugin config bronos.jira site=https://acme.atlassian.net email=me@acme.com
ccc plugin config bronos.jira 'onHoldStatuses=["Waiting","Code Review"]' 'lanes={"backlog":true,"inProgress":true,"mentioned":true,"onHold":true,"done":false}'
```

## Lanes

| Lane | What | Search |
|---|---|---|
| Backlog | assigned to you, status category To Do | `assignee = currentUser() AND statusCategory != Done` |
| In progress | assigned to you, category In Progress | same search |
| On hold | assigned to you, a status in `onHoldStatuses` (wins over the category) | same search |
| Mentioned | not assigned to you, someone mentioned you in the description or a comment within `mentionDays` | `project in (...) AND updated >= -7d AND (assignee != currentUser() OR assignee is EMPTY)` |
| Done | assigned to you, reached Done within `doneDays` | `... statusCategory = Done AND statusCategoryChangedDate >= -14d` |

JQL cannot search mentions (they are account ids inside the issue text), so the plugin reads each
Mentioned candidate and looks for a mention of you. An assigned issue where you were mentioned
stays in its own lane, marked unread. Issues are read in full only when their `updated` changed
(at most 120 a poll, 4 at a time; the rest come with the next polls).

**Click a row** (or press Enter on it) to open the issue (see below); opening marks it read only with `markReadOnOpen` on. The
other actions are small buttons that show while the pointer is over a row or the row has the
keyboard focus: **↗** (the issue in your browser), **Read / Unread**, the triage verdict (**action ▾**: change how much
the issue needs you; to record why, for jev-triage's eval, use Wrong? in the Jev triage panel), **Reply**
(the issue window on its Reply tab; not shown with `writes` off), **Discuss**
(sends the issue to the Claude tab you are looking at; with several tabs and no way to tell, you
pick one) and **New** (a new Claude session about it). Keyboard: Tab to a row, ↑ / ↓ (Home / End)
move between rows, Enter or Space opens, Tab goes on to the row's buttons.

## The issue window

Opening an issue shows its window at once (with a loading state), reads the issue fresh from Jira and
draws it as a styled page:

- a header card: key and summary, the key facts (status, priority, assignee) and **More details**
  folded below (type, reporter, created, updated and the rest);
- the description, formatted as in Jira: headings, lists, tables, code blocks, quotes, panels
  (info, note, warning, error, success), mentions, status lozenges, expand sections, links;
- the comments oldest first, as cards; the ones others wrote since you last looked are marked new;
- **Attachments**: name and size of each; an image is shown where the text shows it (or in the list
  when the text does not), other files and images that are not shown are links to them in Jira
  (your browser's Jira session opens them).

When Jira cannot be reached, an issue in the lanes opens as the copy from the last poll, with a line
saying so. One with no such copy shows the error in the window with a **Try again** button (yours; a
guest sees only that the issue could not be loaded), which reads it again in the same window; the
error shows in the panel too. An issue that was never shown stays unread.

One window per issue: opening it again brings it to the front. With web access the window is on every
screen that shows the project, each with its own copy (the side tab you last used, your scroll); links
and **Open in Jira ↗** open on the screen you clicked on. Notes are kept by cc-cockpit per issue
(`jira:<KEY>`), so they are there the next time you open it. **Ask** answers questions about the issue
in the column beside it; an answer is never put into Reply. On an older app without notes or Ask the
window has Reply and the page only.

The page is built by the plugin from Jira's document format, never from Jira's own HTML: every text
is escaped, links keep only `http(s)` and `mailto` addresses, and no picture is loaded from the
network by the page.

Images are downloaded by the plugin with your token (only from your site or the Atlassian gateway;
Jira hands the bytes over through its media host, which gets a signed address and never the
token), newest attachment first, within these limits:

| Limit | Value | Why |
|---|---|---|
| images per issue | 15 | a thread of screenshots gets heavy |
| one image | 700 KiB | its data URL stays under 1,000,000 characters |
| all images | 7.5 MiB of data URLs | the window's state goes to every screen showing it |
| types | PNG, JPEG, GIF, WebP | checked on the bytes, not the type Jira claims; SVG is a link |
| waiting for downloads | 10 s an open | what is not there by then is a link this time |
| cache | 300 images, 64 MiB | in the plugin's project data folder, least recently used go first |

A bigger image, the 16th, or one that did not arrive in time is a link. Downloads that were still
running finish into the cache, so the next open shows them. The page is at most 2 MB of HTML: when
a very long thread does not fit, the oldest comments give way, with a line saying how many.

## Writing to Jira

Since 0.8.0 the plugin writes a **comment** and a **status change** (a workflow transition) to one
issue, together or alone, and nothing else (no fields, assignee, mentions, restricted comments or a
transition's own screen fields).

**The Reply tab** (0.9.0; 0.8.0 had a separate reply page). The issue window's side tab, opened by the
row's **Reply** button (hover, like Discuss), by choosing the tab, and by `ccc jira update` in draft mode
(a draft opens the window on Reply). It shows the current status, **Move to** (Keep status, then the
moves Jira allows from this status, read fresh when the tab is first opened; one that needs fields,
such as a resolution screen, is listed but disabled: open it in Jira) and the comment box. The comment
is plain text: a blank line starts a paragraph, a single line break stays a line break, nothing is
formatting, no mentions, at most 32,000 characters. One button, its label from what you chose: **Post
comment**, **Move**, or **Post and move**; disabled while nothing would happen. No keyboard shortcut
posts: the click is the decision.

There is one reply per issue, kept by the plugin: closing the window (Esc) keeps it, and reopening the
issue shows it again. On several screens (yours, a write guest's) every copy shows the same reply as
it is typed; the last edit wins. A Post is accepted only when the words and the move it carries are
the ones the form holds, so a click made while another screen's edit or a new draft was arriving
writes nothing and says the draft just changed.

When you click, the moves are read again first: if the one you chose is gone (someone moved the issue
meanwhile) or the status is no longer the one shown, nothing is written, the comment neither, and
the list refreshes. Then the comment is posted, then the move, each reported on its own: a refused
move after a posted comment says so, clears the box (the comment is in Jira) and keeps your status
choice for a retry. On success the form starts over, the window shows the issue as it is now, and the
panel says what was done. Afterwards the issue
is read again, its seen mark moves past your own change (it never shows as unread), and Inbox hears it.

**`ccc jira update <KEY> [--status <name>] [-]`.** The comment on stdin with `-`, the status by
transition name or target status name, any letter case; either may be left out, not both. What it does
follows the project's **`writes`** setting ("What ccc jira update does"), read on every call:

| `writes` | |
|---|---|
| `draft` (default, "Claude drafts, I post") | fills Reply in the issue window, opens the window on that tab and answers at once: `Draft opened for ABC-1: the person posts it.` Nothing is written until you click. A status that matches no move (or a disabled one) keeps the status and shows a line naming what was asked and what is possible; the answer says so too. The tab marks a draft "✎ Draft from Claude (tab name)" when a Claude tab ran the command (the app's own word), else "✎ Draft from ccc". While the reply is untouched a new draft replaces it; once anyone typed in it (on any screen), the draft is refused and the words are left alone. |
| `direct` ("ccc writes directly") | writes, comment then move, and prints each step; an unknown or disabled status is refused before anything is written, with the possible ones. |
| `off` ("Read-only") | refused: "writing is off for this project"; the panel offers no Reply either. |

Exit 0 when written or the draft opened, 1 when refused or failed. Why the setting lives in the
plugin and not in Claude's permissions: issue text reaches Claude (Discuss, `ccc jira show`, triage),
so a description can say "close this ticket"; a skill is advice that text competes with, and Claude
Code's permission rules are walked around by a script and skipped in auto modes. The plugin reads the
setting for every caller (a Claude tab, your shell, a script), so the rule is "ccc drafts, the window
writes". It is not a security boundary (Claude runs as your OS user); it keeps a prompt-injected Claude
from writing to Jira unseen. A per-project `Bash(ccc jira update:*)` ask rule is a good extra layer.

**Guests.** The plugin is hidden from guests unless you show it. A read-only guest's copy of the window
has no Reply tab and never receives the reply or a draft; a write guest's copy has Reply and may post
(with your Jira token, as you would). Every Post is checked against the access the app reports for the
copy it came from (owner or a write guest), and one with no access reported writes nothing. Ask is for
you and write guests; notes follow the app's guest rules.

**Safety.** Writes go to the same place as reads (your site, or the gateway for a scoped token),
https only, and never follow a redirect: a redirected write is an error and nothing is sent again. A
403 says the token may not write (a scoped token needs `write:jira-work`); a 400 shows Jira's reason.
The `jira` service other plugins use has no write methods.

Needs cc-cockpit 0.10.1 or later for `ccc jira update ... -` alone to read stdin (`stdinDash`; an
older app reads stdin for every `ccc jira` call, bounded by ccc's own deadline).

## The jira service

Since 0.5.0 the plugin provides the service `jira` to the other plugins of the project (v2 since 0.9.0:
`openIssue`). A plugin declares `"services": { "uses": { "jira": 1 } }` (`2` for `openIssue`) and calls `ctx.services.use('jira')`; it
needs nothing else (no token: the calls go through this plugin, which talks to Jira). Every method
is async, takes and returns plain data, and rejects with `jira: <why>` (never a token).

| Method | Answers |
|---|---|
| `site()` | `{ ready, site, senders, account }`: the configured site, the addresses its notification mails come from (`mailSenders`, else `jira@<site host>`), and your account `{ accountId, displayName }` once a poll knows it (else null). Not configured: `ready: false` and `error`. Never rejects. |
| `issue(key, { maxAgeMs? })` | `{ key, summary, status, category, done, priority, type, assignee, mine, lane, url, updatedAt, source, at }`: `category` is Jira's status category (`new`, `indeterminate`, `done`), `mine` whether you are the assignee, `lane` the panel lane or null, `source` `poll` or `fetch`. From the last poll when it is at most `maxAgeMs` old (default 5 min, 15 s to 1 h), else from a cache of earlier answers, else one small read of the issue's header fields. |
| `document(key, { maxHtmlBytes?, maxImages?, maxImageChars?, waitMs? })` | `{ key, title, url, html, aside, assets }`: the issue as a styled document (the HTML body, the details column, the pictures as assets `{ id, name, mime, dataUrl }`), read fresh (the cached copy, with `stale`, when Jira cannot be reached). The options can only lower this plugin's own limits (2,000,000 bytes, 15 pictures, 7.5 MiB, 10 s), for a plugin that shows the issue beside its own content. It does not mark the issue read. |
| `openIssue(key, { reply? })` (v2) | `{ opened: true }`: the issue's window, as a row click opens it (brought to the front when open); `reply: true` opens it on Reply when writing is on. For a plugin's own "Open issue" (a Jira mail in Gmail). |

`key` must look like `ABC-123` (letters, digits and `_`, a dash, a number; at most 64 characters), so
nothing else reaches a Jira URL. The service protects Jira from a busy caller: lookups that need Jira
run at most 2 at a time and 30 a minute, documents 1 at a time and 6 a minute; a call past that is
refused at once (`jira: busy ...`, `jira: too many ...`) and logged with the caller's id. An unknown
key is not asked again for 5 minutes. No newer cc-cockpit is needed: plugin services are in every
app version this plugin runs on (tested against 0.9.2).

## Inbox

The plugin also provides `inbox-feed` (v2) for the Inbox plugin, which lists the items of every
source in one place and sorts them with its own rules. The feed holds the issues of the Backlog,
In progress, On hold and Mentioned lanes (read from the cache, never from Jira); an issue that
reaches the Done lane, or a lane you switch off, leaves it. Nothing else is filtered: no noise rule,
no count limit, and no triage level (the Jev verdicts stay in this plugin's lanes). Its scope line
("my open issues + mentions of the last 7 days") follows your lane settings.

Facts sit where Inbox's rules match them. The place is the project key and the status name. The
labels are `assigned` (or `mentioned`), `priority:<name>`, `type:<name>`, `due:YYYY-MM-DD`, for an
issue that is not yours `assignee:<name>` or `unassigned`, and your Jira labels as `label:<name>`.
The `rev` is the issue's `updated`, so Inbox's "done until it changes" sees any comment or status
change; marking read does not move it. The preview is the latest comment, else the start of the
description. Actions: Open (the issue window, as a row click does) and Mark
read / Mark unread (this plugin's own seen marks). Open marks the item read only with `markReadOnOpen`
on; off (the default), the item keeps `read: false` and no event after the open says otherwise.

The plugin tells Inbox what changed (`item`, `gone`, and a `sync` when its state changes: not set
up, a refused token, an error, a recovery) after each poll, mark and settings change. Needs
cc-cockpit 0.10.0 for Inbox 0.2.0 to read it; the toolbar buttons below need an app with `ctx.overlay.buttons`
(0.10).

**Issue windows.** An issue's window has the overlay type `inbox-item { source: "bronos.jira", id }`.
Inbox's Open answers once the window is on screen, before the issue is read; a read that fails then is
the window's error page. On an app that has `ctx.overlay.buttons`, the window of an issue still in the
lanes gets Mark read / Mark unread in its toolbar (the same code as the feed's `act`; a failure shows in
the panel's notice), and Discuss with Claude sends the issue as text. Only a window this plugin opened
gets them (the app's `opener`, not the overlay's data): another plugin opening an overlay that names one
of our issues gets none.

## Parts

Another plugin's window can tell the app what it shows (cc-cockpit 0.28.0: a mail, a calendar event,
with the references it found). When one names an issue key of a project this plugin knows (the
`mentionProjects` setting, the projects of the issues in your lanes, issues it has read), a small card of
that issue sits beside their page: key, summary, status, priority, type, assignee, **Open in Jira ↗** and
**Open issue** (yours only: it opens the issue window). A part never writes. Discuss and Ask in it take
the issue's text. Only the first such key gets a part; a window naming another one replaces it, one
naming none removes it. Anything that is not a known project's key (a word, a path, a key of a project
this plugin does not know) attaches nothing and reads nothing from Jira.

## CLI

```
ccc jira status            site, account, last poll, counts per lane, errors
ccc jira refresh           poll now
ccc jira list [lane]       backlog, inProgress, mentioned, onHold, done
ccc jira show <KEY>        the issue as readable text, new activity marked [new]
ccc jira read <KEY>        mark read
ccc jira unread <KEY>      mark unread
ccc jira update <KEY> [--status <name>] [-]
                           a comment (stdin, with -) and/or a status change; see "Writing to Jira"
                           (draft: fills Reply in the issue window)
ccc jira help
```

## Privacy

- With `triageText: full` (the default) the summary, description and comments of the issues in
  the shown lanes go to **Jev** (through jev-triage; Jev calls a model provider, see the Jev plugin)
  to be sorted. If your employer objects to issue text leaving, set `triageText` to `summary`: then
  only the key, summary, status, priority and type go, or turn jev-triage off for the project.
- Discuss and New session put the issue text into a Claude Code session, which sends it to
  Anthropic like anything else you type there.
- The plugin keeps a cache of the issues it shows and of the attachment images it downloaded (the
  plugin's project data folder) and its seen marks (plugin storage), all bounded. The token stays
  in the OS keychain.
- The images of an opened issue go into the issue window, on every screen that shows it (yours, and a
  guest's when you show the plugin to guests); Discuss, Ask and New session send the issue text, not the
  images.

## Development

Plain JavaScript, no build step: `dist/host.js` and `dist/lib/*.js` run as they are. `npm test`
(`node --test test/`) runs the suites (node:test, no dependencies, a fake Jira from recorded
response shapes; nothing reaches the network). The overlay kit the windows are drawn with is vendored in
`vendor/cc-kit` (a pinned copy of cc-cockpit's `kit/`; `test/kit-pin.test.js` checks its bytes against
its `SHA256SUMS`). Design: `docs/design.md`. Where the cc-cockpit
guide fell short while building it: `FRICTION.md`.

Link a checkout from a cc-cockpit tab: `ccc plugin link <folder>`; logs: `ccc plugin logs bronos.jira`.

## License

MIT, see LICENSE.
