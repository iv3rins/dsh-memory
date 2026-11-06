#!/usr/bin/env node
/**
 * Delivery integrity: the five states must be distinguishable, and `verified` must mean
 * "the value was found" rather than "the id was in a list".
 *
 * The case that motivates all of this: Phase 2 reported 13 rows as lost content. Replaying
 * them showed the block was byte-identical every time and every value was present. The
 * lesson is that a delivery check which reports a defect must itself be verified, so each
 * state here is exercised both ways — present, and deliberately removed.
 */
import assert from 'node:assert/strict'

const { DELIVERY_STATES, deliveryReport, isDistinctive, verifyDelivery } = await import('../core/delivery.js')

const liveAtoms = [
  { id: 'a1', text: 'The croniter dependency is pinned to 1.3.8 in pyproject.toml.' },
  { id: 'a2', text: 'Error messages follow the pattern Error: <noun> <verb> and exit with code 1.' },
  { id: 'a3', text: 'Rich rendering was batched with Group instead of per-line Console.print.' },
]

const recallBlock = liveAtoms.map((atom) => `- ${atom.text} [fact; score 1.00]`).join('\n')
const finalContext = `=== PROJECT NOTES (compacted) ===\ncroniter 1.3.8 pinned.\n\n${recallBlock}`

// --- 1. Distinctiveness: a common word proves nothing, an identifier does.
{
  assert.equal(isDistinctive('26'), false, 'a two-digit number is too common to prove anything')
  assert.equal(isDistinctive('the'), false, 'a stopword proves nothing')
  assert.equal(isDistinctive('1.3.8'), true, 'a version is distinctive')
  assert.equal(isDistinctive('test_platform_github'), true, 'an identifier is distinctive')
  assert.equal(isDistinctive('resolve_manifest_repo_dir'), true, 'a long snake_case name is distinctive')
  assert.equal(isDistinctive('priority'), false, 'a plain word is not')
}

// --- 2. A fully delivered atom is verified, and only then.
{
  const verdict = verifyDelivery({
    id: 'a1',
    selectedIds: ['a1', 'a2'],
    liveAtoms,
    recallBlock,
    finalContext,
    requiredValues: ['1.3.8', 'croniter'],
  })
  assert.equal(verdict.selected, true)
  assert.equal(verdict.resolved, true)
  assert.equal(verdict.rendered, true)
  assert.equal(verdict.delivered, true)
  assert.equal(verdict.evidence_verified, true)
  assert.equal(verdict.integrity, 'verified')
}

// --- 3. An atom selected by id but absent from the block is NOT verified.
// This is the "id delivered, content not" case the brief names.
{
  const verdict = verifyDelivery({
    id: 'a1',
    selectedIds: ['a1'],
    liveAtoms,
    recallBlock: '- something else entirely',
    finalContext: 'unrelated notes',
    requiredValues: ['1.3.8'],
  })
  assert.equal(verdict.selected, true, 'it was selected')
  assert.equal(verdict.rendered, false, 'but the renderer never emitted it')
  assert.equal(verdict.integrity, 'missing', 'so integrity is missing, not verified')
}

// --- 4. An atom whose expected value it never carried cannot be "verified".
// Reporting verified here would blame the wrong stage and hide a selection bug.
{
  const verdict = verifyDelivery({
    id: 'a2',
    selectedIds: ['a2'],
    liveAtoms,
    recallBlock,
    finalContext,
    requiredValues: ['1.3.8'],
  })
  assert.equal(verdict.evidence_verified, false)
  assert.equal(verdict.integrity, 'missing')
  assert.match(verdict.reason, /cannot be the source/)
}

// --- 5. Partial content is reported as partial, never rounded up to verified.
{
  const verdict = verifyDelivery({
    id: 'a1',
    selectedIds: ['a1'],
    liveAtoms,
    recallBlock,
    // The context drops the second value on purpose.
    finalContext: 'the pinned dependency is 1.3.8',
    requiredValues: ['1.3.8', 'pyproject.toml'],
  })
  assert.equal(verdict.integrity, 'partial', 'one of two values survived')
  assert.equal(verdict.evidence_verified, false)
  assert.deepEqual(verdict.missingValues, ['pyproject.toml'])
}

// --- 6. No distinctive value means no claim: unknown, not verified.
{
  const verdict = verifyDelivery({
    id: 'a3',
    selectedIds: ['a3'],
    liveAtoms,
    recallBlock,
    finalContext,
    requiredValues: ['the', 'was'],
  })
  assert.equal(verdict.evidence_verified, null, 'nothing checkable, so no assertion')
  assert.notEqual(verdict.integrity, 'verified', 'unknown must never read as verified')
  assert.equal(verdict.integrity, 'partial')
}

// --- 7. A missing id is missing, not silently skipped.
{
  const verdict = verifyDelivery({
    id: 'nope',
    selectedIds: ['nope'],
    liveAtoms,
    recallBlock,
    finalContext,
  })
  assert.equal(verdict.resolved, false)
  assert.equal(verdict.integrity, 'missing')
}

// --- 8. Report-level status must degrade as soon as one atom loses content.
{
  const healthy = deliveryReport({ selectedIds: ['a1'], liveAtoms, recallBlock, finalContext })
  assert.equal(healthy.delivery_status, 'partial', 'a1 is verified but a2/a3 were never selected')

  // Force one atom to lose its value: status must not stay success.
  const values = new Map([['a1', ['1.3.8']], ['a3', ['9.9.9']]])
  const dropped = deliveryReport({ selectedIds: ['a1', 'a3'], liveAtoms, recallBlock, finalContext, requiredValuesByAtom: values })
  assert.equal(dropped.perAtom.find((entry) => entry.id === 'a1').integrity, 'verified')
  assert.equal(dropped.perAtom.find((entry) => entry.id === 'a3').integrity, 'missing')
  assert.equal(dropped.delivery_status, 'degraded', 'one missing atom degrades the whole package')

  const empty = deliveryReport({ selectedIds: [], liveAtoms, recallBlock, finalContext })
  assert.equal(empty.delivery_status, 'empty')
}

// --- 9. The state list is the documented one, in order.
assert.deepEqual([...DELIVERY_STATES], ['selected', 'resolved', 'rendered', 'delivered', 'evidence_verified'])

// --- 10. Reverse verification: a check that always answers "verified" must fail here.
// Implement the defect deliberately and show the assertions above would catch it.
{
  const alwaysVerified = () => ({ integrity: 'verified', evidence_verified: true })
  const cheat = alwaysVerified()
  assert.notEqual(
    cheat.integrity,
    verifyDelivery({
      id: 'nope',
      selectedIds: ['nope'],
      liveAtoms,
      recallBlock,
      finalContext,
    }).integrity,
    'a verdict of verified for a missing id must differ from the real verdict',
  )
}

console.log('DELIVERY OK: selected/resolved/rendered/delivered/evidence_verified are distinguished, partial and unknown never read as verified, and a package degrades when one atom loses content')
