'use strict'
// Fakes shared by the suites: a Jira Cloud site behind a fake fetch (answers from the recorded
// shapes in fixtures/, never the network) and a cc-cockpit ctx written from `ccc guide api`.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SITE = 'https://acme.atlassian.net'
const GATEWAY = 'https://api.atlassian.com'
const MEDIA = 'https://api.media.atlassian.com'
const EMAIL = 'me@example.com'
const TOKEN = 'ATATT3xFfGF0-test-token'
const ME = '5b10ac8d82e05b22cc7d4ef5'
const NOW = Date.parse('2026-11-02T12:00:00Z')

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/**
 * A fake Jira. `scoped: true` makes the site refuse the token (as it does a scoped one) and the
 * gateway take it. `issues` overrides issue bodies; `fail` maps a key to a status; `routes` lets
 * a test answer a URL itself first (return undefined to fall through). `attachments` maps an
 * attachment id to its bytes: the content URL answers 303 to the media host with a signed address,
 * as Jira Cloud does, and the media host serves the bytes only without the token (`mediaDelay`:
 * ms before it answers).
 *
 * Writes (0.8.0): `GET .../issue/<KEY>/transitions` answers `opts.transitions` (by key, else
 * TRANSITIONS); `POST .../comment` and `POST .../transitions` are recorded in `writes` (method,
 * path, body) and answer 201 / 204, or `opts.failComment` / `opts.failTransition` (a status) with
 * Jira's error body. `opts.onWrite(w)` runs after each recorded write (a test moves the issue).
 */
