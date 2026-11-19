#!/usr/bin/env node
/**
 * End-to-end: compaction writes memory, and the next step reads it back.
 *
 * This is the test the feature exists for. The claim is not "an observer is
 * registered" — that would pass with an observer that does nothing. The claim is a
 * closed loop through the *real* services:
 *
 * 1. The harness emits `compaction/start` then `compaction/summary` on
 *    `session/event`, exactly as `dsh-compaction-basic` does after it writes a
 *    summary. The listener is mounted through cordis, not called directly.
 * 2. Durable atoms land in `.dsh-memory/memory/atoms.jsonl` with provenance.
 * 3. The next `agent/pre-step` waterfall returns messages containing those atoms,
 *    selected sparsely for the request that step is about.
 * 4. A second compaction that repeats itself adds nothing.
 *
 * Every step goes through the real dispatcher so a wrong event name, a wrong
 * payload shape, or a wrong injection channel fails here rather than in a live
 * session. SKIPs when the harness packages are not linked.
 */

import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const NM = path.join(import.meta.dirname, '..', '_research', 'asar-nm', '@deepseek-ai')
const load = (pkg, file = 'lib/index.js') => import(pathToFileURL(path.join(NM, pkg, file)).href)

let Context
let Service
let ToolRuntime
let SystemPrompt
try {
  ;({ Context, Service } = await load('cordis'))
  ;({ default: ToolRuntime } = await load('dsh-tools'))
  ;({ default: SystemPrompt } = await load('dsh-system-prompt'))
} catch (error) {
  console.log(`SKIP: harness packages unavailable (${error.code ?? error.message}); compaction loop not exercised`)
  process.exit(0)
}

const plugin = await import('../lib/index.js').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') {
    console.log('SKIP: plugin modules unavailable (run `npm run link:harness`)')
    process.exit(0)
  }
  throw error
})
const memory = await import('../core/memory.js')
const compactions = await import('../core/compactions.js')
const { ensureProjectFile } = await import('../core/project.js')
const { writeState } = await import('../core/state.js')

const wait = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))
const root = mkdtempSync(path.join(tmpdir(), 'pm-loop-'))
const atomPath = path.join(root, memory.ATOMS_FILE)
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = path.join(root, 'dsh-home')

