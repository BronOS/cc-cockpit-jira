# Friction log

Each entry is one place where the cc-cockpit guide (`ccc guide`, every topic, `ccc guide types`, and
`ccc help`) was not enough, was ambiguous, or an API was missing, found while building `bronos.jira`
from the guide alone (no app source read), against cc-cockpit 0.7.0 on 2026-11-02. Format: what I
needed, what the guide says, what I did instead. Status: **Open** unless marked.

Known gaps already reported elsewhere (bronos.jev-triage's FRICTION.md), only referenced here:
panels cannot submit a `<form>` (buttons used throughout); `stdin: true` applies to every
subcommand (`ccc jira` declares no stdin); no way to see a panel from a session; no host test kit
(this repo has its own fake ctx in `test/fakes.js`); whether a promise from `deactivate` is awaited
(`stop()` returns the cache flush, assuming it is).

## cc-cockpit guide and app

- **`api` / `plugins`: the bundled reviewer's service is not documented.** Open.
  Needed: `reviewer.annotate({ title, text, url?, key?, tabId? })` (coming in 0.8.0): what it
  resolves with (at once, or when the overlay closes?), what `key` does (a draft per key?), what
  `tabId` means when the person presses New session, limits on `text`. Guide: names
  `cockpit.reviewer` and says another `reviewer` provider can replace it, but no topic lists the
  `reviewer` service's methods, version or events (nor `editor`'s), and `ccc guide types` has none.
  Did: coded against the signature in my brief, awaited the call only to catch a rejection, and
  passed the active tab when one is known.

- **`api`: a consumer cannot tell which methods a provider has.** Open.
  Needed: tell "the reviewer is there but has no `annotate` (0.7.0)" from "annotate failed".
  Guide: `ctx.services.available(name)` is true for any provider at the same major; a missing
  method only shows as the rejection `service "x" (plugin P) has no method "m"`. A new method in
  a minor release has no version to check. Did: match that message text (`isMissingAnnotate`,
  `dist/lib/actions.js`) and remember the result for the run; a message reworded in the app would
  turn every Open into an error notice. Would help: `available(name, method)` or a minor version.

- **`api` / `panels`: no way to open a URL in the system browser.** Open.
  Needed: the row's ↗ (the issue on the Jira site). Guide: the `webview` topic says `window.open`
  and `target="_blank"` there go to the system browser, and `ctx.oauth` opens it for sign-in; for an
  html panel or overlay page nothing says what a link does (the sandbox allows scripts only), and
  the host has no `openExternal`. Did: `ctx.exec(['xdg-open', url])` (`open` on macOS), the URL as
  one argument and https only; on Windows the panel shows the URL instead (`start` needs a shell).
  (0.2.0) Same question for a link inside an html overlay page (the fallback reader shows Jira
  links and attachment links): does a click navigate the overlay frame, go to the system browser,
  or nothing? Did: the page catches every link click and posts `{ open: href }`; the host opens
  http(s) with the same `ctx.exec` opener and shows anything else as text.

- **`api`: which Claude tab the person is looking at.** Open (being added: `SessionInfo.active` in 0.8.0).
  Needed: Discuss sends to "the currently open Claude tab". Guide/types: `SessionInfo` has status,
  title, cwd, but nothing about focus. Did: use `active` when the app sends it, else the only live
  tab, else a picker in the panel.

- **`settings-secrets`: is a secret field in the project schema stored per project?** Open.
  Needed: a work project and a personal one with different Jira tokens. Guide: secret fields are
  "a top-level string property" and the person enters them in "Settings > Plugins (app scope) or
  Settings > This project", while `ctx.secrets` is app-wide; it never says whether a project-scope
  secret field is one value per project or one value shown in every project. Did: assumed per
  project (the design depends on it). Check live with two projects.

- **`settings-secrets`: are defaults applied inside a nested object?** Open.
  Needed: `lanes` is an object of five booleans with per-property defaults. Guide: "`ctx.settings`:
  ... with schema defaults applied" and "A nested `object` is a group of its own fields"; it does not
  say whether a missing nested object gets its properties' defaults, or a partial one (an older save)
  the missing keys. Did: a `default` on the object as well, and a per-lane fallback in the host
  (`readSettings`). (Live: `ccc plugin config bronos.jira` printed the full object, so the
  object default at least applies.)

- **`api`: what "abandoned" means for a `ctx.schedule` run over 60 s.** Open.
  Needed: a first poll can read a few hundred issues and pass 60 s. Guide: "a run over 60 s is
  abandoned and reported; an error shows as ⚠ on the plugin's panels". Abandoned how: is the run's
  promise just ignored while its work goes on (then a ⚠ for a slow but fine poll), or is something
  cancelled? Did: the scheduled function only starts a poll and returns; the host keeps polls from
  overlapping itself. Also a per-poll budget of 120 full reads.

