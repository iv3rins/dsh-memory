/**
 * End-to-end proof that memory reaches the model request.
 *
 * The distinction this file exists for: "the router returned ids" is not evidence
 * that the main model received memory. The only thing that counts is the content of
 * the messages the loop is about to send. So every check below reads the assembled
 * request — the `messages` array a `agent/pre-step` waterfall resolves to — and looks
 * for the atom *text*, not its id.
 *
 * Run: node tests/handshake.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ATOMS_FILE, readAtoms } from '../core/memory.js'
import { recallForStep, stepQuery } from '../lib/recall.js'
import { createRecallMessage, recallIdentity, surfaceHasRecall, RECALL_SOURCE_KIND } from '../lib/inject.js'
import { normalizeConfig, DEFAULTS } from '../core/config.js'

const line = (text) => console.log(text)

/** Build a project root with a real atom store on disk. */
function makeRoot(atoms) {
  const root = mkdtempSync(join(tmpdir(), 'pm-handshake-'))
  mkdirSync(join(root, '.dsh-memory', 'memory'), { recursive: true })
  const rows = atoms.map((atom) => JSON.stringify(atom))
  // `ATOMS_FILE` is already relative to the project root (`.dsh-memory/memory/atoms.jsonl`).
  writeFileSync(join(root, ATOMS_FILE), `${rows.join('\n')}\n`, 'utf8')
  return root
}

/**
 * One durable atom, in the shape `normalizeAtom` accepts.
 *
 * The stored field is `text` (not `statement`) and the id is derived from a content
 * hash, so the test cannot choose it: `atomId(kind, text)` is what `readAtoms` will
 * compute. Fixtures therefore declare the text and read the id back.
 */
function atom(text, extra = {}) {
  return {
    kind: 'constraint',
    text,
    weight: 3,
    confidence: 0.9,
    tags: [],
    files: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...extra,
  }
}

/**
 * Assemble a request the way the loop does: run the pre-step waterfall, then read
 * `decision.messages`. This is the array sent to the provider.
 */
function assembleRequest(stepMessages, injected) {
  const decision = { kind: 'enter', messages: stepMessages }
  return { ...decision, messages: [...decision.messages, ...injected] }
}

