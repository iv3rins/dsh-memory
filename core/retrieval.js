/**
 * Two-stage retrieval with an optional task intent.
 *
 * Stage 1 is deterministic and cheap: scope, category, kind, status and priority narrow
 * the store to candidates. Stage 2 is the existing router subagent, which re-ranks those
 * candidates and may add atoms stage 1 missed.
 *
 * The design point that matters most is the **category supplement**. A deterministic
 * filter on `category_id` is only as good as the classification, and a mis-classified
 * atom would become invisible — the one failure mode the brief calls out by name ("分类
 * 错误是否导致信息丢失"). So stage 1 never returns *only* category matches: it always
 * reserves room for the highest-scoring atoms outside the chosen categories. A wrong
 * colour costs ranking, never a memory.
 *
 * Pure functions over an injected gate result. No model calls here.
 */

import { deriveCategories, resolveCategories, expandCategorySelection } from './category.js'
import { intentKinds, intentCategories } from './intent.js'
import { atomTokens } from './memory.js'
import { estimateTokens } from './context.js'
import { countersFor } from './lifecycle.js'

/** How much of the candidate set must come from outside the selected categories. */
export const CROSS_CATEGORY_SHARE = 0.35

/** Minimum number of outside-category candidates to keep, so the guarantee is real. */
export const CROSS_CATEGORY_MIN = 3

/**
 * Compute a dependency score per atom.
 *
 * "Depended upon" is approximated by how many other atoms mention this atom's distinctive
 * tokens. It is a cheap proxy, and it is deliberately bounded: the point is only to stop
 * a load-bearing atom from cooling before a decorative one.
 *
 * @param {object[]} atoms - live atoms.
 * @returns {Map<string, number>} id → normalised score in [0, 1].
 */
export function dependencyScores(atoms) {
  const scores = new Map()
  if (atoms.length < 2) {
    for (const atom of atoms) scores.set(atom.id, 0)
    return scores
  }
  const raw = new Map()
  for (const atom of atoms) {
    const tokens = new Set(atomTokens(atom).tokens)
    let referenced = 0
    for (const other of atoms) {
      if (other.id === atom.id) continue
      const otherTokens = atomTokens(other).tokens
      let shared = 0
      for (const token of tokens) {
        if (otherTokens.has(token)) shared += 1
        if (shared >= 3) break
      }
      if (shared >= 2) referenced += 1
    }
    raw.set(atom.id, referenced)
  }
  const max = Math.max(1, ...raw.values())
  for (const [id, value] of raw) scores.set(id, Math.min(1, value / max))
  return scores
}

/**
 * Stage 1: deterministic candidate recall.
 *
 * @param {{
 *   atoms: object[],
 *   counters?: Record<string, any>,
 *   intent?: object | null,
 *   gate: { selected: { atom: object, score: number }[], excluded: { atom: object, score: number }[] },
 *   limit: number,
 *   includeCold?: boolean,
 * }} input - recall inputs.
 * @returns {{
 *   candidates: { atom: object, score: number, category: string[], fromCategory: boolean }[],
 *   categories: string[],
 *   categoryHits: number,
 *   crossCategory: number,
 *   excludedByLifecycle: number,
 *   excludedByStatus: number,
 * }} the candidate set and what the filter did.
 */