- **`api`: no length limit stated for `ctx.sessions.send`.** Open (same as jev-triage's entry for `sessions.open`).
  Needed: Discuss pastes the whole issue (description, every comment). Guide: send is a bracketed
  paste while waiting, 30 texts a minute, refused prefixes; no size limit for `send` or for
  `open({ prompt })`. Did: cap the prompt at 16,000 characters.

- **`api`: the host globals list leaves out `Response`.** Open (minor).
  Guide: "The standard globals are there: `fetch`, `Headers`, `Request`, `URL`, ..." without
  `Response`, though `fetch` resolves one. Did: never construct a `Response` in host code (only
  the tests do), so the plugin does not depend on it.

- **`api`: a plugin cannot learn the app version.** Open (minor).
  Needed: say "annotations need cc-cockpit 0.8.0" only when the app is older. Guide: `ctx.api` is
  the plugin API major only; `ccc` warns about a version mismatch but a plugin sees no version.
  Did: the panel and `ccc jira status` say "needs cc-cockpit 0.8.0" whenever annotate is missing
  (the reviewer may also be off or replaced).

- **`api` / `dev-loop`: what `fetch` does with `redirect: 'manual'` in the host.** Open (to check live).
  Needed: follow redirects by hand so the token never goes to another host. Guide: "Network access
  is plain Node", which in Node means a 3xx response with its `Location` (not the browser's opaque
  redirect). Did: rely on that (plain Node 26 against a loopback server: 302 with its Location, as expected);
  the suites use a fake fetch, so it is unverified inside the app's Electron build.

## Found building 0.2.0 (HTML issue view, row clicks), 2026-11-02

Against the installed cc-cockpit 0.7.0 guide; the reviewer's HTML mode comes with 0.8.0 (being
built), so its shape is from my brief, not from the guide.

- **`api` / `plugins`: a consumer cannot tell whether `reviewer.annotate` has the HTML mode.** Open.
  Needed: send `{ html, assets }` to a reviewer that takes it, `{ text }` to one whose annotate is
  text-only (0.7 has none; early 0.8 builds take text only). Guide: no reviewer methods at all (the
  entry above), no service minor version, and `available(name)` is per major. What a text-only
  annotate does with an unknown `html` field (reject? ignore it and show nothing?) is not said,
  nor the rejection text. Did: call with html; on any rejection but "has no method" retry with
  text, and remember "html refused" for the run only when the text call worked (so an overlay
  that failed for another reason does not switch modes). A reviewer that silently ignored `html`
  and opened an empty overlay would not be noticed. Would help: a capability list or a minor
  version on the service (`available('reviewer', 'annotate.html')`), or the guide naming the
  error a provider throws for an unknown field.

- **`api`: the reviewer's assets are given only at call time.** Open (brief: "if the reviewer API
  only takes assets at call time").
  Needed: open the issue at once and let images arrive as they download. Guide: nothing (no
  reviewer docs); the brief's `annotate` has no handle and no way to add assets later. Did: wait at
  most 10 s for the downloads, send what is there, make the rest links; the running downloads go
  to a cache for the next open. Would help: `annotate` returning a handle with `addAssets`, or
  `assets` accepting a pending marker the reviewer fills from a later call. Also unstated: the
  characters an asset id may use (I use `att<digits>`), whether an asset no `<img>` references is
  an error, and whether a note can anchor on an image (its alt text) or only on text.

- **`panels`: keyboard focus in a panel frame.** Open.
  Needed: rows the keyboard can reach (Tab to a row, arrows between rows, Enter opens, Tab on to
  its buttons). Guide: says what the frame's CSP and sandbox allow, and that `--cc-focus` is the
  focus-ring colour, but not how the keyboard gets into a panel (a shortcut to focus a panel? does
  Tab from the terminal reach the frame?) nor which keys the app takes before the page sees them
  (do arrow keys, Enter or Space in a focused panel ever reach a terminal or an app shortcut?).
  Did: ordinary tab stops and key handlers inside the page, checked only in headless Chromium with
  a stand-in SDK, not inside the app.

- **`api`: no size guidance for `ctx.dataDir`.** Open (minor).
  Needed: an image cache in the project data folder. Guide: the folder's path and that it is
  created on first read; nothing on a quota, whether the app ever cleans it (plugin uninstalled,
  project removed), or whether a big folder is a problem (backups, sync). Did: bound the cache
  myself (300 files, 64 MiB, least recently used first).