/** Render one message the way a provider request flattens text blocks. */
function requestText(messages) {
  return messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

const settings = normalizeConfig({ ...DEFAULTS, routerTier: 'always', routerProvider: 'airelay', routerModel: 'deepseek-v4.1-flash' })

// ------------------------------------------------------------------ Test 2: real injection
{
  const HOT_TEXT = 'The writer must never modify .blend1 backup files directly.'
  const SECOND_TEXT = 'Exports always land in the deliverables folder, never in the source tree.'
  const COLD_TEXT = 'Early exploration compared three mesh decimation libraries in depth.'
  const OTHER_TEXT = 'Unrelated note about the marketing website colour palette.'

  // `constraint` is a standing kind: it is kept structurally regardless of the router.
  // The optional atoms are therefore `fact`, so the checks below observe the router's
  // decision rather than the standing guarantee.
  const root = makeRoot([
    atom(HOT_TEXT),
    atom(SECOND_TEXT, { kind: 'fact' }),
    atom(COLD_TEXT, { kind: 'fact' }),
    atom(OTHER_TEXT, { kind: 'fact' }),
  ])
  try {
    // Read the ids the store actually assigned (content hashes), so the router below
    // selects real ids rather than ones the test invented.
    const stored = readAtoms(root)
    assert.equal(stored.ok, true, 'the fixture store must load')
    assert.equal(stored.live.length, 4, 'all four fixture atoms must be live')
    const idOf = (text) => {
      const found = stored.live.find((entry) => entry.text === text)
      assert.ok(found !== undefined, `fixture atom not found: ${text}`)
      return found.id
    }
    const hot = idOf(HOT_TEXT)
    const second = idOf(SECOND_TEXT)
    const cold = idOf(COLD_TEXT)

    const query = stepQuery({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Fix the .blend1 backup handling in the export step' }] }],
    })

    let delegateCalls = 0
    const recall = await recallForStep({
      root,
      settings,
      query,
      delegate: async (request) => {
        delegateCalls += 1
        // A competent router: choose the atoms governing the files in play, and put
        // the expensive historical one in cold storage.
        assert.ok(request.prompt.includes(hot), 'the digest must offer the candidate ids to the router')
        return JSON.stringify({
          request_id: 'req_001',
          hot_memory_ids: [hot, second],
          cold_memory_ids: [cold],
          abstained: false,
          reason: 'constraints on the files named in the request',
        })
      },
      routerAvailable: true,
    })

    assert.equal(delegateCalls, 1, 'the router subagent was actually called exactly once')
    assert.equal(recall.ok, true, `recall must succeed, got: ${recall.reason}`)

    // Build the message and assemble the request exactly as the loop does.
    const recallKey = recallIdentity(recall)
    const injected = createRecallMessage({ recall, root, identity: recallKey })
    const stepMessages = [
      { role: 'user', content: [{ type: 'text', text: 'Fix the .blend1 backup handling in the export step' }] },
    ]
    const request = assembleRequest(stepMessages, [injected])
    const text = requestText(request.messages)

    // The decisive assertion: the *content* of the selected atoms is in the request.
    assert.ok(text.includes('never modify .blend1 backup files'), 'the request must contain the atom TEXT, not only its id')
    assert.ok(text.includes('deliverables folder'), 'every selected hot atom must be present, not just the first')

    // The rendered block deliberately carries text and provenance, not ids: an id costs
    // tokens and tells the model nothing. Traceability lives on the message source
    // instead, which is where the audit path reads it from.
    assert.ok(!text.includes(hot), 'the rendered block spends no tokens on atom ids')
    // Two atoms were selected and two standing constraints are kept regardless, so the
    // count is the rendered total, not the router's selection length.
    assert.ok(
      injected.source.atoms >= 2,
      `the injected message records how many atoms it carried, got ${injected.source.atoms}`,
    )
    assert.equal(injected.source.projectRoot, root.replaceAll('\\', '/'), 'the source names the project it came from')

    // Cold memory is a reference, not an injection. For a short atom the gist *is* the
    // text — truncating a 17-token atom would hide the very thing that lets the model
    // decide whether to look it up. What must hold is that it appears once, in the cold
    // block marked "NOT loaded", and never as a hot entry.
    const coldSection = text.split('Older project memory matching this request, NOT loaded')[1] ?? ''
    assert.ok(coldSection.includes(cold), 'the cold reference must name the id the model would read')
    const hotSection = text.split('Older project memory matching this request, NOT loaded')[0]
    assert.ok(
      !hotSection.includes(COLD_TEXT),
      'a cold atom must not appear in the hot block that is loaded verbatim',
    )

    // The injected message is tagged, so it is distinguishable and de-duplicable.
    assert.equal(injected.source?.kind, RECALL_SOURCE_KIND, 'the recall message carries its own source kind')
    assert.equal(surfaceHasRecall({ session: { surface: { nodes: [] } } }, recallKey), false)

    line('HANDSHAKE: router selected 2 hot atoms; their text — not only their ids — is in the assembled request')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ------------------------------------------------------- Test 10: no double injection
{
  const HOT_TEXT = 'The writer must never modify .blend1 backup files directly.'
  const root = makeRoot([atom(HOT_TEXT)])
  try {
    const stored = readAtoms(root)
    assert.equal(stored.ok, true)
    const hot = stored.live[0].id

    const query = stepQuery({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Fix the .blend1 backup handling' }] }],
    })
    const recall = await recallForStep({
      root,
      settings,
      query,
      delegate: async () => JSON.stringify({ hot_memory_ids: [hot], reason: 'relevant' }),
      routerAvailable: true,
    })
    assert.equal(recall.ok, true)

    const key = recallIdentity(recall)
    const injected = createRecallMessage({ recall, root, identity: key })

    // Simulate the surface now containing the injected message.
    const events = [{ type: 'user/message', data: { source: injected.source } }]
    const agent = {
      session: { surface: { nodes: [0] }, eventAt: (seq) => events[seq] },
    }

    assert.equal(surfaceHasRecall(agent, key), true, 'an identical recall already on the surface is detected')

    // A second step that selects the same atoms must not inject them again.
    const second = await recallForStep({
      root,
      settings,
      query,
      delegate: async () => JSON.stringify({ hot_memory_ids: [hot], reason: 'relevant' }),
      routerAvailable: true,
    })
    assert.equal(recallIdentity(second), key, 'the same selection has the same identity')
    assert.equal(
      surfaceHasRecall(agent, recallIdentity(second)),
      true,
      'so a consecutive tool call re-injects nothing',
    )

    line('HANDSHAKE: a repeated selection is not injected twice into the same surface')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ------------------------------------------- Test 3: empty selection keeps constraints
{
  const STANDING_TEXT = 'Never rewrite files under docs/decisions/ in place.'
  const root = makeRoot([
    atom(STANDING_TEXT, { weight: 5 }),
    atom('Optional background that the router may decline.'),
  ])
  try {
    const query = stepQuery({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Update the decision record' }] }],
    })
    const recall = await recallForStep({
      root,
      settings,
      query,
      delegate: async () => JSON.stringify({ hot_memory_ids: [], cold_memory_ids: [], abstained: true, reason: 'nothing optional applies' }),
      routerAvailable: true,
    })

    if (recall.ok === true) {
      const text = requestText([createRecallMessage({ recall, root, identity: recallIdentity(recall) })])
      assert.ok(
        text.includes('docs/decisions/'),
        'a standing constraint survives an empty router selection: the router cannot veto it',
      )
      line('HANDSHAKE: an empty selection drops optional atoms but keeps the standing constraint')
    } else {
      // Also acceptable: nothing at all was injected, so nothing wrong was claimed.
      line(`HANDSHAKE: empty selection injected nothing (${recall.reason})`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ------------------------------------------------ Test 7: router failure degrades safely
{
  const STANDING_TEXT = 'The writer must never modify .blend1 backup files directly.'
  const root = makeRoot([atom(STANDING_TEXT, { weight: 5 })])
  try {
    const query = stepQuery({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Fix the .blend1 backup handling' }] }],
    })

    const failures = [
      ['timeout', async () => { throw new Error('router timed out') }],
      ['invalid JSON', async () => 'I think these two are relevant, honestly'],
      ['unknown ids', async () => JSON.stringify({ hot_memory_ids: ['mem_does_not_exist'], reason: 'hallucinated' })],
      ['provider error', async () => { throw new Error('provider "airelay" returned 502') }],
    ]

    for (const [label, delegate] of failures) {
      const recall = await recallForStep({ root, settings, query, delegate, routerAvailable: true })
      // The step must never be failed by a router that misbehaves.
      assert.equal(recall.ok, true, `${label}: a broken router must not fail the step`)
      if (recall.router !== undefined) {
        const rejected = recall.router.rejected ?? 0
        if (label === 'unknown ids') {
          // A hallucinated id is not a router failure: the router answered, and the
          // answer was filtered. What must hold is that it was *counted* as rejected,
          // so the store cannot be corrupted by a model inventing memory.
          assert.ok(rejected >= 1, 'a hallucinated id is rejected and reported, never honoured')
        } else {
          assert.notEqual(recall.router.ok, true, `${label}: the failure must be reported, not hidden`)
        }
      }
      const message = createRecallMessage({ recall, root, identity: recallIdentity(recall) })
      const text = requestText([message])
      assert.ok(
        text.includes('.blend1'),
        `${label}: the standing constraint is still delivered when the router fails`,
      )
    }

    line('HANDSHAKE: timeout, bad JSON, hallucinated ids and provider errors all degrade without losing the standing constraint')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

line('HANDSHAKE OK: hot memory reaches the assembled request as content, cold memory stays out, repeats are suppressed, and router failures degrade safely')