export function recallCandidates(input) {
  const limit = Math.max(1, input.limit)
  const counters = input.counters ?? {}
  const intent = input.intent ?? null
  const { chosen } = expandCategorySelection(intent === null ? [] : intentCategories(intent))
  const wanted = new Set(chosen)
  const kinds = new Set(intentKinds(intent))

  // The gate's ordering is the deterministic ranking; excluded atoms keep their place
  // behind the selected ones. Atoms the gate never ranked at all (because it stopped at
  // its own limit) still have to be *considered*, otherwise a status exclusion on an
  // unranked atom would be invisible — and, worse, an atom the gate did not reach could
  // never be recalled even when the router would have asked for it.
  const ordered = [...input.gate.selected, ...input.gate.excluded]
  const ranked = new Set()
  for (const entry of ordered) {
    if (entry?.atom?.id !== undefined) ranked.add(entry.atom.id)
  }
  for (const atom of input.atoms ?? []) {
    if (atom?.id === undefined || ranked.has(atom.id)) continue
    ordered.push({ atom, score: 0 })
    ranked.add(atom.id)
  }
  const seen = new Set()
  const usable = []
  let excludedByLifecycle = 0
  let excludedByStatus = 0

  for (const entry of ordered) {
    const atom = entry?.atom
    if (atom?.id === undefined || seen.has(atom.id)) continue
    seen.add(atom.id)
    const current = countersFor(atom, counters)
    // Validity is a hard gate: a superseded or expired atom must not be injected even if
    // it matches perfectly. That separation from lifecycle is what the brief asks for.
    if (current.status !== 'active') {
      excludedByStatus += 1
      continue
    }
    if (current.tier === 'COLD' && input.includeCold !== true) {
      excludedByLifecycle += 1
      continue
    }
    usable.push({ atom, score: Number.isFinite(entry.score) ? entry.score : 0, tier: current.tier })
  }

  // Kind pre-selection from the intent: a request for "previous_errors" should see
  // pitfalls early, even when their wording does not overlap the summary.
  if (kinds.size > 0) {
    usable.sort((left, right) => {
      const leftKind = kinds.has(left.atom.kind) ? 1 : 0
      const rightKind = kinds.has(right.atom.kind) ? 1 : 0
      if (leftKind !== rightKind) return rightKind - leftKind
      return right.score - left.score
    })
  }

  /** @type {{ atom: object, score: number, category: string[], fromCategory: boolean }[]} */
  const inCategory = []
  const outsideCategory = []
  for (const entry of usable) {
    const category = resolveCategories(entry.atom)
    const matched = wanted.size === 0 ? false : category.some((id) => wanted.has(id))
    const item = { atom: entry.atom, score: entry.score, category, fromCategory: matched, tier: entry.tier }
    if (matched) inCategory.push(item)
    else outsideCategory.push(item)
  }

  // The cross-category supplement: a fixed share of the result must come from outside the
  // selected categories, so a wrong classification costs rank instead of losing memory.
  const reserve = wanted.size === 0 || input.crossCategorySupplement === false
    ? 0
    : Math.min(outsideCategory.length, Math.max(CROSS_CATEGORY_MIN, Math.floor(limit * CROSS_CATEGORY_SHARE)))
  const categoryBudget = Math.max(0, limit - reserve)
  const candidates = [...inCategory.slice(0, categoryBudget), ...outsideCategory.slice(0, Math.max(reserve, limit - Math.min(inCategory.length, categoryBudget)))]
  // Fill any remaining room from whichever side still has atoms.
  if (candidates.length < limit) {
    const taken = new Set(candidates.map((entry) => entry.atom.id))
    for (const entry of [...inCategory, ...outsideCategory]) {
      if (candidates.length >= limit) break
      if (taken.has(entry.atom.id)) continue
      candidates.push(entry)
      taken.add(entry.atom.id)
    }
  }

  return {
    candidates: candidates.slice(0, limit),
    categories: chosen,
    categoryHits: candidates.filter((entry) => entry.fromCategory).length,
    crossCategory: candidates.filter((entry) => entry.fromCategory !== true).length,
    excludedByLifecycle,
    excludedByStatus,
  }
}

/**
 * Seed categories for the whole store, for the panel and for a first run.
 * @param {object[]} atoms - live atoms.
 * @returns {Map<string, string[]>} id → categories.
 */
export function categoryIndex(atoms) {
  const index = new Map()
  for (const atom of atoms) index.set(atom.id, deriveCategories(atom))
  return index
}

/**
 * Count how often each category appears across a store.
 * @param {object[]} atoms - live atoms.
 * @returns {{ counts: Record<string, number>, atoms: number, uncategorized: number }} per-category counts.
 */
export function categoryCounts(atoms) {
  const counts = {}
  let uncategorized = 0
  for (const atom of atoms) {
    const categories = resolveCategories(atom)
    if (categories.length === 0) uncategorized += 1
    for (const id of categories) counts[id] = (counts[id] ?? 0) + 1
  }
  return { counts, atoms: atoms.length, uncategorized }
}

/**
 * Cross-category sensitivity: which atoms would be lost if classification were wrong.
 *
 * Answers the brief's "does a classification error cause information loss" question with
 * a number instead of an assurance: it lists high-scoring atoms whose categories do not
 * intersect a given selection. A non-trivial count is the concrete reason the supplement
 * reserve exists.
 *
 * @param {{ atoms: object[], categories: string[], gate: any }} input - the question.
 * @returns {{ atRisk: { id: string, score: number, category: string[] }[], total: number }} atoms a strict filter would drop.
 */
export function crossCategoryRisk(input) {
  const wanted = new Set(expandCategorySelection(input.categories).chosen)
  const ranked = [...(input.gate?.selected ?? []), ...(input.gate?.excluded ?? [])]
  const atRisk = []
  for (const entry of ranked) {
    const atom = entry?.atom
    if (atom?.id === undefined) continue
    const category = resolveCategories(atom)
    if (wanted.size > 0 && category.some((id) => wanted.has(id))) continue
    atRisk.push({ id: atom.id, score: entry.score ?? 0, category })
    if (atRisk.length >= 20) break
  }
  return { atRisk, total: atRisk.length }
}

/**
 * Estimate the token cost of a candidate set.
 * @param {object[]} atoms - atoms.
 * @returns {number} tokens.
 */
export function candidatesTokens(atoms) {
  return atoms.reduce((sum, atom) => sum + estimateTokens(atom?.text ?? ''), 0)
}
