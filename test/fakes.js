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
 */
function fakeJira(opts = {}) {
  const calls = []
  const expected = 'Basic ' + Buffer.from(`${EMAIL}:${opts.token || TOKEN}`).toString('base64')
  const cloudId = fixture('tenant_info.json').cloudId
  async function fetch(url, init = {}) {
    const headers = init.headers || {}
    calls.push({ url, auth: headers.Authorization, redirect: init.redirect })
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
      if (opts.scoped || headers.Authorization !== expected) return json(fixture('error-401.json'), 401)
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
  return { fetch, calls }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jira-test-'))
}

const CONFIGURED = { site: SITE, email: EMAIL, apiToken: TOKEN }

/**
 * A ctx good enough for dist/host.js: in-memory storage, recorded posts, badges, sessions, exec,
 * overlays; services `triage` and `reviewer` from `opts`.
 */
function fakeCtx(opts = {}) {
  const store = new Map()
  const panelListeners = []
  const settingsListeners = []
  const dataDir = opts.dataDir || tmpDir()
  const services = { triage: opts.triage || null, reviewer: opts.reviewer || null }
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
    async sendPanel(m) {
      for (const fn of panelListeners) await fn(m)
    },
    overlay: {
      start(spec) {
        const o = { spec, posts: [], listeners: [], answer: opts.overlayAnswer || { kind: 'dismissed' } }
        ctx.overlays.push(o)
        // `opts.overlayWait`: the result waits for the test (o.close(answer)), so it can talk to the page first.
        let close
        const result = opts.overlayWait ? new Promise((r) => (close = r)) : Promise.resolve(o.answer)
        o.close = (answer) => close && close(answer || { kind: 'dismissed' })
        o.send = (m) => o.listeners.forEach((fn) => fn(structuredClone(m)))
        return {
          result,
          post: (m) => {
            if (JSON.stringify(m).length > 1040384) throw new Error('overlay message over 1,040,384 chars of JSON')
            o.posts.push(structuredClone(m))
          },
          onMessage: (fn) => (o.listeners.push(fn), () => {}),
          onDiscuss: (fn) => ((o.discuss = fn), () => {}),
          close() {
            o.closed = true
          },
          focus() {},
        }
      },
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
    async runCli(argv) {
      return ctx.cliHandler(argv, { stdin: '', cwd: dataDir, signal: new AbortController().signal })
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
  return ctx
}

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

module.exports = { fakeJira, fakeCtx, fakeTriage, fixture, tmpDir, picture, SITE, GATEWAY, MEDIA, EMAIL, TOKEN, ME, NOW, CONFIGURED }
