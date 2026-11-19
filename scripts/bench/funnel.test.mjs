/**
 * Regression tests for the evidence-recovery funnel.
 *
 * Each test pins a defect that the first version of `funnel.mjs` actually shipped. They
 * are written against the diagnostic, not against a live corpus, so they need no
 * benchmark data, no network and no model — which is the point: the funnel exists to
 * decide where to spend paid calls, so its own correctness must be free to check.
 *
 * The defects, in the order they were found:
 *
 * 1. `injected` was decided by searching the rendered block for a probe string. Any other
 *    atom sharing a word faked a hit, so the stage after `selected` could never disagree.
 * 2. The cache holds `kind`/`text` but no id, so matching cache records against the ids
 *    `gateAtoms` returns compared against `undefined` and reported every selection as a
 *    miss. The store has to be read back to get real ids.
 * 3. Extraction and retention were one stage, so a record evicted by the store cap was
 *    reported as an extraction failure — two problems with opposite fixes, conflated.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  atomsCarrying,
  probesOf,
  resolveEvidence,
  runStampOf,
  sampleQuestions,
} from './funnel.mjs'

test('funnel: probes keep the specific values an answer turns on, case-folded', () => {
  const probes = probesOf('We pinned croniter 1.3.8 and the hash 9f2c1ab34de5, not version 2.0.1.')
  assert.ok(probes.includes('1.3.8'), 'a pinned dotted version is a probe')
  assert.ok(probes.includes('9f2c1ab34de5'), 'a long hex hash is a probe')
  assert.ok(probes.some((probe) => probe === 'croniter'), 'a long identifier is a probe')
  assert.equal(probes.every((probe) => probe === probe.toLowerCase()), true, 'probes are case-folded')
  assert.equal(new Set(probes).size, probes.length, 'probes are de-duplicated')
})

test('funnel: carrying atoms are matched by value, and no probe means no atoms', () => {
  const atoms = [
    { id: 'a', text: 'The project pinned croniter 1.3.8 in pyproject.toml.' },
    { id: 'b', text: 'We use Click for shell completion.' },
  ]
  const hit = atomsCarrying(atoms, ['1.3.8'])
  assert.deepEqual(hit.map((atom) => atom.id), ['a'], 'only the atom stating the value carries it')
  assert.deepEqual(atomsCarrying(atoms, []), [], 'an empty probe list cannot match everything')
})

test('funnel: evidence resolves through rawIndex, not the filtered turn list', () => {
  // The dataset's turn_index indexes the raw records; the conversation skips bookkeeping,
  // so the two indices diverge. Resolving through the filtered position lands on the
  // wrong turn, which is how an earlier harness lost track of most annotations.
  const sessions = new Map([
    ['session_001', {
      id: 'session_001',
      rawCount: 6,
      turns: [
        { role: 'user', text: 'first kept turn', rawIndex: 0 },
        { role: 'assistant', text: 'the labelled evidence', rawIndex: 3 },
      ],
    }],
  ])
  const question = { evidence: [{ session_id: 'session_001', turn_index: 3 }] }
  const { resolved, missing } = resolveEvidence(sessions, question)
  assert.deepEqual(resolved, ['the labelled evidence'], 'rawIndex 3 selects the labelled turn')
  assert.deepEqual(missing, [], 'nothing is reported missing')

  const outside = resolveEvidence(sessions, { evidence: [{ session_id: 'session_999', turn_index: 3 }] })
  assert.equal(outside.resolved.length, 0, 'an unknown session resolves nothing')
  assert.match(outside.missing[0], /session not in corpus/, 'and says why')

  const notATurn = resolveEvidence(sessions, { evidence: [{ session_id: 'session_001', turn_index: 4 }] })
  assert.equal(notATurn.resolved.length, 0, 'a raw index with no conversation turn resolves nothing')
  assert.match(notATurn.missing[0], /not a user\/assistant turn/, 'and says so')
})

test('funnel: the run stamp is read from the ISO shape, not by splitting on dashes', () => {
  // A naive split on '-' picks the wrong file when the project id itself has dashes, and
  // reporting a superseded run is how an earlier aggregation published stale numbers.
  assert.equal(
    runStampOf('project_01_cli_tool-2026-11-06T05-36-31-142Z.json'),
    '2026-11-06T05-36-31-142Z',
    'a project id with underscores still yields its stamp',
  )
  assert.equal(
    runStampOf('my-project-with-dashes-2026-11-06T05-36-31-142Z.json'),
    '2026-11-06T05-36-31-142Z',
    'a project id with dashes yields its stamp too',
  )
  assert.equal(runStampOf('notes.json'), null, 'a name with no stamp yields null')
})

test('funnel: the sample is deterministic and stable for the same seed', () => {
  const questions = Array.from({ length: 30 }, (_unused, index) => ({ id: `q${index}` }))
  const first = sampleQuestions(questions, 10).map((question) => question.id)
  const second = sampleQuestions([...questions].reverse(), 10).map((question) => question.id)
  assert.deepEqual(first, second, 'input order does not change the sample')
  assert.equal(first.length, 10, 'the limit is honoured')
  assert.equal(new Set(first).size, 10, 'the sample holds no duplicates')
})