function fakeJira(opts = {}) {
  const calls = []
  const writes = []
  const expected = 'Basic ' + Buffer.from(`${EMAIL}:${opts.token || TOKEN}`).toString('base64')
  // `opts.alsoToken`: a second token the site takes too (a valid replacement set in the settings).
  const also = opts.alsoToken ? 'Basic ' + Buffer.from(`${EMAIL}:${opts.alsoToken}`).toString('base64') : null
  const cloudId = fixture('tenant_info.json').cloudId
  async function fetch(url, init = {}) {
    const headers = init.headers || {}
    calls.push({ url, auth: headers.Authorization, redirect: init.redirect, method: init.method || 'GET', body: init.body })
    if (opts.routes) {
      const r = await opts.routes(url, init)
      if (r) return r
    }
    const u = new URL(url)
    if (u.origin === SITE && u.pathname === '/_edge/tenant_info') return json({ cloudId })
    if (u.origin === MEDIA) {
      const id = u.pathname.match(/^\/file\/f-(\d+)\/binary$/)
      if (opts.mediaDelay) await new Promise((r) => setTimeout(r, opts.mediaDelay))
      if (headers.Authorization) return json({ error: 'a media URL takes its signed token alone' }, 400)
      if (!id || u.searchParams.get('token') !== 'signed' || !opts.attachments || !opts.attachments[id[1]]) return json({ error: 'nope' }, 404)
      return new Response(opts.attachments[id[1]], { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    }
    let rest
    if (u.origin === SITE) {
      if (opts.scoped || (headers.Authorization !== expected && headers.Authorization !== also)) return json(fixture('error-401.json'), 401)
      rest = u.pathname
    } else if (u.origin === GATEWAY && u.pathname.startsWith(`/ex/jira/${cloudId}/`)) {
      if (!opts.scoped || headers.Authorization !== expected) return json(fixture('error-401.json'), 401)
      rest = u.pathname.slice(`/ex/jira/${cloudId}`.length)
    } else {
      throw new Error(`fake jira: unexpected host ${u.origin}`)
    }
    if (rest === '/rest/api/3/myself') return json(fixture('myself.json'))
    const att = rest.match(/^\/rest\/api\/3\/attachment\/content\/(\d+)$/)
    if (att) {
      if (!opts.attachments || !opts.attachments[att[1]]) return json({ errorMessages: ['no such attachment'] }, 404)
      return new Response(null, { status: 303, headers: { location: `${MEDIA}/file/f-${att[1]}/binary?token=signed&client=c1` } })
    }
    if (rest === '/rest/api/3/search/jql') {
      const jql = u.searchParams.get('jql')
      if (jql.includes('statusCategory != Done')) {
        return json(u.searchParams.get('nextPageToken') === 'CAEaAggD' ? fixture('search-assigned-2.json') : fixture('search-assigned-1.json'))
      }
      if (jql.includes('statusCategory = Done')) return opts.failDone ? json({ errorMessages: ['boom'] }, 500) : json(fixture('search-done.json'))
      if (jql.startsWith('project in')) return json(fixture('search-mentioned.json'))
      return json({ issues: [] })
    }
    const w = rest.match(/^\/rest\/api\/3\/issue\/([A-Z0-9_]+-\d+)\/(comment|transitions)$/)
    if (w && init.method === 'POST') {
      const rec = { method: 'POST', key: w[1], what: w[2], body: JSON.parse(init.body) }
      const fail = w[2] === 'comment' ? opts.failComment : opts.failTransition
      if (fail) return json({ errorMessages: [`${w[2]} refused`], errors: w[2] === 'transitions' ? { resolution: 'Resolution is required.' } : {} }, fail)
      writes.push(rec)
      if (opts.onWrite) opts.onWrite(rec)
      return w[2] === 'comment' ? json({ id: String(9000 + writes.length) }, 201) : new Response(null, { status: 204 })
    }
    if (w && w[2] === 'transitions') {
      if (u.searchParams.get('expand') !== 'transitions.fields') return json({ errorMessages: ['expand missing'] }, 400)
      const t = opts.transitions && (typeof opts.transitions === 'function' ? opts.transitions(w[1]) : opts.transitions[w[1]])
      return json(t || TRANSITIONS)
    }
    const m = rest.match(/^\/rest\/api\/3\/issue\/([A-Z0-9_]+-\d+)$/)
    if (m) {
      if (opts.fail && opts.fail[m[1]]) return json({ errorMessages: ['nope'] }, opts.fail[m[1]])
      if (opts.issues && opts.issues[m[1]]) return json(opts.issues[m[1]])
      try {
        return json(fixture(`issue-${m[1]}.json`))
      } catch {
        return json({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }, 404)
      }
    }
    return json({ errorMessages: ['not found'] }, 404)
  }
  return { fetch, calls, writes }
}

/** A transitions answer as Jira gives it (expand=transitions.fields): two plain moves and one with a resolution screen. */
const TRANSITIONS = {
  transitions: [
    { id: '21', name: 'Start progress', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, isAvailable: true, fields: {} },
    { id: '31', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } }, isAvailable: true, fields: { resolution: { required: false, name: 'Resolution', hasDefaultValue: false } } },
    { id: '41', name: 'Resolve', to: { name: 'Resolved', statusCategory: { key: 'done' } }, isAvailable: true, fields: { resolution: { required: true, name: 'Resolution', hasDefaultValue: false } } },
  ],
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jira-test-'))
}

const CONFIGURED = { site: SITE, email: EMAIL, apiToken: TOKEN }

/**
 * A ctx good enough for dist/host.js: in-memory storage, recorded posts, badges, sessions, exec,
 * perView overlays (fakeOverlay), notes, announcements and parts (not with `opts.oldApp`); the service
 * `triage` from `opts`.
 */
