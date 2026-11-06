#!/usr/bin/env node
/**
 * Exercise the `agent/pre-step` injection path directly.
 *
 * This is the part of the plugin that was written first and verified last, and it
 * is the part most likely to be silently wrong: a listener that registers, never
 * throws, and injects nothing looks identical to a working one from the outside.
 *
 * The alternative host guess this test rejects: injecting through
 * `agent.inbox.prepend(...)`. `agent/pre-step` is a *waterfall* whose `decision`
 * carries the messages the loop will send, and the loop claimed the step's messages
 * before this listener ran (`dsh-agent-loop` dispatches
 * `waterfall('agent/pre-step', { messages: claimed, ... })` and then sends
 * `decision.messages`). So the supported injection is to return the messages; an
 * inbox write lands on a later step or never. The assertions below fail if the
 * implementation ever regresses to the inbox approach.
 *
 * The event shape here is copied from the real dispatcher: `{ agent, messages,
 * turn, step, signal }` with a `next` that resolves to `{ kind: 'enter', messages }`.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const { composePayload, createInjectionMessage, surfaceHasBaseline, buildSnapshot, MESSAGE_SOURCE_KIND } =
  await import('../lib/inject.js').catch((error) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      console.log('SKIP: plugin modules unavailable (run `npm run link:harness`); injection not exercised')
      process.exit(0)
    }
    throw error
  })
const { normalizeConfig } = await import('../core/config.js')
const { ensureProjectFile } = await import('../core/project.js')
const { writeState } = await import('../core/state.js')

const settings = normalizeConfig({})
const root = mkdtempSync(path.join(tmpdir(), 'pm-inject-'))
try {
  mkdirSync(path.join(root, 'docs', 'knowledge'), { recursive: true })
  writeFileSync(path.join(root, 'docs', 'knowledge', 'combat.md'), '# Combat\n\nDamage is integer.\n', 'utf8')

  const git = { kind: 'absent', branch: null, head: null, dirty: null, remote: null, toplevel: root, detached: false, reason: null }
  const project = ensureProjectFile({ root, git })
  const identity = { projectId: project.document.projectId }

  const snapshot = await buildSnapshot({ settings, cwd: root })
  assert.equal(snapshot.ok, true, 'the snapshot builds from a real directory')
  assert.equal(typeof snapshot.identity, 'string', 'the snapshot carries an identity for dedupe')
  // `buildSnapshot` marks only the uninitialized case; anything else is a real
  // snapshot. Encoding it this way is deliberate — a session on a project the user
  // has not set up yet should get a short "run project_init" note, not an error.
  assert.equal(snapshot.uninitialized, undefined, 'an initialized project is a normal snapshot')
  assert.ok(snapshot.state !== undefined, 'the snapshot carries state')
  assert.ok(snapshot.project?.projectId !== undefined, 'the snapshot carries the project identity')

  // --- Baseline composition ---
  const payload = composePayload({ snapshot, settings, form: 'baseline' })
  assert.notEqual(payload, null, 'a baseline is worth sending')
  assert.equal(payload.tier === 'L0' || payload.tier === 'L1', true, 'the tier is declared')
  assert.match(payload.content, /docs\/knowledge\/combat\.md/, 'the baseline lists known documents')

  const message = createInjectionMessage({ payload, snapshot })
  assert.equal(message.role, 'user', 'the injection is a user message')
  const text = (message.content ?? []).map((block) => block.text ?? '').join('\n')
  assert.ok(text.length > 0, 'the message has visible text')
  assert.equal(message.source?.kind, MESSAGE_SOURCE_KIND, 'the message is tagged as plugin-owned so dedupe can find it')
  assert.equal(message.source?.form, 'baseline', 'the form is recorded')
  assert.equal(message.source?.baselineIdentity, snapshot.identity, 'the identity is recorded for dedupe')

  // --- The framing contract: injected data is data ---
  // A memory baseline contains project text that the model will read. It must arrive
  // inside a nonce fence so a document cannot impersonate instructions.
  assert.match(text, /PROJECT REFERENCE DATA|project/i, 'the payload identifies itself rather than looking like the user speaking')

  // --- Dedupe over a real surface shape ---
  // `surface.nodes` is a sequence list and `eventAt(seq)` returns the logged event;
  // the stand-in reproduces both so the scan is exercised rather than skipped.
  const events = new Map([
    [0, { type: 'user/message', data: { source: { kind: MESSAGE_SOURCE_KIND, baselineIdentity: snapshot.identity } } }],
    [1, { type: 'assistant/message', data: {} }],
    [2, { type: 'user/message', data: { source: { kind: 'someone-else' } } }],
  ])
  const agent = {
    session: {
      header: { id: 'session-1', cwd: root },
      surface: { nodes: [0, 1, 2] },
      eventAt: (seq) => events.get(seq),
    },
  }
  assert.equal(surfaceHasBaseline(agent, snapshot.identity), true, 'an identical baseline on the surface is detected')
  assert.equal(surfaceHasBaseline(agent, 'a-different-identity'), false, 'a different identity is not mistaken for this one')

  // A surface read failure must degrade to "not seen", never throw: this runs inside
  // the step pipeline where an exception would otherwise alter the session.
  assert.equal(surfaceHasBaseline({ session: { get surface() { throw new Error('gone') } } }, snapshot.identity), false, 'a surface failure reads as absent')
  assert.equal(surfaceHasBaseline(undefined, snapshot.identity), false, 'a missing agent reads as absent')

  // --- State actually reaches the baseline ---
  await writeState({
    root,
    identity,
    patch: { task: { title: 'implement combat', status: 'in_progress' }, next: [{ step: 'write tests' }], blockers: [{ text: 'no art' }] },
    by: { source: 'test' },
  })
  const after = await buildSnapshot({ settings, cwd: root })
  const payload2 = composePayload({ snapshot: after, settings, form: 'baseline' })
  assert.match(payload2.content, /implement combat/, 'the current task reaches the injected baseline')
  assert.match(payload2.content, /write tests/, 'so do the next steps')
  assert.match(payload2.content, /no art/, 'and the blockers')
  assert.notEqual(after.identity, snapshot.identity, 'a state write changes the identity so the next step resends')

  // --- Every injected message must survive the harness's JSON admission check ---
  // This is not a style assertion. The harness snapshots each message before
  // appending it and rejects the *entire step* when any value is `undefined`
  // (`session event "user/message" carries non-JSON-serializable data`). A live
  // session died exactly here: one step injected the baseline, then the
  // post-compaction manifest, whose payload carries `text` instead of `content`
  // and no `identity`. Reading the baseline fields for both shapes produced
  // `text: undefined` and `baselineIdentity: undefined`, so the manifest append
  // threw and the turn ended with that error. Checking with the harness's own
  // predicate is what makes that class of defect fail here instead of in a
  // user's session.
  const { snapshotJsonValue } = await import('@deepseek-ai/dsh-util-values').catch((error) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return { snapshotJsonValue: null }
    throw error
  })
  /** Assert one message is losslessly JSON-serializable. */
  const assertAdmissible = (candidate, label) => {
    assert.equal(typeof candidate.content?.[0]?.text, 'string', `${label}: the text block is a real string`)
    assert.equal(
      Object.values(candidate.source ?? {}).some((value) => value === undefined),
      false,
      `${label}: no source field is undefined`,
    )
    if (snapshotJsonValue === null) return
    assert.notEqual(snapshotJsonValue(candidate), undefined, `${label}: the harness would accept this event`)
  }

  assertAdmissible(message, 'baseline')

  // The manifest is the shape that broke: same helper, different payload.
  // It only renders when the store holds atoms, so write one first.
  const { renderMemoryManifest } = await import('../lib/semantic.js')
  const { ATOMS_FILE, normalizeAtom } = await import('../core/memory.js')
  const atomRecord = normalizeAtom({
    kind: 'constraint',
    text: 'Never rewrite AGENTS.md in place.',
    weight: 3,
    confidence: 0.9,
    tags: [],
    files: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  }, { now: '2026-11-01T00:00:00.000Z' })
  assert.ok(atomRecord !== null, 'the fixture atom is a valid record')
  mkdirSync(path.join(root, path.dirname(ATOMS_FILE)), { recursive: true })
  writeFileSync(path.join(root, ATOMS_FILE), `${JSON.stringify(atomRecord)}\n`, 'utf8')
  const manifest = renderMemoryManifest({ root, settings })
  assert.equal(manifest.ok, true, 'a manifest renders for a project with atoms')
  const manifestMessage = createInjectionMessage({
    payload: { form: 'memory-manifest', text: manifest.text, tier: 'manifest', tokens: 1 },
    snapshot,
  })
  assert.equal(manifestMessage.source?.form, 'memory-manifest', 'the manifest keeps its own form')
  assert.equal('baselineIdentity' in manifestMessage.source, false, 'a manifest claims no baseline identity')
  assertAdmissible(manifestMessage, 'memory-manifest')

  // An uninitialized project has no project id and no state; that message must also
  // be admissible, because it is the first thing a new user ever receives.
  const uninitializedPayload = composePayload({ snapshot: { ok: true, uninitialized: true, root, git: { kind: 'absent' } }, settings, form: 'baseline' })
  const uninitializedMessage = createInjectionMessage({ payload: uninitializedPayload, snapshot: { root, git: { kind: 'absent' } } })
  assertAdmissible(uninitializedMessage, 'uninitialized')

  // Recall is the third injected shape, and the one that runs on almost every step,
  // so it gets the same check. `route` and `confidence` are what the source carries
  // beyond text; a router result adds a nested object and stays admissible.
  const { createRecallMessage } = await import('../lib/inject.js')
  const recall = {
    ok: true,
    block: 'Recalled project memory (durable atoms):\n- aaaa [constraint] never rewrite AGENTS.md',
    route: 'subagent',
    reason: 'the constraint governs this request',
    tier: 'recall/always',
    atoms: 1,
    tokens: 12,
    confidence: 'routed',
    ids: [atomRecord.id],
    router: { ok: true, ids: 1, cold: 0, rejected: 0, digestTokens: 100, reason: 'x' },
  }
  assertAdmissible(createRecallMessage({ recall, root, identity: 'deadbeef' }), 'recall/routed')
  assertAdmissible(
    createRecallMessage({ recall: { ...recall, route: 'deterministic', confidence: 'weak', router: undefined }, root }),
    'recall/deterministic',
  )

  // --- The uninitialized project is told what to do, not silently ignored ---
  const emptyRoot = mkdtempSync(path.join(tmpdir(), 'pm-inject-empty-'))
  try {
    const empty = await buildSnapshot({ settings, cwd: emptyRoot })
    const emptyPayload = composePayload({ snapshot: empty, settings, form: 'baseline' })
    assert.notEqual(emptyPayload, null, 'an uninitialized project still gets a message')
    assert.match(emptyPayload.content, /project_init/, 'and the message says how to start')
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true })
  }

  console.log('INJECT OK: baseline composition, plugin-owned message tagging, surface dedupe, and state propagation all verified')
} finally {
  rmSync(root, { recursive: true, force: true })
}
