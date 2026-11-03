# Jira for cc-cockpit

`bronos.jira` shows your Jira Cloud issues in a cc-cockpit panel, in lanes, with unread marks,
sorted by [Jev triage](https://github.com/BronOS/cc-cockpit-jev-triage), and hands an issue to Claude
to discuss. It is **read-only towards Jira**: it never comments, transitions or edits.

- **Lanes**: Backlog, In progress, Mentioned, On hold, Done (choose which ones in the settings).
- **Unread**: Jira has no read state, so the plugin keeps its own. An issue is unread while someone
  else commented, changed its status / assignee / priority, assigned it to you or mentioned you
  after you last looked. The first run marks everything as seen, so only what happens next is new.
  Unread rows have an accent bar, bold text and a "new" / "N new" pill. **Mark unread** works on any
  issue (except Done) as a reminder ("unread" pill), cleared when you open it; it does not change triage.
- **Triage**: each lane is sorted by priority (urgent, action, fyi, noise), then the newest
  activity. Simple cases are decided by the plugin's own hints (Done is noise, an unread High
  issue is urgent, ...); the rest is judged by Jev through jev-triage.
- **Discuss with Claude**: click a row and the issue opens in the reviewer overlay as a styled page
  (description, comments, attachments with their images), where you select text to add notes and
  press Discuss (the Claude tab you are looking at) or New session.
- `ccc jira ...` from any tab of the project.

## Requirements

- cc-cockpit with plugin API 1. **cc-cockpit 0.8.0 or later for notes on the styled issue** (the
  bundled reviewer's `annotate` with its HTML mode). What opening an issue shows, by app:
  - 0.8.0 with the HTML mode: the styled issue with its images, notes, Discuss, New session;
  - a reviewer whose `annotate` takes text only (an early 0.8.0 build): the issue as plain text,
    with notes; the plugin notices the refusal once and uses text for the rest of the run;
  - 0.7.x (no `annotate`) or no reviewer enabled: the plugin's own read-only page with the same
    styled issue and images, and Discuss, New session and ↗ buttons (no notes).
  The row buttons Discuss / New session work the same everywhere.
- **Jev triage (`bronos.jev-triage`) for sorting**, which in turn needs the Jev plugin
  (`bronos.jev`). Without it the lanes work unsorted and the panel says triage is off.
- Jira Cloud (`https://<name>.atlassian.net`). Jira Server / Data Center is not supported.

## Create an API token

1. Sign in at <https://id.atlassian.com/manage-profile/security/api-tokens>
   (id.atlassian.com > Security > API tokens).
2. Either **Create API token** (a classic token: it can do what your account can), or **Create
   API token with scopes** (recommended): pick the Jira app and the read-only scopes
   **`read:jira-work`** and **`read:jira-user`**; nothing else is needed.
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
| `onHoldStatuses` | `[]` | status names counted as On hold (`Waiting`, `Blocked`), any letter case |
| `doneDays` | 14 | how far back Done looks |
| `mentionDays` | 7 | how far back Mentioned looks |
| `mentionProjects` | `[]` | project keys searched for mentions; empty: the projects of your assigned issues |
| `pollMinutes` | 3 | only while the project's window is open |
| `triageText` | `full` | `full` or `summary` (see Privacy) |

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

**Click a row** (or press Enter on it) to open the issue (see below); opening marks it read. The
other actions are small buttons that show while the pointer is over a row or the row has the
keyboard focus: **↗** (the issue in your browser), **Read / Unread**, the triage verdict (**action ▾**: change how much
the issue needs you; to record why, for jev-triage's eval, use Wrong? in the Jev triage panel), **Discuss**
(sends the issue to the Claude tab you are looking at; with several tabs and no way to tell, you
pick one) and **New** (a new Claude session about it). Keyboard: Tab to a row, ↑ / ↓ (Home / End)
move between rows, Enter or Space opens, Tab goes on to the row's buttons.

## The issue view

Opening an issue reads it fresh from Jira and shows it as a styled page:

- a header card: key and summary, type, status, priority, assignee, reporter, created and updated;
- the description, formatted as in Jira: headings, lists, tables, code blocks, quotes, panels
  (info, note, warning, error, success), mentions, status lozenges, expand sections, links;
- the comments oldest first, as cards; the ones others wrote since you last looked are marked new;
- **Attachments**: name and size of each; an image is shown where the text shows it (or in the list
  when the text does not), other files and images that are not shown are links to them in Jira
  (your browser's Jira session opens them).

The page is built by the plugin from Jira's document format, never from Jira's own HTML: every text
is escaped, links keep only `http(s)` and `mailto` addresses, and no picture is loaded from the
network by the page.

Images are downloaded by the plugin with your token (only from your site or the Atlassian gateway;
Jira hands the bytes over through its media host, which gets a signed address and never the
token), newest attachment first, within these limits:

| Limit | Value | Why |
|---|---|---|
| images per issue | 15 | the reviewer takes at most 30 assets; a thread of screenshots gets heavy |
| one image | 700 KiB | its data URL stays under the reviewer's 1,000,000 characters |
| all images | 7.5 MiB of data URLs | under the reviewer's 8 MiB |
| types | PNG, JPEG, GIF, WebP | checked on the bytes, not the type Jira claims; SVG is a link |
| waiting for downloads | 10 s an open | what is not there by then is a link this time |
| cache | 300 images, 64 MiB | in the plugin's project data folder, least recently used go first |

A bigger image, the 16th, or one that did not arrive in time is a link. Downloads that were still
running finish into the cache, so the next open shows them. The page is at most 2 MB of HTML: when
a very long thread does not fit, the oldest comments give way, with a line saying how many.

## CLI

```
ccc jira status            site, account, last poll, counts per lane, errors
ccc jira refresh           poll now
ccc jira list [lane]       backlog, inProgress, mentioned, onHold, done
ccc jira show <KEY>        the issue as readable text, new activity marked [new]
ccc jira read <KEY>        mark read
ccc jira unread <KEY>      mark unread
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
- The images of an opened issue go into the reviewer overlay (or the plugin's page) on your
  machine; Discuss and New session send the issue text, not the images.

## Development

Plain JavaScript, no build step: `dist/host.js` and `dist/lib/*.js` run as they are. `npm test`
(`node --test test/`) runs the suites (node:test, no dependencies, a fake Jira from recorded
response shapes; nothing reaches the network). Design: `docs/design.md`. Where the cc-cockpit
guide fell short while building it: `FRICTION.md`.

Link a checkout from a cc-cockpit tab: `ccc plugin link <folder>`; logs: `ccc plugin logs bronos.jira`.

## License

MIT, see LICENSE.