function fakeCtx(opts = {}) {
  const store = new Map()
  const panelListeners = []
  const settingsListeners = []
  const dataDir = opts.dataDir || tmpDir()
  const services = { triage: opts.triage || null }
  const ctx = {
    api: 1,
    pluginId: 'bronos.jira',
    projectDir: dataDir,
    dataDir,
    settings: Object.freeze({ project: opts.project || {}, app: {} }),
    posts: [],
    badges: [],
    logs: [],
    sent: [],
    opened: [],
    execs: [],
    overlays: [],
    buttonProviders: [],
    schedules: [],
    sessionList: opts.sessions || [],
    onSettingsChange(fn) {
      settingsListeners.push(fn)
      return () => {}
    },
    async changeSettings(project) {
      ctx.settings = Object.freeze({ project, app: {} })
      for (const fn of settingsListeners) await fn(ctx.settings)
    },
    storage: {
      async get(k) {
        return store.has(k) ? structuredClone(store.get(k)) : undefined
      },
      async set(k, v) {
        store.set(k, structuredClone(v))
      },
      async delete(k) {
        store.delete(k)
      },
      async keys() {
        return [...store.keys()]
      },
    },
    log: {
      info: (...a) => ctx.logs.push(['info', a.join(' ')]),
      warn: (...a) => ctx.logs.push(['warn', a.join(' ')]),
      error: (...a) => ctx.logs.push(['error', a.join(' ')]),
    },
    badge: (panel, v) => ctx.badges.push(v),
    schedule(seconds, fn) {
      ctx.schedules.push({ seconds, fn })
      return () => {}
    },
    async exec(argv, o) {
      ctx.execs.push({ argv, o })
      return { code: 0, stdout: '', stderr: '' }
    },
    panels: {
      post: (panel, m) => ctx.posts.push(structuredClone(m)),
      onMessage: (panel, fn) => {
        panelListeners.push(fn)
        return () => {}
      },
      show() {},
    },
    async sendPanel(m, from) {
      for (const fn of panelListeners) await fn(m, from)
    },
    overlay: {
      start: (spec) => fakeOverlay(ctx, opts, spec, ctx.overlays),
    },
    // App-wide plugin storage (the kit keeps the owner's last side tab there).
    appStore: new Map(),
    appStorage: {
      async get(k) {
        return ctx.appStore.has(k) ? structuredClone(ctx.appStore.get(k)) : undefined
      },
      async set(k, v) {
        ctx.appStore.set(k, structuredClone(v))
      },
    },
    parts: [],
    announceListeners: [],
    /** Another plugin's overlay announces (`handle.announce`): every listener of that kind hears it. */
    announce(a) {
      for (const l of ctx.announceListeners) if (l.kind === a.kind) l.fn(structuredClone(a))
    },
    sessions: {
      async list() {
        return ctx.sessionList
      },
      async send(tabId, text) {
        ctx.sent.push({ tabId, text })
        return { delivered: true }
      },
      async open(o) {
        ctx.opened.push(o)
        return { tabId: 'new1' }
      },
    },
    cli: {
      register: (name, fn) => {
        ctx.cliHandler = fn
        return () => {}
      },
    },
    async runCli(argv, call = {}) {
      return ctx.cliHandler(argv, { stdin: '', cwd: dataDir, signal: new AbortController().signal, ...call })
    },
    services: {
      use: (name) => {
        const handle = { on: (ev, fn) => ((handle.listeners[ev] = handle.listeners[ev] || []).push(fn), () => {}), listeners: {} }
        ctx.handles[name] = handle
        return new Proxy(handle, {
          get(target, prop) {
            if (prop in target) return target[prop]
            return async (...args) => {
              const impl = services[name]
              if (!impl) throw new Error(`no enabled plugin in this project provides service "${name}"`)
              if (typeof impl[prop] !== 'function') throw new Error(`service "${name}" (plugin cockpit.${name}) has no method "${String(prop)}"`)
              return structuredClone(await impl[prop](...structuredClone(args)))
            }
          },
        })
      },
      available: (name) => Boolean(services[name]),
      // A newer app's pick for a used name (ctx.services.provider).
      provider: (name) => (services[name] ? `cockpit.${name}` : null),
      // What the host provides, called the way another plugin's handle would: arguments and results
      // structured-cloned, `caller()` set to `as` for the call.
      provide(name, impl) {
        ctx.provided[name] = impl
      },
      emit(service, event, data) {
        ctx.emitted.push({ service, event, data })
      },
      caller: () => ctx.callerId,
    },
    provided: {},
    emitted: [],
    callerId: undefined,
    async callService(name, method, args = [], as = 'bronos.gmail') {
      const impl = ctx.provided[name]
      if (!impl) throw new Error(`no enabled plugin in this project provides service "${name}"`)
      if (typeof impl[method] !== 'function') throw new Error(`service "${name}" (plugin bronos.jira) has no method "${method}"`)
      ctx.callerId = as
      try {
        const p = impl[method](...structuredClone(args))
        ctx.callerId = undefined
        return structuredClone(await p)
      } catch (e) {
        ctx.callerId = undefined
        throw new Error(e && e.message ? e.message : String(e))
      }
    },
    handles: {},
    lastState() {
      return [...ctx.posts].reverse().find((m) => m.type === 'state')
    },
  }
  // `opts.buttons`: an app with ctx.overlay.buttons (the inbox redesign); without it, as before.
  if (opts.buttons) ctx.overlay.buttons = (name, provider) => (ctx.buttonProviders.push({ name, provider }), () => {})
  // App 0.28.0 (the overlay foundation): notes, Ask, announcements and parts. `opts.oldApp` (0.27.0) has none.
  if (!opts.oldApp) {
    ctx.notes = () => ({})
    ctx.overlay.onAnnounce = (kind, fn) => (ctx.announceListeners.push({ kind, fn }), () => {})
    ctx.overlay.part = (overlayId, spec) => {
      if (opts.partRefuse) throw new Error(opts.partRefuse)
      return fakeOverlay(ctx, opts, { ...spec, partOf: overlayId }, ctx.parts)
    }
  }
  return ctx
}

