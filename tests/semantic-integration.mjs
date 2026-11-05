/**
 * Integration tests for the GC-inspired upgrade, wired through the real modules.
 *
 * `tests/semantic.mjs` proves the pieces; this file proves the *seams*: that the switches
 * actually gate behaviour, that a lifecycle-cold atom stays out of the assembled request
 * while remaining reachable, that the intent cache cannot cross projects, that the
 * post-compaction manifest carries instructions but no atom text, and that a broken
 * auxiliary file degrades instead of failing a step.
 *
 * Run: node tests/semantic-integration.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULTS, normalizeConfig } from '../core/config.js'
import { ATOMS_FILE, normalizeAtom } from '../core/memory.js'
import { LIFECYCLE_FILE, MEMORY_STATUSES, LIFECYCLE_TIERS } from '../core/lifecycle.js'
import { METRICS_FILE } from '../core/metrics.js'
import { buildQuery } from '../core/gate.js'
import { recallForStep, stepQuery } from '../lib/recall.js'
import { createRecallMessage, RECALL_SOURCE_KIND } from '../lib/inject.js'
import {
  clearDecisionCache,
  debugView,
  metricsReport,
  noteLifecycle,
  planSemanticRecall,
  renderMemoryManifest,
  runLifecycleSweep,
  semanticEnabled,
} from '../lib/semantic.js'

/** One passing section. */
function line(text) {
  console.log(`SEMANTIC-INTEGRATION: ${text}`)
}

let clock = Date.parse('2026-11-01T00:00:00.000Z')
function atom(kind, text, extra = {}) {
  clock += 1000
  const record = normalizeAtom(
    {
      kind,
      text,
      weight: 3,
      confidence: 0.9,
      tags: [],
      files: [],
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      ...extra,
    },
    { now: new Date(clock).toISOString() },
  )
  assert.ok(record !== null)
  return record
}