try {
  mkdirSync(path.join(root, 'docs', 'knowledge'), { recursive: true })
  writeFileSync(path.join(root, 'docs', 'knowledge', 'combat.md'), '---\ntitle: Combat\nstatus: current\n---\n\n# Combat\n\nDamage uses integers.\n', 'utf8')
  const git = { kind: 'absent', branch: null, head: null, dirty: null, remote: null, toplevel: root, detached: false, reason: null }
  const project = ensureProjectFile({ root, git })
  assert.equal(project.ok, true, 'project file created for the test')
  await writeState({
    root,
    identity: { projectId: project.document.projectId },
    patch: { task: { title: 'keep the damage calculation integer', status: 'in_progress' } },
    by: { source: 'test' },
  })

  const ctx = new Context()
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(ToolRuntime, {})
  await wait()
  const fiber = ctx.plugin(plugin, { projectRoot: root })
  await fiber
  await wait(200)

  // --- The compaction lifecycle, dispatched the way the harness dispatches it. ---
  const session = {
    id: 'session-loop',
    header: { id: 'session-loop', cwd: root },
    surface: { nodes: [] },
    eventAt: () => undefined,
  }
  ctx.emit('session/event', session, { type: 'compaction/start', seq: 10, data: { compactionId: 'c-loop', turn: 4 } })
  ctx.emit('session/event', session, {
    type: 'compaction/summary',
    seq: 11,
    data: {
      compactionId: 'c-loop',
      summary: [{
        type: 'text',
        text: [
          '## Primary Request and Intent',
          '- Keep the combat damage calculation integer-valued in src/domain/damage.js.',
          '',
          '## Critical Context',
          '- Never rewrite AGENTS.md from a tool call.',
          '- Must pass baseRev to state_update or the write conflicts.',
          '- The author prefers draft proposals under docs/proposals before authoritative edits.',
          '',
          '## Errors and Fixes',
          '- Select-String with embedded double quotes throws a ParameterBindingException.',
        ].join('\n'),
      }],
      shadowedTokenCount: 8000,
      shadowedSeqs: [1, 2, 3],
      provider: 'test',
      model: 'test',
    },
  })
  ctx.emit('session/event', session, { type: 'compaction/end', seq: 12, data: { compactionId: 'c-loop' } })
  await wait(250)

  const stored = memory.readAtoms(root)
  assert.equal(stored.ok, true, 'the atom store is readable after compaction')
  assert.ok(stored.live.length >= 3, `compaction wrote atoms through the real event bus (got ${stored.live.length})`)
  assert.ok(
    stored.live.some((atom) => /AGENTS\.md/.test(atom.text)),
    'a constraint from the summary survived into the store',
  )
  assert.ok(
    stored.live.every((atom) => atom.source.compactionId === 'c-loop'),
    'every atom records the compaction it came from',
  )
  assert.match(readFileSync(atomPath, 'utf8'), /c-loop/, 'the provenance is on disk, not only in memory')

  // --- The compaction must also leave an operational record. ---
  // The atom store proves the write happened; the ledger is what proves *which*
  // compactions happened, including any that wrote nothing. Without it a silent
  // compaction is indistinguishable from one that never occurred.
  const ledger = compactions.readLedger(root)
  assert.equal(ledger.ok, true, 'the compaction ledger is readable')
  assert.equal(ledger.entries.length, 1, 'one row per compaction, written through the real event bus')
  const row = ledger.entries[0]
  assert.equal(row.compactionId, 'c-loop', 'the row names the compaction')
  assert.equal(row.turn, 4, 'the turn from compaction/start is carried through')
  assert.ok(row.atomsAdded >= 3, 'the row records how many atoms landed')
  assert.equal(row.skipReason, null, 'a productive compaction has no skip reason')
  assert.equal(typeof row.at, 'string', 'the row is timestamped')
  assert.match(readFileSync(path.join(root, compactions.COMPACTIONS_FILE), 'utf8'), /c-loop/, 'the row is on disk')

  // --- The next step's waterfall must carry the recalled atoms. ---
  // The surface is a real sequence list the dedupe scan reads, so it is modelled
  // honestly: `commit` appends each injected message the way the loop would after a
  // successful send. A stand-in that never recorded anything would make the dedupe
  // path pass vacuously.
  const logged = new Map()
  let nextSeq = 0
  const commit = (injectedMessages) => {
    for (const message of injectedMessages) {
      const seq = nextSeq++
      logged.set(seq, { type: 'user/message', seq, data: message })
      session.surface.nodes.push(seq)
    }
  }
  session.eventAt = (seq) => logged.get(seq)

  const runStep = async (text, turn) => {
    const stepMessages = [{ role: 'user', content: [{ type: 'text', text }] }]
    const stepDecision = await ctx.waterfall('agent/pre-step', {
      agent: { id: 'agent-1', session },
      messages: stepMessages,
      signal: new AbortController().signal,
      turn,
      step: 1,
    }, () => ({ kind: 'enter', messages: stepMessages }))
    assert.equal(stepDecision.kind === 'reject', false, 'the step was not rejected')
    const out = (stepDecision.messages ?? []).slice(stepMessages.length)
    commit(out)
    return out
  }

  const messages = [{ role: 'user', content: [{ type: 'text', text: 'please change the damage calculation in src/domain/damage.js' }] }]
  const decision = await ctx.waterfall('agent/pre-step', {
    agent: { id: 'agent-1', session },
    messages,
    signal: new AbortController().signal,
    turn: 5,
    step: 1,
  }, () => ({ kind: 'enter', messages }))
  assert.equal(decision.kind === 'reject', false, 'the step was not rejected')

  const injected = (decision.messages ?? []).slice(messages.length)
  assert.ok(injected.length > 0, 'the step received at least one injected message')

  const recallMessage = injected.find((message) => String(message.source?.kind ?? '').endsWith(':recall'))
  assert.ok(recallMessage !== undefined, 'a dedicated recall message was injected, distinguishable from the baseline')
  const recallText = (recallMessage.content ?? []).map((block) => block.text ?? '').join('\n')
  assert.match(recallText, /Recalled project memory/, 'the recall block identifies itself')
  assert.match(recallText, /AGENTS\.md/, 'the atom about AGENTS.md reached the model')
  assert.ok(recallMessage.source.atoms >= 1, 'the message records how many atoms it carries')
  assert.equal(recallMessage.source.route, 'deterministic', 'with no router configured the deterministic route is used')
  assert.equal(typeof recallMessage.source.tokens, 'number', 'the message records its token cost')
  assert.equal(typeof recallMessage.source.recallIdentity, 'string', 'the message carries a dedupe identity')
  assert.ok(
    (recallMessage.source.atoms ?? 99) <= 8,
    'recall is sparse: it does not paste the whole store into the context',
  )

  // The baseline message is still separate and still present.
  const baseline = injected.find((message) => message.source?.kind === 'project-memory')
  assert.ok(baseline !== undefined, 'the durable baseline is still injected alongside recall')
  assert.ok(
    injected.indexOf(baseline) < injected.indexOf(recallMessage),
    'the baseline precedes the recall block',
  )

  // --- The same atoms must not be re-injected on the next step. ---
  // This is the regression test for a real defect: recall ran every step and pasted
  // the same block again, spending the very budget the system exists to protect.
  commit(injected)
  const repeat = await runStep('please change the damage calculation in src/domain/damage.js', 6)
  assert.equal(
    repeat.some((message) => String(message.source?.kind ?? '').endsWith(':recall')),
    false,
    'an unchanged recall is not injected twice into the same session',
  )

  // A different *wording* that selects the same atoms is also a repeat: the atoms are
  // already visible, so re-sending them would buy nothing. Dedupe keys on the atom
  // set for exactly this reason, not on the request text.
  const reworded = await runStep('Please change the damage calculation in src/domain/damage.js.', 7)
  assert.equal(
    reworded.some((message) => String(message.source?.kind ?? '').endsWith(':recall')),
    false,
    'rewording a request that selects the same atoms does not re-inject them',
  )

  // But a genuinely new selection must still reach the model. Adding an atom that the
  // next request matches changes the set, and that is the case dedupe must not block.
  await memory.recordAtoms({
    root,
    atoms: [{
      text: 'The audit export writes UTF-8 JSONL with one record per line.',
      kind: 'fact',
      weight: 4,
      tags: ['audit-export'],
      source: { sessionId: 'session-loop', compactionId: null, seq: null },
    }],
  })
  const withNew = await runStep('how does the audit export write its jsonl?', 8)
  const fresh = withNew.find((message) => String(message.source?.kind ?? '').endsWith(':recall'))
  assert.ok(fresh !== undefined, 'a request whose selection changed still receives a recall block')
  assert.notEqual(fresh.source.recallIdentity, recallMessage.source.recallIdentity, 'the new block has its own identity')
  assert.match(
    (fresh.content ?? []).map((block) => block.text ?? '').join('\n'),
    /audit export/i,
    'the newly added atom is the reason the selection changed',
  )

  // --- A repeated compaction must not duplicate anything. ---
  const before = memory.readAtoms(root).atoms.length
  ctx.emit('session/event', session, {
    type: 'compaction/summary',
    seq: 20,
    data: {
      compactionId: 'c-loop',
      summary: [{ type: 'text', text: '## Critical Context\n- Never rewrite AGENTS.md from a tool call.\n' }],
    },
  })
  await wait(250)
  assert.equal(memory.readAtoms(root).atoms.length, before, 'replaying the same compaction adds no record')

  // A *different* compaction that repeats the same statement reinforces it rather
  // than storing a second copy: content identity is what makes that work.
  ctx.emit('session/event', session, {
    type: 'compaction/summary',
    seq: 21,
    data: {
      compactionId: 'c-loop-2',
      summary: [{ type: 'text', text: '## Critical Context\n- Never rewrite AGENTS.md from a tool call.\n' }],
    },
  })
  await wait(250)
  const afterSecond = memory.readAtoms(root)
  assert.equal(afterSecond.atoms.length, before, 'a repeat from a later compaction is merged, not appended')
  const reinforced = afterSecond.live.find((atom) => /AGENTS\.md/.test(atom.text))
  assert.ok(reinforced.seen >= 2, 'the repeated statement is reinforced')

  // --- Forgetting is honoured by the next step's recall. ---
  const forgot = await memory.forgetAtoms({ root, ids: [reinforced.id] })
  assert.equal(forgot.ok, true, 'forget succeeds')
  const nextDecision = await ctx.waterfall('agent/pre-step', {
    agent: { id: 'agent-2', session },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'change the damage calculation in src/domain/damage.js' }] }],
    signal: new AbortController().signal,
    turn: 6,
    step: 1,
  }, () => ({ kind: 'enter', messages: [] }))
  const nextRecall = (nextDecision.messages ?? []).find((message) => String(message.source?.kind ?? '').endsWith(':recall'))
  if (nextRecall !== undefined) {
    const text = (nextRecall.content ?? []).map((block) => block.text ?? '').join('\n')
    assert.equal(text.includes('Never rewrite AGENTS.md'), false, 'a forgotten atom is not recalled into the next step')
  }

  // --- A router tier of "off" spends nothing. ---
  await fiber.dispose()
  await wait()
  const offCtx = new Context()
  offCtx.plugin(SystemPrompt, {})
  offCtx.plugin(ToolRuntime, {})
  await wait()
  const offFiber = offCtx.plugin(plugin, { projectRoot: root, routerTier: 'off' })
  await offFiber
  await wait(200)
  const offDecision = await offCtx.waterfall('agent/pre-step', {
    agent: { id: 'agent-3', session },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'anything at all' }] }],
    signal: new AbortController().signal,
    turn: 1,
    step: 1,
  }, () => ({ kind: 'enter', messages: [] }))
  const offRecall = (offDecision.messages ?? []).find((message) => String(message.source?.kind ?? '').endsWith(':recall'))
  assert.ok(offRecall === undefined || offRecall.source.route !== 'subagent', 'routerTier "off" never routes to a subagent')
  await offFiber.dispose()

  // A profile without DSH router credentials can still review automatic recall.
  const localAtom = memory.normalizeAtom({ kind: 'fact', text: 'Combat damage uses the integer calculation.', weight: 5 })
  const existing = readFileSync(atomPath, 'utf8')
  writeFileSync(atomPath, `${existing.trimEnd()}\n${JSON.stringify(localAtom)}\n`)
  const prompts = []
  const completions = []
  const discovered = []
  const routes = new Map()
  const server = createServer(async (req, res) => {
    const route = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
    if (route) return route(req, res)
    if (req.url.startsWith('/project-memory/')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ missing: req.url, registered: [...routes.keys()] }))
    }
    if (req.url.endsWith('/models')) {
      discovered.push({ path: req.url, auth: req.headers.authorization })
      return res.end(JSON.stringify({ data: [{ id: 'from-panel' }] }))
    }
    let body = ''
    for await (const chunk of req) body += chunk
    const payload = JSON.parse(body)
    prompts.push(payload.messages[0].content)
    completions.push({ model: payload.model, auth: req.headers.authorization })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: 'accept', hot_memory_ids: [localAtom.id] }) } }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const localCtx = new Context()
    localCtx.plugin(SystemPrompt, {})
    localCtx.plugin(ToolRuntime, {})
    await wait()
    const localFiber = localCtx.plugin(plugin, {
      projectRoot: root, routerTier: 'always', localRouterModel: 'fixture',
      localRouterEndpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    })
    await localFiber
    try {
      const stepMessages = [{ role: 'user', content: [{ type: 'text', text: 'change the integer combat damage calculation' }] }]
      const agent = { id: 'agent-local', session }
      const step = (number) => localCtx.waterfall('agent/pre-step', {
        agent, messages: stepMessages, turn: 1, step: number,
        signal: new AbortController().signal,
      }, () => ({ kind: 'enter', messages: stepMessages }))
      const first = await step(1)
      const proposal = first.messages.find((message) => message.source?.kind === 'project-memory:proposal')
      assert.ok(proposal?.source.proposalId, 'the real pre-step hook emits a review request')
      assert.ok(!first.messages.some((message) => message.content.some((block) => block.text?.includes(localAtom.text))),
        'the execution model receives no proposed text before approval')

      const invoke = (arguments_, callId) => localCtx.tools.execute({
        name: 'memory_intent', arguments: arguments_, callId, agent,
        signal: new AbortController().signal,
      })
      const approval = await invoke({ proposal_id: proposal.source.proposalId, accept_memory_ids: [localAtom.id] }, 'approve')
      const visible = approval.content.map((block) => block.text ?? '').join('\n')
      assert.equal(Boolean(approval.isError), false, visible)
      assert.match(visible, /Combat damage uses the integer calculation/)

      const repeated = await step(2)
      assert.ok(!repeated.messages.some((message) => message.source?.kind === 'project-memory:proposal'))
      assert.equal(prompts.length, 1, 'the next step does not repeat the checked request')
      assert.ok(prompts[0].includes(localAtom.id))
    } finally {
      await localFiber.dispose()
    }

    const origin = `http://127.0.0.1:${server.address().port}`
    const baseUrl = origin + '/v1'
    const fixtureKey = 'fixture-router-key'
    const { ROUTER_MODELS_PATH, ROUTER_CONNECTION_PATH } = await import('../lib/panel.js')
    const post = async (route, payload, caller = origin) => {
      const res = await fetch(origin + route, {
        method: 'POST', headers: { origin: caller, 'content-type': 'application/json' }, body: JSON.stringify(payload),
      })
      const text = await res.text()
      assert.ok(!text.includes(fixtureKey), 'the panel never echoes the key')
      return { status: res.status, body: JSON.parse(text) }
    }
    const records = new Map()
    let config = { projectRoot: root, routerTier: 'always' }
    class Web extends Service {
      constructor(ctx) { super(ctx, 'webServer') }
      register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path) }
    }
    class Editor extends Service {
      constructor(ctx) { super(ctx, 'configEditor') }
      entries() { return [{ options: { id: 'project-memory', config } }] }
      async edit(_entry, change) { config = change(config) }
    }
    class Credentials extends Service {
      constructor(ctx) { super(ctx, 'credentials') }
      async readRecord(id) { return records.get(id) }
      async modifyRecord(id, change) { records.set(id, await change(records.get(id))) }
      async deleteRecord(id) { records.delete(id) }
    }
    const connectionCtx = new Context()
    for (const service of [Web, Editor, SystemPrompt, ToolRuntime]) await connectionCtx.plugin(service, {})
    let connectionFiber = await connectionCtx.plugin(plugin, config)
    try {
      await wait()
      const anonymous = await post(ROUTER_CONNECTION_PATH, { baseUrl, model: 'from-panel' })
      assert.equal(anonymous.status, 200, `credentials are optional in a mounted Host: ${JSON.stringify(anonymous.body)}`)
      assert.equal(anonymous.body.connection.credentialsAvailable, false)
      assert.deepEqual(await post(ROUTER_MODELS_PATH, { baseUrl }), { status: 200, body: { models: ['from-panel'] } })
      assert.equal((await post(ROUTER_MODELS_PATH, { baseUrl }, 'https://unrelated.example')).status, 403)
      await connectionCtx.plugin(Credentials, {})
      await wait()
      const options = await post(ROUTER_MODELS_PATH, { baseUrl, apiKey: fixtureKey })
      assert.deepEqual(options.body.models, ['from-panel'])
      const saved = await post(ROUTER_CONNECTION_PATH, { baseUrl, model: options.body.models[0], apiKey: fixtureKey })
      assert.deepEqual(saved.body.connection, { baseUrl, model: 'from-panel', hasKey: true, credentialsAvailable: true })
      assert.ok(!JSON.stringify(config).includes(fixtureKey), 'the key is stored separately from config')
      await post(ROUTER_MODELS_PATH, { baseUrl: origin + '/other' })
      assert.deepEqual(discovered.at(-1), { path: '/other/models', auth: undefined })
      await connectionFiber.dispose()
      connectionFiber = await connectionCtx.plugin(plugin, config)
      const stepMessages = [{ role: 'user', content: [{ type: 'text', text: 'change the integer combat damage calculation' }] }]
      const routed = await connectionCtx.waterfall('agent/pre-step', {
        agent: { id: 'agent-from-panel', session }, messages: stepMessages, turn: 1, step: 1,
      }, () => ({ kind: 'enter', messages: stepMessages }))
      assert.ok(routed.messages.some((message) => message.source?.kind === 'project-memory:proposal'))
      assert.deepEqual(completions.at(-1), { model: 'from-panel', auth: `Bearer ${fixtureKey}` })
      const restored = await post(ROUTER_CONNECTION_PATH, { baseUrl: '', model: '' })
      assert.equal(restored.body.connection.baseUrl, '')
      assert.equal(config.localRouterModel, '')
    } finally {
      await connectionFiber.dispose()
    }
  } finally {
    server.close()
    server.closeAllConnections()
  }

  console.log('LOOP OK: compaction, recall, dedupe, forget, and panel-selected routing through real Cordis')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(root, { recursive: true, force: true })
}