/**
 * An overlay as `ctx.overlay.start` (or `part`) gives it to a perView plugin (docs/design-overlay-views.md):
 * copies connect with the app's `from` (`o.connect(from)`, `from.copy` set), `post(m, { copy })` reaches one
 * copy (recorded in `o.posts` as `{ copy, message }`; a copy that is gone is dropped), `o.send(m, from)` is a
 * page's post. The result waits for `o.close()` (Esc). `opts.noPerView`: an app before overlays in every view
 * (no onConnect); `opts.oldApp`: 0.27.0 (no onAsk, no announce); `opts.overlayRefuse`: main refuses it.
 */
function fakeOverlay(ctx, opts, spec, list) {
  const o = { spec, posts: [], listeners: [], connects: [], disconnects: [], copies: new Map(), buttonHandlers: {}, buttons: spec.buttons || [], closed: false, focused: 0 }
  list.push(o)
  let close = null
  const result = opts.overlayRefuse ? Promise.reject(new Error(opts.overlayRefuse)) : new Promise((r) => (close = r))
  result.catch(() => {})
  o.close = (answer) => {
    o.closed = true
    for (const f of [...o.copies.values()]) o.disconnect(f)
    if (close) close(answer || { kind: 'dismissed' })
  }
  o.connect = (from) => {
    o.copies.set(from.copy, from)
    for (const fn of [...o.connects]) fn(structuredClone(from))
  }
  o.disconnect = (from) => {
    o.copies.delete(from.copy)
    for (const fn of [...o.disconnects]) fn(structuredClone(from))
  }
  o.send = (m, from) => o.listeners.forEach((fn) => fn(structuredClone(m), from === undefined ? undefined : structuredClone(from)))
  o.sent = (copy) => o.posts.filter((p) => p.copy === copy).map((p) => p.message)
  o.click = (id, from) => o.buttonHandlers[id](from)
  const handle = {
    result,
    post(message, options) {
      if (JSON.stringify(message).length > 1040384) throw new RangeError('overlay message over 1,040,384 chars of JSON')
      if (o.closed) return
      const copy = options && options.copy
      if (copy !== undefined && !o.copies.has(copy)) return
      o.posts.push({ copy, message: structuredClone(message) })
    },
    onMessage: (fn) => (o.listeners.push(fn), () => o.listeners.splice(o.listeners.indexOf(fn) >>> 0, 1)),
    onButton: (id, fn) => ((o.buttonHandlers[id] = fn), () => {}),
    setButtons: (b) => (o.buttons = structuredClone(b)),
    onDiscuss: (fn) => ((o.discuss = fn), () => {}),
    close() {
      o.close()
    },
    focus() {
      o.focused++
    },
  }
  if (!opts.noPerView) {
    handle.onConnect = (fn) => {
      o.connects.push(fn)
      for (const f of o.copies.values()) fn(structuredClone(f))
      return () => {}
    }
    handle.onDisconnect = (fn) => (o.disconnects.push(fn), () => {})
    handle.hide = () => {}
    handle.addSources = () => {}
  }
  if (!opts.oldApp && !opts.noPerView) {
    handle.onAsk = (fn) => ((o.ask = fn), () => {})
    handle.announce = (a) => (o.announced = a)
  }
  return handle
}

