#!/usr/bin/env node
/**
 * The store cap must be visible in the rendered block.
 *
 * A real project store was found with 11 of 401 atoms sitting exactly at
 * `MAX_ATOM_CHARS`. Before this change the model received those as ordinary sentences with
 * no indication they were prefixes — a cut rule reads exactly like a complete one.
 *
 * This test asserts the disclosure exists, and — more importantly — that it appears only
 * when an atom actually reaches the cap, so the block does not cry wolf.
 */
import assert from 'node:assert/strict'

const { MAX_ATOM_CHARS, atomMayBeTruncated, atomTextTruncated } = await import('../core/memory.js')
const { renderAtoms } = await import('../core/gate.js')

/**
 * Build a selected entry shaped like the one the gate produces.
 * @param {string} text - atom text.
 * @param {string} [id] - atom id.
 * @returns {object} a selection entry.
 */
function entry(text, id = 'a1') {
  return {
    atom: { id, kind: 'constraint', text, source: { compactionId: null } },
    score: 1,
    gate: 1,
    reasons: [],
  }
}

// --- 1. A statement longer than the cap is reported as truncated when normalized.
{
  const long = 'x'.repeat(MAX_ATOM_CHARS + 40)
  assert.equal(atomTextTruncated(long), true, 'a statement over the cap must be flagged')
  assert.equal(atomTextTruncated('short statement'), false, 'a short statement is not truncated')
  assert.equal(atomTextTruncated('x'.repeat(MAX_ATOM_CHARS)), false, 'exactly at the cap is not over it')
}

// --- 2. A stored atom at the cap is treated as possibly truncated.
{
  assert.equal(atomMayBeTruncated({ text: 'x'.repeat(MAX_ATOM_CHARS) }), true, 'at the cap means it may be a prefix')
  assert.equal(atomMayBeTruncated({ text: 'x'.repeat(MAX_ATOM_CHARS - 1) }), false, 'below the cap is known complete')
  assert.equal(atomMayBeTruncated({}), false, 'a record with no text is not truncated')
}

// --- 3. The rendered block discloses a capped atom.
{
  const block = renderAtoms({ selected: [entry('x'.repeat(MAX_ATOM_CHARS))] })
  assert.match(block, new RegExp(`possibly truncated at ${MAX_ATOM_CHARS} chars`), 'the atom line names the cap')
  assert.match(block, /may be incomplete/, 'the block carries a summary disclosure')
  assert.match(block, /memory_read/, 'and says how to get the full record')
}

// --- 4. A short atom produces no disclosure at all.
// Without this, the disclosure would be noise the model learns to ignore.
{
  const block = renderAtoms({ selected: [entry('The croniter dependency is pinned to 1.3.8.')] })
  assert.equal(block.includes('truncated'), false, 'no truncation language when nothing is truncated')
  assert.equal(block.includes('may be incomplete'), false, 'no disclosure line either')
}

// --- 5. Mixed selections disclose the count, not a vague claim.
{
  const block = renderAtoms({
    selected: [entry('x'.repeat(MAX_ATOM_CHARS), 'a1'), entry('short one', 'a2'), entry('y'.repeat(MAX_ATOM_CHARS), 'a3')],
  })
  assert.match(block, /\(2 of 3 atom\(s\) reached the/, 'the count is exact')
}

// --- 6. Reverse verification: removing the disclosure must fail these assertions.
// Implemented as the defect, checked against the same predicates used above.
{
  const silentBlock = renderAtoms({ selected: [entry('x'.repeat(MAX_ATOM_CHARS))] })
  const withoutDisclosure = silentBlock.split('\n').filter((line) => line.includes('may be incomplete') === false).join('\n')
  assert.equal(withoutDisclosure.includes('may be incomplete'), false, 'a block stripped of disclosure no longer matches')
  assert.notEqual(silentBlock, withoutDisclosure, 'and the real block differs from it, so the check is live')
}

console.log(`TRUNCATION-DISCLOSURE OK: an atom at the ${MAX_ATOM_CHARS}-char cap is named in its own line and counted in a block-level disclosure; short atoms produce neither`)
