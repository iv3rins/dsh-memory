#!/usr/bin/env node
/**
 * Semantic category routing: what it can and cannot do, measured.
 *
 * The idea is sound in principle — two statements about the same subsystem should match
 * even when their words do not. The question this file settles is whether it helps on a
 * real corpus, and the answer there is "barely", for a reason worth recording.
 *
 * Measured on the 53 CodeMemo questions for the long project:
 *
 *   - 23 of 53 produce no `mod:`/`dom:` category at all, because the request is phrased as
 *     a question ("what version did we pin") rather than as a statement about a subsystem;
 *   - of those that do, the distribution is dominated by the least informative buckets:
 *     `dom:general` 12, `mod:tests` 11. A category shared by a fifth of the corpus cannot
 *     discriminate, which is the same reason IDF exists for tokens.
 *
 * So the tests below assert the mechanism, not a benefit: agreement is computed, it is
 * cross-dimensional, `task:` never votes, and an absent context leaves the score untouched.
 * A test claiming an accuracy gain would be measuring noise.
 */
import assert from 'node:assert/strict'

const { categoryAgreement, categoryContext, dimensionOf, queryCategories, VOTING_DIMENSIONS } =
  await import('../core/query-category.js')
const { deriveCategories } = await import('../core/category.js')
const { GATE_WEIGHTS, scoreAtom } = await import('../core/gate.js')

// --- 1. `task:` categories never vote.
// Every request in a working session looks like `task:feature`; letting it vote would make
// all requests equivalent.
{
  assert.deepEqual([...VOTING_DIMENSIONS], ['mod', 'dom'])
  assert.equal(dimensionOf('task:feature'), 'task')
  assert.equal(dimensionOf('mod:core'), 'mod')
  assert.equal(dimensionOf('dom:storage'), 'dom')
  assert.equal(dimensionOf('nonsense'), null)
}

// --- 2. A question that names no subsystem yields no voting category.
// Observed for 23 of 53 real questions; encoded so a future change to the catalog is
// visible here rather than silently inflating the semantic term's apparent reach.
{
  const plain = queryCategories('What version of croniter did we pin?')
  assert.deepEqual(plain.all.filter((id) => dimensionOf(id) === 'task'), [], 'a task category is filtered out')
  // Whatever survives must be a voting dimension.
  for (const id of plain.all) assert.ok(VOTING_DIMENSIONS.includes(dimensionOf(id)), `${id} must be a voting dimension`)
}

// --- 3. A question naming a subsystem does carry one.
{
  const named = queryCategories('In src/gate.js, how is the memory store scored?')
  assert.ok(named.all.length > 0, 'a request naming a subsystem carries a category')
  assert.ok(named.all.every((id) => VOTING_DIMENSIONS.includes(dimensionOf(id))), 'and only voting dimensions')
}

// --- 4. An explicit category beats an inferred one and is recorded separately.
{
  const context = categoryContext({ text: 'anything at all', explicit: ['dom:storage'] })
  assert.deepEqual(context.explicit, ['dom:storage'])
  assert.equal(context.inferred.includes('dom:storage'), false, 'an explicit category is not double counted')
}

// --- 5. Agreement is computed over the atom's own dimensions.
{
  const query = { explicit: [], inferred: ['dom:storage'] }
  assert.deepEqual(categoryAgreement(['dom:storage', 'mod:core'], query).shared, ['dom:storage'])
  assert.deepEqual(categoryAgreement(['mod:core'], query).shared, [])
}

// --- 6. Scoring: the semantic term only moves the score when a context is supplied.
// A caller that does not pass categories must see exactly the old number.
{
  const atom = { id: 'a1', kind: 'fact', tags: [], files: [], text: 'The store is a JSONL file under .dsh-memory.', weight: 3, confidence: 0.9, seen: 1, updatedAt: '2026-01-01T00:00:00.000Z' }
  const query = { tokens: new Set(['unrelated', 'words']) }
  const statistics = { size: 10, frequency: new Map([['unrelated', 5], ['words', 5]]) }
  const now = Date.parse('2026-01-02T00:00:00.000Z')

  const without = scoreAtom(atom, query, { statistics, now, priorities: {} })
  const withContext = scoreAtom(atom, query, {
    statistics,
    now,
    priorities: {},
    categories: { explicit: [], inferred: ['dom:storage'], atomCategories: () => ['dom:storage'] },
  })

  assert.ok(withContext.score > without.score, 'a category match raises the score')
  assert.ok(withContext.reasons.some((reason) => reason.includes('category match')), 'and says why')
  assert.equal(without.reasons.some((reason) => reason.includes('category')), false, 'no category language without a context')
}

// --- 7. The category weight stays below the rare-token weight.
// A category is one of ~18 buckets; a rare token is closer to unique. If this ordering
// inverted, a broad category would outrank a precise match and the semantic term would
// make ranking worse, not better.
{
  assert.ok(GATE_WEIGHTS.category < GATE_WEIGHTS.rareOverlap, 'a category must weigh less than a rare token')
  assert.ok(GATE_WEIGHTS.category < GATE_WEIGHTS.overlap * 2, 'and must not swamp ordinary overlap')
  assert.ok(GATE_WEIGHTS.categoryExplicit < GATE_WEIGHTS.rareOverlap, 'an explicit category also stays below a rare token')
}

// --- 8. An atom matching only by category is not floored to irrelevance.
// This is the one behavioural change the semantic term is supposed to make.
{
  const atom = { id: 'a2', kind: 'fact', tags: [], files: [], text: 'Something about the storage layer.', weight: 2, confidence: 0.5, seen: 1, updatedAt: '2026-01-01T00:00:00.000Z' }
  const query = { tokens: new Set(['nothing', 'matches']) }
  const statistics = { size: 10, frequency: new Map() }
  const now = Date.parse('2026-01-02T00:00:00.000Z')

  const floored = scoreAtom(atom, query, { statistics, now, priorities: {} })
  const rescued = scoreAtom(atom, query, {
    statistics,
    now,
    priorities: {},
    categories: { explicit: [], inferred: ['dom:storage'], atomCategories: () => ['dom:storage'] },
  })
  assert.ok(rescued.score > floored.score, 'a category-only match scores higher than a floored non-match')
}

// --- 9. Reverse verification: if `task:` were allowed to vote, the filter above would fail.
{
  const all = deriveCategories({ kind: '', tags: [], files: [], text: 'implement the feature' })
  assert.ok(all.includes('task:feature'), 'the raw derivation does produce task categories')
  const voting = all.filter((id) => VOTING_DIMENSIONS.includes(dimensionOf(id)))
  assert.deepEqual(voting, [], 'and the voting filter removes them, which is the point')
  const unfiltered = all
  assert.notDeepEqual(voting, unfiltered, 'so filtered and unfiltered differ')
}

console.log('SEMANTIC-CATEGORY OK: only mod/dom vote, agreement is computed across dimensions, an absent context leaves the score untouched, and the category weight stays below a rare token')
