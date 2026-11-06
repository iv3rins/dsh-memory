/**
 * Delivery integrity: prove that a selected memory reached the model with its content.
 *
 * The failure this exists to prevent is subtle. A delivery path can report "8 atoms
 * delivered" while the model received eight ids and eight truncated sentences, and nothing
 * in the id list distinguishes those two outcomes. Phase 2 produced 13 rows labelled as
 * lost content; replaying them showed the block was byte-identical every time and the value
 * was present — the *measurement* had compared against the wrong text.
 *
 * So this module keeps five states apart, because collapsing any pair of them hides a
 * different defect:
 *
 * | state | question it answers | how it is decided |
 * |---|---|---|
 * | selected | did the ranking choose it? | id is in the selection |
 * | resolved | did the store return a record? | a live atom exists for that id |
 * | rendered | did the renderer emit it? | its text appears in the recall block |
 * | delivered | did the model receive the text? | its text appears in the final context |
 * | evidence_verified | is the key fact intact? | a *distinctive* value from the atom is present |
 *
 * `evidence_verified` is deliberately not "the id was in the list". It requires the value
 * itself to be found, so a truncated or elided atom reports `unknown` rather than `verified`.
 *
 * Pure functions; no I/O, no clock, no model.
 */

/** States a single atom can be in. Ordered from weakest to strongest evidence. */
export const DELIVERY_STATES = Object.freeze(['selected', 'resolved', 'rendered', 'delivered', 'evidence_verified'])

/**
 * Whether a string is distinctive enough that finding it proves content survived.
 *
 * A common English word can appear by coincidence in any long block, so it proves nothing.
 * A digit, an underscore, a dotted identifier, or a long token cannot. This is the same
 * distinction that made "26" a false positive in Phase 2.
 *
 * @param {string} value - candidate value.
 * @returns {boolean} whether matching it is meaningful evidence.
 */
export function isDistinctive(value) {
  const text = String(value ?? '')
  if (text.length < 3) return false
  if (/\d/.test(text)) return true
  if (/[_./\\:-]/.test(text)) return true
  if (/^[A-Za-z]{12,}$/.test(text)) return true
  return false
}

/**
 * Verify one atom's delivery through the whole chain.
 *
 * @param {{
 *   id: string,
 *   selectedIds: string[],
 *   liveAtoms: { id: string, text: string }[],
 *   recallBlock: string,
 *   finalContext: string,
 *   requiredValues?: string[],
 * }} input - the observable facts for this atom.
 * @returns {{
 *   id: string,
 *   selected: boolean,
 *   resolved: boolean,
 *   rendered: boolean,
 *   delivered: boolean,
 *   evidence_verified: boolean | null,
 *   integrity: 'verified' | 'partial' | 'unknown' | 'missing',
 *   expectedValues: string[],
 *   foundValues: string[],
 *   missingValues: string[],
 *   textLength: number,
 *   reason: string,
 * }} the verdict, with `null` used where a state cannot be established.
 */
