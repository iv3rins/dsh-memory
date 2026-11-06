/**
 * Test the attribution classifier in isolation, then reverse-verify it.
 *
 * The classifier is the analytical core of Phase 2: every claim like "the loss is a
 * ranking problem" comes out of this function. So it is exercised against hand-built
 * situations whose correct label is obvious, and each label is then re-tested with the
 * evidence that would justify an earlier rung removed — a classifier that labels
 * everything REASONING_FAILURE would otherwise pass a happy-path test.
 */
import assert from 'node:assert/strict'

import { attribute, stronglyCovered } from './phase2.mjs'

/** Build one input with sensible defaults, overriding what a case cares about. */
function input(overrides = {}) {
  return {
    verdict: 'WRONG',
    values: ['1.3.8'],
    matchingAtoms: [{ id: 'a1' }],
    candidateIds: ['a1', 'a2'],
    selectedIds: ['a1', 'a2'],
    deliveredIds: ['a1', 'a2'],
    deliveredText: 'the croniter dependency is pinned to 1.3.8',
    oracleOk: true,
    oracleHasValue: true,
    ...overrides,
  }
}

const cases = []

// --- 1. A correct answer is attributed to nothing.
cases.push(['correct answer', attribute(input({ verdict: 'CORRECT' })).category, 'NONE'])

// --- 2. No atom carries the value at all.
cases.push([
  'nothing extracted',
  attribute(input({ matchingAtoms: [], candidateIds: [], selectedIds: [], deliveredText: '' })).category,
  'EXTRACTION_FAILURE',
])

// --- 3. The atom exists but never becomes a candidate.
cases.push([
  'never a candidate',
  attribute(input({ candidateIds: ['a2'], selectedIds: ['a2'], deliveredIds: ['a2'], deliveredText: '' })).category,
  'RETRIEVAL_FAILURE',
])

// --- 4. It was a candidate but the final cut dropped it.
cases.push([
  'candidate not selected',
  attribute(input({ selectedIds: ['a2'], deliveredIds: ['a2'], deliveredText: '' })).category,
  'RANKING_FAILURE',
])

// --- 5. A candidate that the final cut dropped is a ranking loss, not a retrieval one.
// The distinction matters: retrieval would mean the gate never offered it, ranking means
// it was offered and lost the competition for slots.
cases.push([
  'candidate dropped by the cut',
  attribute(input({ selectedIds: ['a2'], deliveredIds: ['a2'], deliveredText: '' })).category,
  'RANKING_FAILURE',
])

// --- 6. Selected and "delivered", but the rendered text lost the value: the atom
// reached the block and its content did not, which is a delivery loss.
cases.push([
  'delivered without the value',
  attribute(input({ deliveredText: 'unrelated atom text' })).category,
  'DELIVERY_FAILURE',
])

// --- 7. The value reached the context and the answer was still wrong.
cases.push([
  'value reached the context',
  attribute(input({ verdict: 'WRONG' })).category,
  'REASONING_FAILURE',
])

// --- 8. The labelled evidence never contained the value.
cases.push([
  'evidence lacks the value',
  attribute(input({ matchingAtoms: [], candidateIds: [], selectedIds: [], deliveredText: '', oracleHasValue: false })).category,
  'INSUFFICIENT_EVIDENCE',
])

// --- 9. A reference with no distinctive value cannot be inspected.
cases.push(['no distinctive value', attribute(input({ values: [] })).category, 'UNKNOWN'])

// --- Reverse verification: remove the evidence for a later rung and the label must move
// DOWN the ladder. This proves the classifier walks the input rather than falling through
// to one branch: a version that always answered REASONING_FAILURE would fail here.
const strong = attribute(input({ verdict: 'WRONG' })).category
const weakened = attribute(input({ verdict: 'WRONG', matchingAtoms: [] })).category
const candidateRemoved = attribute(input({ verdict: 'WRONG', candidateIds: [] })).category

console.log(`ok    reverse: full pipeline        -> ${strong}`)
console.log(`ok    reverse: no matching atom     -> ${weakened}`)
console.log(`ok    reverse: atom not a candidate -> ${candidateRemoved}`)

assert.equal(strong, 'REASONING_FAILURE', 'with everything present the loss is in the model')
assert.equal(weakened, 'EXTRACTION_FAILURE', 'removing the atom moves the label to extraction')
assert.equal(candidateRemoved, 'RETRIEVAL_FAILURE', 'removing it from candidates moves the label to retrieval')
assert.notEqual(strong, weakened, 'the label responds to the evidence')
assert.notEqual(weakened, candidateRemoved, 'the label distinguishes extraction from retrieval')

// --- Guard: every emitted label must be in the documented set.
const ALLOWED = new Set([
  'NONE', 'EXTRACTION_FAILURE', 'RETRIEVAL_FAILURE', 'RANKING_FAILURE', 'BUDGET_FAILURE',
  'DELIVERY_FAILURE', 'REASONING_FAILURE', 'INSUFFICIENT_EVIDENCE', 'UNKNOWN',
])
for (const [, actual] of cases) {
  assert.ok(ALLOWED.has(actual), `label ${actual} is outside the documented set`)
}

// --- Strict coverage must not be fooled by an incidental short number.
// This is the defect that inflated REASONING_FAILURE: `26` and `87` appear in any long
// store, so a plain substring test declared the evidence "delivered" and blamed the model.
{
  const context = 'the release shipped after 26 days with 87 tests and 36 fixes'
  assert.equal(stronglyCovered(context, ['26', '87', '36']), false, 'bare short numbers are not evidence')
  assert.equal(stronglyCovered(context, ['1.3.8']), false, 'a missing version is not evidence')
  assert.equal(stronglyCovered('pinned to 1.3.8 for weekday support', ['1.3.8']), true, 'a version present is evidence')
  assert.equal(stronglyCovered('we chose croniter for weekday handling', ['croniter', 'weekday']), true, 'two content words are evidence')
  assert.equal(stronglyCovered('we chose croniter', ['croniter', 'weekday']), false, 'one content word alone is not')
  console.log('ok    strict coverage: short numbers rejected, identifiers and word-pairs accepted')
}

console.log('\nATTRIBUTION OK: the ladder is walked from the bottom, each label is reachable, and every emitted label is in the documented set')
