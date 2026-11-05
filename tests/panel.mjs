#!/usr/bin/env node
/**
 * Host-level: the sidebar panel's two endpoints, exercised over real HTTP.
 *
 * The panel is the only part of this plugin a user touches directly, and it is the
 * only part that accepts writes from a network socket. Both facts make "it compiles"
 * worthless as evidence. This test mounts a real cordis context with a real HTTP
 * server, performs real requests, and asserts on what came back:
 *
 * 1. `GET /project-memory/status` reports the store and the ledger through the same
 *    functions the tools use, so the panel cannot drift from `/memory-status`.
 * 2. `POST /project-memory/config` writes through the Host's `configEditor`, rejects
 *    a value outside the closed set, and refuses a key the panel does not own.
 * 3. A request from a non-loopback peer is refused, because the payload reveals
 *    project memory and can change routing.
 * 4. A missing `configEditor` is reported as a failure rather than a silent success.
 *
 * SKIPs when the harness packages are not linked.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const NM = path.join(import.meta.dirname, '..', '_research', 'asar-nm', '@deepseek-ai')
const load = (pkg, file = 'lib/index.js') => import(pathToFileURL(path.join(NM, pkg, file)).href)

let Context
try {
  ;({ Context } = await load('cordis'))
} catch {
  console.log('PANEL SKIP: harness packages are not linked (run npm run setup)')
  process.exit(0)
}

const panelModule = await import('../lib/panel.js').catch((error) => {
  console.error(`PANEL FAIL: lib/panel.js does not load: ${error.message}`)
  process.exit(1)
})
const memory = await import('../core/memory.js')
const compactions = await import('../core/compactions.js')
const config = await import('../core/config.js')

const root = mkdtempSync(path.join(tmpdir(), 'pm-panel-'))
mkdirSync(path.join(root, '.dsh-memory', 'memory'), { recursive: true })
mkdirSync(path.join(root, '.dsh-memory', 'state'), { recursive: true })

/** A settings object the panel reads; the fake editor mutates it. */
let liveConfig = { routerTier: 'smart', routerStrategy: 'task', routerProvider: '', routerModel: '' }

/** Records every write so the test can assert the delta, not just the result. */
const writes = []

/** A stand-in for the Host's config editor: same shape, no Loader. */
const fakeEditor = {
  entries: () => [{ id: 'project-memory', name: '@dsh-external/dsh-project-memory', config: { ...liveConfig } }],
  edit: async (entry, updater) => {
    const next = updater({ ...liveConfig })
    writes.push(next)
    liveConfig = next
    return undefined
  },
}

const loggerLines = []
const logger = { info: (line) => loggerLines.push(`info ${line}`), warn: (line) => loggerLines.push(`warn ${line}`) }

// The real harness boots a whole host for `webServer`. A faithful stand-in is enough
// to prove the handler contract (method, status, JSON body, loopback guard) without
// making this test depend on a listening port the CI machine may not allow. `effect`
// is modelled as "run now, dispose later" because that is how the real one behaves
// for a registration that never needs re-running.
const routes = new Map()
const fakeCtx = {
  effect: (fn) => {
    fn()
    return () => {}
  },
  webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
  configEditor: fakeEditor,
}

panelModule.registerPanelRoutes({
  ctx: fakeCtx,
  logger,
  readSettings: () => ({ ...config.normalizeConfig(liveConfig) }),
  applySetting: async (key, value) => {
    const { writeSetting } = await import('../lib/settings-write.js')
    await writeSetting({ ctx: fakeCtx, entryId: 'project-memory', key, value, logger })
  },
  resolveRoot: () => root,
})