/**
 * What one copy of a kit page holds after the host's posts: `init` (access, tab), the last `state` (chunks
 * joined), `phase` ('loading' | 'failed' | 'ready'), the last `failed`, and the page's own messages in order.
 */
function kitView(o, copy) {
  const v = { init: null, state: undefined, phase: null, failed: null, own: [] }
  let chunks = null
  for (const m of o.sent(copy)) {
    if (m.type === 'cc-kit.init') v.init = m
    else if (m.type === 'cc-kit.loading') v.phase = 'loading'
    else if (m.type === 'cc-kit.failed') (v.phase = 'failed'), (v.failed = m)
    else if (m.type === 'cc-kit.state') (v.phase = 'ready'), (v.state = m.state)
    else if (m.type === 'cc-kit.chunk') {
      if (m.i === 0) chunks = []
      chunks.push(m.text)
      if (chunks.length === m.n) (v.phase = 'ready'), (v.state = JSON.parse(chunks.join('')))
    } else v.own.push(m)
  }
  return v
}

/** Waits until `fn()` is true (the host's work is async: the kit greets after a storage read). */
async function until(fn, ms = 3000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 2))
  }
}

const OWNER = { view: 'desktop', access: 'owner', copy: 'c-owner' }
const WRITER = { view: 'web:3', access: 'write', person: 'Bob', copy: 'c-write' }
const READER = { view: 'web:2', access: 'read', person: 'Ann', copy: 'c-read' }

/** A fake triage service: priority by lane unless a hint decides; records every call. */
function fakeTriage() {
  const t = {
    calls: [],
    overrides: {},
    async classify(source, items) {
      t.calls.push({ source, items })
      const results = {}
      for (const it of items) {
        const o = t.overrides[it.id]
        if (o) results[it.id] = { priority: o.priority, kind: null, confidence: 1, by: 'override' }
        else if (it.hint) results[it.id] = { priority: it.hint.priority, kind: null, confidence: 1, by: 'hint' }
        else results[it.id] = { priority: it.floor || 'fyi', kind: 'request', confidence: 0.4, by: 'jev' }
      }
      return { results, stats: { items: items.length } }
    },
    async override(source, id, v) {
      t.overrides[id] = v
    },
    async clear(source, id) {
      const had = id in t.overrides
      delete t.overrides[id]
      return had
    },
  }
  return t
}

/** Bytes that sniff as a picture of the type (the magic number, then filler up to `size`). */
function picture(type = 'png', size = 64) {
  const head = {
    png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    gif: Buffer.from('GIF89a', 'latin1'),
    webp: Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1')]),
  }[type]
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 7)])
}

module.exports = { fakeJira, fakeCtx, fakeOverlay, kitView, until, fakeTriage, fixture, tmpDir, picture, SITE, GATEWAY, MEDIA, EMAIL, TOKEN, ME, NOW, CONFIGURED, TRANSITIONS, OWNER, WRITER, READER }