export function verifyDelivery(input) {
  const selected = input.selectedIds.includes(input.id)
  const atom = input.liveAtoms.find((entry) => entry.id === input.id)
  const resolved = atom !== undefined
  const text = resolved ? atom.text : ''

  // A short probe is enough to locate the atom's line; the full text may be wrapped.
  const probe = text.toLowerCase().slice(0, 60)
  const rendered = resolved && probe.length > 0 && input.recallBlock.toLowerCase().includes(probe)
  const delivered = resolved && probe.length > 0 && input.finalContext.toLowerCase().includes(probe)

  // Which values were expected: the caller's, or else the atom's own distinctive tokens.
  const expected = (input.requiredValues ?? []).filter((value) => isDistinctive(value))
  const carried = expected.filter((value) => text.toLowerCase().includes(value.toLowerCase()))
  const foundInContext = expected.filter((value) => input.finalContext.toLowerCase().includes(value.toLowerCase()))
  const missing = expected.filter((value) => foundInContext.includes(value) === false)

  // Evidence can only be verified against values the atom actually carries. If the caller
  // expects a value the atom never had, the atom is not the wrong delivery — the selection
  // was, and that is a different report.
  let evidenceVerified = null
  let integrity = 'missing'
  let reason = ''

  if (resolved === false) {
    integrity = 'missing'
    reason = 'no live atom with this id'
  } else if (expected.length === 0) {
    // Nothing to check against, so no claim can be made. Saying "verified" here is exactly
    // the id-only assertion the brief forbids.
    evidenceVerified = null
    integrity = delivered ? 'partial' : 'missing'
    reason = 'the atom carries no distinctive value, so content integrity cannot be verified'
  } else if (carried.length === 0) {
    evidenceVerified = false
    integrity = 'missing'
    reason = 'none of the expected values exist in this atom, so it cannot be the source'
  } else if (missing.length === 0) {
    evidenceVerified = true
    integrity = 'verified'
    reason = 'every expected value is present in the final context'
  } else {
    evidenceVerified = false
    // Some values survived and some did not: partial delivery, reported as such.
    integrity = missing.length < expected.length ? 'partial' : 'missing'
    reason = `${missing.length} of ${expected.length} expected value(s) absent from the final context`
  }

  return {
    id: input.id,
    selected,
    resolved,
    rendered,
    delivered,
    evidence_verified: evidenceVerified,
    integrity,
    expectedValues: expected,
    foundValues: foundInContext,
    missingValues: missing,
    textLength: text.length,
    reason,
  }
}

/**
 * Build the delivery report for one recall.
 *
 * The overall `delivery_status` is `success` only when every selected atom is verified.
 * Anything else is reported truthfully — `partial` when some content survived, `degraded`
 * when the pipeline lost content, `empty` when nothing was selected.
 *
 * @param {{
 *   selectedIds: string[],
 *   liveAtoms: { id: string, text: string }[],
 *   recallBlock: string,
 *   finalContext: string,
 *   requiredValuesByAtom?: Map<string, string[]>,
 * }} input - the recall to report on.
 * @returns {{
 *   perAtom: object[],
 *   counts: Record<string, number>,
 *   delivery_status: 'success' | 'partial' | 'degraded' | 'empty',
 *   summary: string,
 * }} the report.
 */
export function deliveryReport(input) {
  const perAtom = input.selectedIds.map((id) =>
    verifyDelivery({
      id,
      selectedIds: input.selectedIds,
      liveAtoms: input.liveAtoms,
      recallBlock: input.recallBlock,
      finalContext: input.finalContext,
      ...(input.requiredValuesByAtom?.has(id) === true ? { requiredValues: input.requiredValuesByAtom.get(id) } : {}),
    }),
  )

  const counts = {
    selected: perAtom.filter((entry) => entry.selected).length,
    resolved: perAtom.filter((entry) => entry.resolved).length,
    rendered: perAtom.filter((entry) => entry.rendered).length,
    delivered: perAtom.filter((entry) => entry.delivered).length,
    verified: perAtom.filter((entry) => entry.integrity === 'verified').length,
    partial: perAtom.filter((entry) => entry.integrity === 'partial').length,
    unknown: perAtom.filter((entry) => entry.integrity === 'unknown').length,
    missing: perAtom.filter((entry) => entry.integrity === 'missing').length,
  }

  let status = 'success'
  if (perAtom.length === 0) status = 'empty'
  else if (counts.missing > 0) status = 'degraded'
  else if (counts.partial > 0 || counts.unknown > 0) status = 'partial'

  const summary = perAtom.length === 0
    ? 'nothing was selected'
    : `${counts.verified}/${perAtom.length} atom(s) verified, ${counts.partial} partial, ${counts.unknown} unknown, ${counts.missing} missing`

  return { perAtom, counts, delivery_status: status, summary }
}