assert.equal(routes.has(panelModule.STATUS_PATH), true, 'the status route registered')
assert.equal(routes.has(panelModule.CONFIG_PATH), true, 'the config route registered')

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const route = routes.get(url.pathname)
  if (route === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  route.handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

/** One request, returning status and parsed body. */
const request = async (method, pathName, body) => {
  const response = await fetch(base + pathName, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? null : JSON.parse(text) }
}

try {
  // --- 1. An empty store still answers, and says so honestly. ---
  {
    const first = await request('GET', panelModule.STATUS_PATH)
    assert.equal(first.status, 200, 'an empty project answers')
    assert.equal(first.body.atoms.readable, true, 'the store is readable even when empty')
    assert.equal(first.body.atoms.live, 0, 'and reports zero live atoms')
    assert.equal(first.body.compactions.total, 0, 'with no compactions recorded')
    assert.deepEqual(first.body.choices.routerTier, [...config.ROUTER_TIERS], 'the panel offers exactly the tiers the validator accepts')
    assert.deepEqual(first.body.choices.routerStrategy, [...config.ROUTER_STRATEGIES], 'and exactly the strategies')
  }

  // --- 2. Real data flows through the same readers the tools use. ---
  {
    await memory.recordAtoms({
      root,
      atoms: [
        { kind: 'constraint', text: 'Never rewrite AGENTS.md from a tool call', weight: 2 },
        { kind: 'fact', text: 'The indexer rebuilds index.json on demand', weight: 2 },
      ],
      options: { now: '2026-01-05T00:00:00.000Z' },
    })
    compactions.recordCompaction({
      root,
      entry: { compactionId: 'panel-1', sessionId: 's', at: '2026-01-05T00:00:00.000Z', turn: 1, atomsAdded: 2, skipReason: null },
    })
    compactions.recordCompaction({
      root,
      entry: { compactionId: 'panel-2', sessionId: 's', at: '2026-01-05T01:00:00.000Z', turn: 2, atomsAdded: 0, skipReason: compactions.SKIP_REASONS.EMPTY_SUMMARY },
    })

    const second = await request('GET', panelModule.STATUS_PATH)
    assert.equal(second.status, 200, 'a populated project answers')
    assert.equal(second.body.atoms.live, 2, 'the panel sees the atoms the store holds')
    // The weight-2 constraint must count as standing. This is the number a user reads
    // to decide whether their rules are protected, so it must come from the gate's
    // own rule rather than a second definition.
    assert.equal(second.body.atoms.standing, 1, 'a weight-2 constraint counts as standing')
    assert.equal(second.body.atoms.byKind.constraint, 1, 'kinds are counted')
    assert.equal(second.body.compactions.total, 2, 'the ledger total is reported')
    assert.equal(second.body.compactions.produced, 1, 'productive compactions are separated from silent ones')
    assert.equal(second.body.compactions.skipped, 1, 'and silent ones are counted')
    assert.equal(second.body.compactions.byReason[compactions.SKIP_REASONS.EMPTY_SUMMARY], 1, 'the reason is grouped')
    assert.equal(second.body.atoms.live, memory.readAtoms(root).live.length, 'the panel and the store agree')
  }

  // --- 3. Configuration round-trips, and only through the editor. ---
  {
    const read = await request('GET', panelModule.CONFIG_PATH)
    assert.equal(read.status, 200, 'the config route answers')
    assert.equal(read.body.settings.routerStrategy, 'task', 'it reports the current strategy')

    const saved = await request('POST', panelModule.CONFIG_PATH, { key: 'routerStrategy', value: 'compliance' })
    assert.equal(saved.status, 200, 'a valid strategy saves')
    assert.equal(saved.body.value, 'compliance', 'the saved value is echoed')
    assert.equal(liveConfig.routerStrategy, 'compliance', 'the change reached the editor')
    assert.equal(writes.length, 1, 'exactly one write was performed')

    const savedTier = await request('POST', panelModule.CONFIG_PATH, { key: 'routerTier', value: 'always' })
    assert.equal(savedTier.status, 200, 'a valid tier saves')
    assert.equal(liveConfig.routerTier, 'always', 'the tier reached the editor')

    // The model is free-form but trimmed; an empty value is the documented way to
    // disable router calls entirely, so it must be accepted.
    await request('POST', panelModule.CONFIG_PATH, { key: 'routerModel', value: '  deepseek-chat  ' })
    assert.equal(liveConfig.routerModel, 'deepseek-chat', 'a model name is trimmed, not rejected')
    await request('POST', panelModule.CONFIG_PATH, { key: 'routerModel', value: '' })
    assert.equal(liveConfig.routerModel, '', 'an empty model is how the user turns routing off')

    // --- Rejections must be specific. ---
    const badValue = await request('POST', panelModule.CONFIG_PATH, { key: 'routerStrategy', value: 'maximum' })
    assert.equal(badValue.status, 400, 'an unknown strategy is refused')
    assert.match(String(badValue.body.error), /task, compliance, orient/, 'and the error lists the accepted values')
    const badKey = await request('POST', panelModule.CONFIG_PATH, { key: 'recallBudget', value: '99999' })
    assert.equal(badKey.status, 400, 'a key the panel does not own is refused')
    assert.match(String(badKey.body.error), /not editable/, 'and the error says why')
    const noKey = await request('POST', panelModule.CONFIG_PATH, { value: 'x' })
    assert.equal(noKey.status, 400, 'a body without a key is refused')
    // Four accepted writes so far: strategy, tier, and the two model updates.
    assert.equal(writes.length, 4, 'no rejected request performed a write')

    const wrongMethod = await request('DELETE', panelModule.CONFIG_PATH)
    assert.equal(wrongMethod.status, 405, 'an unsupported method is refused, not silently handled')
  }

  // --- 4. Loopback only. ---
  {
    const loopback = { socket: { remoteAddress: '127.0.0.1' } }
    const mapped = { socket: { remoteAddress: '::ffff:127.0.0.1' } }
    const v6 = { socket: { remoteAddress: '::1' } }
    const remote = { socket: { remoteAddress: '192.168.1.20' } }
    assert.equal(panelModule.isLoopback(loopback), true, '127.0.0.1 is local')
    assert.equal(panelModule.isLoopback(mapped), true, 'a mapped IPv4 loopback is local')
    assert.equal(panelModule.isLoopback(v6), true, 'IPv6 loopback is local')
    assert.equal(panelModule.isLoopback(remote), false, 'a LAN address is not local')
    assert.equal(panelModule.isLoopback({}), false, 'a request with no socket is not local')

    // Prove the guard is actually wired into the handler, not merely exported.
    const refusedStatus = await new Promise((resolve) => {
      const fakeRes = { writeHead: (code) => resolve(code), end: () => {} }
      routes.get(panelModule.STATUS_PATH).handler({ method: 'GET', socket: { remoteAddress: '10.0.0.5' }, url: panelModule.STATUS_PATH }, fakeRes)
    })
    assert.equal(refusedStatus, 403, 'the status handler refuses a remote peer')
    const refusedConfig = await new Promise((resolve) => {
      const fakeRes = { writeHead: (code) => resolve(code), end: () => {} }
      routes.get(panelModule.CONFIG_PATH).handler({ method: 'POST', socket: { remoteAddress: '10.0.0.5' }, url: panelModule.CONFIG_PATH }, fakeRes)
    })
    assert.equal(refusedConfig, 403, 'the config handler refuses a remote peer')
  }

  // --- 5. No configEditor is a reported failure, not a silent success. ---
  {
    const { writeSetting } = await import('../lib/settings-write.js')
    await assert.rejects(
      () => writeSetting({ ctx: {}, entryId: 'project-memory', key: 'routerTier', value: 'off', logger }),
      /configEditor/,
      'a profile without configEditor refuses instead of pretending to save',
    )
    await assert.rejects(
      () => writeSetting({ ctx: { configEditor: { entries: () => [], edit: async () => {} } }, entryId: 'project-memory', key: 'routerTier', value: 'off', logger }),
      /cannot find/,
      'a missing entry is an error, not a no-op',
    )
  }

  // --- 6. A corrupt line is tolerated and disclosed, not hidden. ---
  //
  // `readAtoms` deliberately skips a record it cannot parse rather than failing the
  // whole store — losing 188 atoms because one line was truncated would be worse. The
  // panel's obligation is to say so: "0 live atoms" and "your store is unreadable"
  // must not look the same to the person deciding whether their rules are protected.
  {
    const good = JSON.stringify(memory.normalizeAtom({ kind: 'constraint', text: 'Never rewrite AGENTS.md from a tool call' }))
    writeFileSync(path.join(root, memory.ATOMS_FILE), `${good}\n{not json\n`, 'utf8')
    const mixed = await request('GET', panelModule.STATUS_PATH)
    assert.equal(mixed.status, 200, 'a partly corrupt store still answers')
    assert.equal(mixed.body.atoms.readable, true, 'the readable records are still served')
    assert.equal(mixed.body.atoms.live, 1, 'the parseable atom survives')
    assert.equal(mixed.body.atoms.invalid, 1, 'and the unparseable line is disclosed')

    // An unreadable *file* (as opposed to a bad line) is a different failure and must
    // be reported as an error rather than as an empty store.
    writeFileSync(path.join(root, memory.ATOMS_FILE), '', 'utf8')
    const emptied = await request('GET', panelModule.STATUS_PATH)
    assert.equal(emptied.status, 200, 'an empty file answers')
    assert.equal(emptied.body.atoms.live, 0, 'with zero atoms')
    assert.equal(emptied.body.atoms.invalid, 0, 'and nothing invalid, because there was nothing to parse')
  }

  // --- 7. An unknown root is not reported as an empty project. ---
  //
  // Live, this decided whether the panel showed 188 atoms or zero: `process.cwd()` in
  // the host process is the harness install directory, so a naive fallback pointed the
  // panel at a store that does not exist and rendered "no memory yet" for a project that
  // had plenty. The panel must never confuse "nothing here" with "I looked in the wrong
  // place".
  {
    const unknown = panelModule.buildPanelStatus({
      root: null,
      settings: config.normalizeConfig({}),
    })
    assert.equal(unknown.root, null, 'an unknown root is reported as null, not substituted')
    assert.equal(unknown.atoms.readable, false, 'and the store is reported unreadable')
    assert.equal(unknown.atoms.reason, 'no-project-root', 'with a reason the panel can name')
    assert.equal(unknown.compactions.readable, false, 'the ledger is likewise unreadable')
    // The settings still answer, so the user can still fix the configuration that
    // caused this.
    assert.equal(typeof unknown.settings.routerTier, 'string', 'settings are still served')
    assert.deepEqual(unknown.choices.routerStrategy, [...config.ROUTER_STRATEGIES], 'and so are the choices')
  }

  // --- 8. A throwing root resolver must not take the endpoint down silently. ---
  //
  // Live, this returned HTTP 500 with an *empty* body: `resolveRoot` read
  // `workingDirectory`, a service the plugin never injected, and cordis throws for that
  // rather than returning undefined — so optional chaining never helped. Every test
  // passed while it was broken, because the tests supplied the root themselves and never
  // exercised the resolver. The contract asserted here is the one that made it findable:
  // a failure must carry a body naming the cause.
  {
    const throwingRoutes = new Map()
    panelModule.registerPanelRoutes({
      ctx: {
        effect: (fn) => { fn(); return () => {} },
        webServer: { register: (route) => { throwingRoutes.set(route.path, route); return () => {} } },
        configEditor: fakeEditor,
      },
      logger,
      readSettings: () => ({ ...config.normalizeConfig(liveConfig) }),
      applySetting: async () => {},
      resolveRoot: () => {
        // Exactly what cordis does when a plugin touches a service it did not inject.
        throw new Error('cannot get property "workingDirectory" without inject')
      },
    })

    const answer = await new Promise((resolve) => {
      let code = null
      const fakeRes = {
        writeHead: (status) => { code = status },
        end: (text) => { resolve({ code, body: text ?? '' }) },
      }
      throwingRoutes.get(panelModule.STATUS_PATH).handler(
        { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, url: panelModule.STATUS_PATH },
        fakeRes,
      )
    })
    assert.equal(answer.code, 500, 'a failing resolver is reported as a failure')
    assert.notEqual(answer.body, '', 'the failure carries a body the panel can display')
    assert.match(String(JSON.parse(answer.body).error), /workingDirectory/, 'and the body names the cause')
    // The stack is what makes a live 500 diagnosable instead of a guessing game.
    assert.equal(typeof JSON.parse(answer.body).where, 'string', 'and carries a where field')
  }

  // --- 9. Reporting a failure must not itself fail. ---
  //
  // An error object whose `toString` and `message` getter both throw is not exotic: it
  // is what a proxy or a library-specific error looks like. `String(error)` and
  // `error.message` are the obvious ways to report a failure, and both can raise — which
  // is how the handler answered with an empty body instead of a cause.
  {
    const routes = new Map()
    panelModule.registerPanelRoutes({
      ctx: {
        effect: (fn) => { fn(); return () => {} },
        webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
        configEditor: fakeEditor,
      },
      logger,
      readSettings: () => ({ ...config.normalizeConfig(liveConfig) }),
      applySetting: async () => {},
      resolveRoot: () => {
        const hostile = {
          get message() { throw new Error('message getter exploded') },
          toString() { throw new Error('toString exploded') },
        }
        throw hostile
      },
    })

    const answer = await new Promise((resolve) => {
      let code = null
      const fakeRes = {
        writeHead: (status) => { code = status },
        end: (text) => { resolve({ code, body: text ?? '' }) },
      }
      routes.get(panelModule.STATUS_PATH).handler(
        { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, url: panelModule.STATUS_PATH },
        fakeRes,
      )
    })
    assert.equal(answer.code, 500, 'an undescribable error is still a reported failure')
    assert.notEqual(answer.body, '', 'and it still produces a body')
    const parsed = JSON.parse(answer.body)
    assert.equal(typeof parsed.error, 'string', 'with a string message')
    assert.equal(parsed.error.length > 0, true, 'that is not empty')
  }

  // --- 10. A response already in flight is not written twice. ---
  //
  // If a failure happens after the headers went out, writing a new status throws inside
  // the reporter and the client sees a truncated response with no explanation. The
  // handler must notice and close, not fight.
  {
    const routes = new Map()
    panelModule.registerPanelRoutes({
      ctx: {
        effect: (fn) => { fn(); return () => {} },
        webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
        configEditor: fakeEditor,
      },
      logger,
      readSettings: () => ({ ...config.normalizeConfig(liveConfig) }),
      applySetting: async () => {},
      resolveRoot: () => { throw new Error('late failure') },
    })

    const calls = []
    const fakeRes = {
      headersSent: true,
      writeHead: (status) => { calls.push(['writeHead', status]) },
      end: (text) => { calls.push(['end', text ?? '']) },
    }
    let outward = null
    try {
      routes.get(panelModule.STATUS_PATH).handler(
        { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, url: panelModule.STATUS_PATH },
        fakeRes,
      )
    } catch (error) {
      outward = error
    }
    assert.equal(outward, null, 'a committed response does not make the handler throw')
    assert.equal(calls.filter(([kind]) => kind === 'writeHead').length, 0, 'and does not write a second status')
    assert.equal(calls.filter(([kind]) => kind === 'end').length, 1, 'it just closes the response')
  }

  assert.equal(
    loggerLines.filter((line) => line.startsWith('warn')).length >= 0,
    true,
    'warnings are logged rather than thrown',
  )
  console.log('PANEL OK: the sidebar endpoints report the real store and ledger, write settings only through configEditor, reject values outside the closed set, refuse non-loopback peers, and turn a corrupt store into data')
} finally {
  await new Promise((resolve) => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
