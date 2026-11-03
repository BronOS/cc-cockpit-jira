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