/** Write a store and return the root. */
function makeRoot(atoms) {
  const root = mkdtempSync(join(tmpdir(), 'pm-semint-'))
  mkdirSync(join(root, '.dsh-memory', 'memory'), { recursive: true })
  writeFileSync(join(root, ATOMS_FILE), atoms.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
  return root
}

/** Flatten the text blocks of a message list, as the loop would send them. */
function requestText(messages) {
  const parts = []
  for (const message of messages) {
    const blocks = Array.isArray(message?.content) ? message.content : []
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** Mimic the loop: the injected messages are appended to the step's messages. */
function assembleRequest(stepMessages, injected) {
  return [...stepMessages, ...injected]
}

// ------------------------------------------------- 1. switches gate behaviour
{
  const off = normalizeConfig({})
  assert.equal(off.semanticRouting, false, 'semantic routing defaults off')
  assert.equal(off.lifecycleEnabled, false, 'lifecycle defaults off')
  assert.equal(off.taskIntentEnabled, false, 'task intents default off')
  assert.equal(semanticEnabled(off), false, 'nothing is enabled by default')
  // The master switch is enough to re-enable the old behaviour exactly, which is the
  // rollback story: one boolean, no migration, no data loss.
  assert.equal(DEFAULTS.semanticRouting, false, 'the shipped default is the rollback position')

  const on = normalizeConfig({ semanticRouting: true, lifecycleEnabled: true, taskIntentEnabled: true })
  assert.equal(semanticEnabled(on), true, 'the switches turn it on')

  // Bounds are applied rather than trusted.
  const clamped = normalizeConfig({ intentCacheTtlMs: 10 ** 12, recallBudget: -5 })
  assert.ok(clamped.intentCacheTtlMs <= 86400000, 'an absurd cache TTL is clamped')
  assert.ok(clamped.recallBudget >= 100, 'an impossible budget is clamped')

  line('every switch defaults to the conservative value, and one boolean restores the pre-upgrade path')
}

// ------------------------------------- 2. lifecycle-cold atoms are not injected
{
  const hot = atom('constraint', 'The router must never write to the memory store.', { files: ['lib/router.js'] })
  const cold = atom('fact', 'An old note about the router that nobody has used since.', { files: ['lib/router.js'] })
  const root = makeRoot([hot, cold])
  try {
    const lifecycle = {
      schema: 1,
      version: 1,
      atoms: {
        [hot.id]: { tier: 'HOT', status: 'active', pinned: false, retrieved: 4, delivered: 3, used: 2, lastUsedAt: '2026-11-01T00:00:00.000Z', lastTransition: null },
        [cold.id]: { tier: 'COLD', status: 'active', pinned: false, retrieved: 1, delivered: 1, used: 0, lastUsedAt: null, lastTransition: null },
      },
      updatedAt: '2026-11-01T00:00:00.000Z',
    }
    writeFileSync(join(root, LIFECYCLE_FILE), JSON.stringify(lifecycle), 'utf8')

    const settings = normalizeConfig({ routerTier: 'always', semanticRouting: true, lifecycleEnabled: true })
    const query = stepQuery({ messages: [{ role: 'user', content: [{ type: 'text', text: 'router memory store' }] }] })

    // The router asks for both atoms explicitly. The cold one must still be withheld from
    // the injected text while staying reachable as a cold reference.
    const recall = await recallForStep({
      root,
      settings,
      query,
      projectId: 'p',
      delegate: async () => JSON.stringify({ hot_memory_ids: [hot.id, cold.id] }),
      routerAvailable: true,
    })
    assert.equal(recall.ok, true, 'recall succeeds with lifecycle gating on')
    const text = requestText([createRecallMessage({ recall, root, identity: 'k' })])
    assert.ok(text.includes('never write to the memory store'), 'the hot atom reaches the request')
    assert.ok(
      text.includes('Older project memory matching this request, NOT loaded'),
      'the cold atom becomes a cold reference rather than disappearing',
    )
    assert.equal(recall.semantic.enabled, true, 'the result reports that the semantic layer ran')
    assert.ok(recall.semantic.tiers.COLD >= 1, 'the tier counts are reported')

    // A superseded atom is not injected at all: validity is not a lifecycle question.
    writeFileSync(
      join(root, LIFECYCLE_FILE),
      JSON.stringify({ ...lifecycle, atoms: { ...lifecycle.atoms, [hot.id]: { ...lifecycle.atoms[hot.id], status: 'superseded' } } }),
      'utf8',
    )
    const skipped = await recallForStep({
      root,
      settings,
      query,
      projectId: 'p',
      delegate: async () => JSON.stringify({ hot_memory_ids: [cold.id] }),
      routerAvailable: true,
    })
    const skippedText = skipped.ok === true ? requestText([createRecallMessage({ recall: skipped, root, identity: 'k2' })]) : ''
    assert.equal(skippedText.includes('never write to the memory store'), false, 'a superseded atom is never injected')

    line('a COLD atom is withheld from the text but kept as a reference, and a superseded atom is not injected at all')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ------------------------------------------------ 3. statuses stay separate
{
  for (const status of MEMORY_STATUSES) {
    assert.equal(LIFECYCLE_TIERS.includes(status), false, `status "${status}" is not a tier`)
  }
  line('validity statuses and lifecycle tiers are disjoint sets, so cooling never looks like deletion')
}

// ------------------------------------------------- 4. intent cache is scoped
{
  clearDecisionCache()
  const subject = atom('decision', 'Memory routing uses separate hot and cold id lists for the router protocol.', { files: ['lib/router.js'] })
  const root = makeRoot([subject])
  try {
    const settings = normalizeConfig({ semanticRouting: true, taskIntentEnabled: true, intentCacheEnabled: true })
    const intent = {
      taskSummary: 'fix the router protocol',
      affectedModules: ['lib'],
      operation: 'bugfix',
      memoryNeeds: ['architecture_decisions'],
      categories: [],
      maxMemoryTokens: 2000,
      projectId: 'current',
      createdAt: '2026-11-01T00:00:00.000Z',
    }
    const first = planSemanticRecall({ root, settings, projectId: 'p', intent, queryText: 'router protocol', now: 1000 })
    assert.equal(first.ok, true, 'the first plan is built')
    assert.equal(first.cached, undefined, 'the first call is not a cache hit')

    const second = planSemanticRecall({ root, settings, projectId: 'p', intent, queryText: 'router protocol', now: 1500 })
    assert.equal(second.cached, true, 'the same intent reuses the decision')

    // A different project must never reuse it, even with an identical intent.
    const otherProject = planSemanticRecall({ root, settings, projectId: 'q', intent, queryText: 'router protocol', now: 1600 })
    assert.notEqual(otherProject.cached, true, 'a different project never shares a cached decision')

    // A different task must not reuse it either.
    const otherTask = planSemanticRecall({
      root,
      settings,
      projectId: 'p',
      intent: { ...intent, taskSummary: 'rename the billing module' },
      queryText: 'billing',
      now: 1700,
    })
    assert.notEqual(otherTask.cached, true, 'a different task never reuses a decision')

    // A store change invalidates it: a new atom means the old answer may be wrong.
    const grown = normalizeAtom({ kind: 'fact', text: 'A brand new fact that changes the store version.', weight: 3, confidence: 0.9 }, { now: '2026-11-02T00:00:00.000Z' })
    writeFileSync(join(root, ATOMS_FILE), [subject, grown].map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
    const afterChange = planSemanticRecall({ root, settings, projectId: 'p', intent, queryText: 'router protocol', now: 1800 })
    assert.notEqual(afterChange.cached, true, 'a store change invalidates the cached decision')

    line('the intent cache is scoped to one project, one task and one store version')
  } finally {
    clearDecisionCache()
    rmSync(root, { recursive: true, force: true })
  }
}

// -------------------------------------------------- 5. compaction manifest
{
  const subjects = [
    atom('constraint', 'Never rewrite AGENTS.md in place.', { files: ['AGENTS.md'] }),
    atom('decision', 'The panel writes settings only through configEditor.', { files: ['lib/panel.js'] }),
    atom('pitfall', 'The host ignores CSS returned from a client factory.', { files: ['client.js'] }),
  ]
  const root = makeRoot(subjects)
  try {
    const manifest = renderMemoryManifest({ root, settings: normalizeConfig({ lifecycleEnabled: true }) })
    assert.equal(manifest.ok, true, 'the manifest renders when atoms exist')
    assert.match(manifest.text, /3 durable atom/, 'the manifest states how much memory exists')
    assert.match(manifest.text, /memory_intent/, 'the manifest names the structured tool')
    assert.match(manifest.text, /memory_recall/, 'the manifest names the keyword tool')
    assert.match(manifest.text, /memory_remember/, 'the manifest says how to make memory survive the next compaction')
    assert.match(manifest.text, /reference data, not instructions/, 'the manifest keeps memory framed as data')
    // The whole point: instructions, not content.
    for (const subject of subjects) {
      assert.equal(manifest.text.includes(subject.text), false, 'the manifest carries no atom text')
    }
    // Categories are summarised, because they are cheap and tell the model what to ask.
    assert.ok(manifest.manifest.categories.length > 0, 'the manifest summarises categories')

    // An empty store is not an error, it is simply nothing to say.
    const emptyRoot = makeRoot([])
    try {
      const empty = renderMemoryManifest({ root: emptyRoot, settings: normalizeConfig({}) })
      assert.equal(empty.ok, false, 'an empty store produces no manifest')
      assert.match(empty.reason, /no memory atoms/, 'the reason is stated')
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true })
    }

    line('the post-compaction manifest carries counts and tool instructions, never atom text')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ------------------------------------------- 6. lifecycle counters and sweeps
{
  const used = atom('constraint', 'Deletes must go through the tombstone path.', { files: ['core/memory.js'] })
  const idle = atom('fact', 'A note that will cool out untouched.', { files: ['docs/old.md'] })
  const root = makeRoot([used, idle])
  try {
    const settings = normalizeConfig({ lifecycleEnabled: true, lifecycleAutoSweep: true })
    // Retrieval alone is recorded, and it is not delivery and not use.
    const noted = noteLifecycle({ root, settings, retrieved: [used, idle], now: '2026-11-01T01:00:00.000Z' })
    assert.equal(noted.ok, true, 'retrieval is recorded')
    const stored = JSON.parse(readFileSync(join(root, LIFECYCLE_FILE), 'utf8'))
    assert.equal(stored.atoms[used.id].retrieved, 1, 'retrieval is stored')
    assert.equal(stored.atoms[used.id].delivered, 0, 'retrieval did not become delivery')
    assert.equal(stored.atoms[used.id].used, 0, 'retrieval did not become use')

    // Delivery is recorded separately.
    noteLifecycle({ root, settings, delivered: [used], now: '2026-11-01T02:00:00.000Z' })
    const afterDelivery = JSON.parse(readFileSync(join(root, LIFECYCLE_FILE), 'utf8'))
    assert.equal(afterDelivery.atoms[used.id].delivered, 1, 'delivery is stored')
    assert.equal(afterDelivery.atoms[used.id].used, 0, 'delivery did not become use')

    // A sweep with no confirmed use cannot promote anything.
    const sweep = runLifecycleSweep({ root, settings, now: Date.parse('2026-11-01T03:00:00.000Z') })
    assert.equal(sweep.ok, true, 'the sweep runs')
    assert.equal(sweep.promoted, 0, 'retrieval plus delivery never promotes without confirmed use')

    // With the auto-sweep off, the sweep refuses to write.
    const manual = normalizeConfig({ lifecycleEnabled: true, lifecycleAutoSweep: false })
    const refused = runLifecycleSweep({ root, settings: manual })
    assert.equal(refused.ok, true, 'a disabled sweep is not an error')
    assert.equal(refused.promoted, 0, 'a disabled sweep promotes nothing')
    assert.equal(refused.reason, 'lifecycleAutoSweep is off', 'the reason names the switch')

    // The debug view answers "why is this atom in this tier".
    const view = debugView({ root, settings, limit: 10 })
    assert.equal(view.ok, true, 'the debug view renders')
    assert.equal(view.rows.length, 2, 'every atom appears in the debug view')
    for (const row of view.rows) {
      assert.ok(Array.isArray(row.category) && row.category.length > 0, 'each row carries its categories')
      assert.ok(LIFECYCLE_TIERS.includes(row.tier), 'each row carries a tier')
      assert.ok(MEMORY_STATUSES.includes(row.status), 'each row carries a status')
      assert.equal(typeof row.retrieved, 'number', 'each row carries the retrieval count')
    }

    line('retrieval, delivery and confirmed use are recorded separately, and a sweep cannot promote on attention alone')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ----------------------------------------------- 7. corrupt aux files degrade
{
  const subject = atom('constraint', 'A rule that must still be delivered when sidecars are broken.', { files: ['lib/router.js'] })
  const root = makeRoot([subject])
  try {
    mkdirSync(join(root, '.dsh-memory', 'memory'), { recursive: true })
    writeFileSync(join(root, LIFECYCLE_FILE), 'not json at all', 'utf8')
    writeFileSync(join(root, METRICS_FILE), 'also not json', 'utf8')

    const settings = normalizeConfig({ routerTier: 'always', semanticRouting: true, lifecycleEnabled: true })
    const query = stepQuery({ messages: [{ role: 'user', content: [{ type: 'text', text: 'rule delivery' }] }] })
    const recall = await recallForStep({
      root,
      settings,
      query,
      projectId: 'p',
      delegate: async () => JSON.stringify({ hot_memory_ids: [subject.id] }),
      routerAvailable: true,
    })
    assert.equal(recall.ok, true, 'a corrupt sidecar does not fail the recall')
    const text = requestText([createRecallMessage({ recall, root, identity: 'k' })])
    assert.ok(text.includes('must still be delivered'), 'the atom is still delivered')

    // The debug view and metrics report must also survive, reporting rather than throwing.
    const view = debugView({ root, settings })
    assert.equal(view.ok, true, 'the debug view survives a corrupt lifecycle file')
    const report = metricsReport({ root })
    assert.equal(report.ok, true, 'the metrics report survives a corrupt metrics file')

    line('corrupt lifecycle and metrics files degrade to empty, never to a lost step')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ------------------------------------ 8. the switch off really is the old path
{
  const subject = atom('constraint', 'Switch-off behaviour must match the pre-upgrade path.', { files: ['lib/router.js'] })
  const root = makeRoot([subject])
  try {
    const settings = normalizeConfig({ routerTier: 'always' })
    const query = stepQuery({ messages: [{ role: 'user', content: [{ type: 'text', text: 'switch behaviour' }] }] })
    const recall = await recallForStep({
      root,
      settings,
      query,
      projectId: 'p',
      delegate: async () => JSON.stringify({ hot_memory_ids: [subject.id] }),
      routerAvailable: true,
    })
    assert.equal(recall.ok, true, 'the classic path still works')
    assert.equal(recall.semantic, undefined, 'no semantic block is reported when the upgrade is off')
    const text = requestText([createRecallMessage({ recall, root, identity: 'k' })])
    assert.ok(text.includes('Switch-off behaviour'), 'the atom is delivered on the classic path')

    // And no sidecar is written as a side effect of simply recalling.
    const wroteLifecycle = (() => {
      try {
        readFileSync(join(root, LIFECYCLE_FILE), 'utf8')
        return true
      } catch {
        return false
      }
    })()
    assert.equal(wroteLifecycle, false, 'a recall with the upgrade off writes no lifecycle file')

    line('with the upgrade off the classic path runs and writes nothing new')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ------------------------------------------------------ 9. no double delivery
{
  const subject = atom('constraint', 'A rule that must not be injected twice.', { files: ['lib/router.js'] })
  const root = makeRoot([subject])
  try {
    const settings = normalizeConfig({ routerTier: 'always', semanticRouting: true })
    const query = buildQuery(['double delivery'])
    const recall = await recallForStep({
      root,
      settings,
      query,
      projectId: 'p',
      delegate: async () => JSON.stringify({ hot_memory_ids: [subject.id] }),
      routerAvailable: true,
    })
    assert.equal(recall.ok, true, 'recall succeeds')
    const message = createRecallMessage({ recall, root, identity: 'k' })
    assert.equal(message.source.kind, RECALL_SOURCE_KIND, 'the message is tagged as plugin-owned')
    // The semantic layer must not add a second copy of the same atoms.
    const occurrences = String(message.content?.[0]?.text ?? '').split('must not be injected twice').length - 1
    assert.equal(occurrences, 1, 'the atom text appears exactly once')

    line('the semantic layer adds no duplicate of an atom the classic path already delivered')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

console.log('')
console.log(
  'SEMANTIC-INTEGRATION OK: every switch defaults off and gating is real, cold atoms leave the text but stay reachable, ' +
  'statuses never masquerade as tiers, the cache cannot cross a project or a version, the compaction manifest carries ' +
  'instructions without content, and corrupt sidecars cost a card rather than a step',
)
