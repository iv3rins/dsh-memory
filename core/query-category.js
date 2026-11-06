/**
 * Query-side categories: what a *request* is about, and how it meets a stored atom.
 *
 * A measurement shaped this module. Asking `deriveCategories` for a question and for the
 * atom that answers it:
 *
 *   question "What version of croniter did we pin in pyproject.toml?"
 *     -> ["task:feature", "task:release"]        (what kind of work the sentence sounds like)
 *   atom     "The croniter dependency is pinned to 1.3.8 in pyproject.toml."
 *     -> ["dom:constraint"]                      (what kind of knowledge the atom is)
 *
 * They do not intersect, and they should not: the dimensions answer different questions.
 * Naively intersecting category ids therefore contributed nothing, and a naive
 * "any shared category" test would have matched on `task:feature` — the weakest possible
 * signal, since it is derived from the verb "pin".
 *
 * Two rules follow, and both are measured rather than assumed:
 *
 * 1. **Only the `mod` and `dom` dimensions vote.** A `task:` category describes the
 *    sentence's mood ("we will implement"), not its subject, and every request in a working
 *    session looks like `task:feature`.
 * 2. **An atom's `dom` category is compared against the request's `mod` category and vice
 *    versa.** A question naming `pyproject.toml` is `mod:core`; the atom answering it is
 *    `dom:storage`. That cross-dimensional pair is the signal that survives, because a
 *    question about a file usually wants knowledge *about* that file.
 *
 * Pure functions; no I/O, no clock.
 */

import { deriveCategories, CATEGORY_CATALOG } from './category.js'

/** Dimensions whose agreement carries routing signal. `task` is deliberately excluded. */
export const VOTING_DIMENSIONS = Object.freeze(['mod', 'dom'])

/** Category id to dimension, built once. */
const DIMENSION_OF = new Map(CATEGORY_CATALOG.map((entry) => [entry.id, entry.dimension]))

/**
 * The dimension of a category id.
 * @param {string} id - category id.
 * @returns {'mod'|'task'|'dom'|null} the dimension, or null when unknown.
 */
export function dimensionOf(id) {
  return DIMENSION_OF.get(id) ?? null
}

/**
 * Derive the categories of a request.
 *
 * @param {string} text - the request text.
 * @param {{ explicit?: string[] }} [options] - categories a caller named deliberately.
 * @returns {{ explicit: string[], inferred: string[], all: string[] }} the request's categories.
 */
export function queryCategories(text, options = {}) {
  const explicit = (options.explicit ?? []).filter((id) => DIMENSION_OF.has(id) && VOTING_DIMENSIONS.includes(DIMENSION_OF.get(id)))
  // The request is treated as a text surface: no kind, no tags, no files — those belong to
  // stored atoms, and inventing them would let a caller smuggle in a category.
  const inferredAll = deriveCategories({ kind: '', tags: [], files: [], text: String(text ?? '') }, { limit: 6 })
  const inferred = inferredAll.filter((id) => VOTING_DIMENSIONS.includes(DIMENSION_OF.get(id)) && explicit.includes(id) === false)
  return { explicit, inferred, all: [...new Set([...explicit, ...inferred])] }
}

/**
 * Build the category context the gate uses to score one atom.
 *
 * The atom's own categories are computed lazily and memoised per id, because a gate run
 * scores every live atom and re-deriving categories for all of them on every re-score
 * would dominate the cost of a step.
 *
 * @param {{ text: string, explicit?: string[] }} query - the request.
 * @param {{ cache?: Map<string, string[]> }} [options] - a cache shared across atoms.
 * @returns {{
 *   explicit: string[],
 *   inferred: string[],
 *   atomCategories: (atom: object) => string[],
 * }} the scoring context.
 */
export function categoryContext(query, options = {}) {
  // `query` is `{ text, explicit? }`, so the text and the explicit list travel separately.
  // Passing the object through as the text argument silently dropped every explicit
  // category, which made the "named category" weight unreachable.
  const text = typeof query === 'string' ? query : String(query?.text ?? '')
  const explicitFromQuery = Array.isArray(query?.explicit) ? query.explicit : []
  const { explicit, inferred } = queryCategories(text, {
    ...options,
    explicit: [...new Set([...(options.explicit ?? []), ...explicitFromQuery])],
  })
  const cache = options.cache ?? new Map()

  return {
    explicit,
    inferred,
    /**
     * The `mod`/`dom` categories of one atom.
     * @param {object} atom - stored atom.
     * @returns {string[]} its voting categories.
     */
    atomCategories: (atom) => {
      const key = typeof atom?.id === 'string' ? atom.id : null
      if (key !== null && cache.has(key)) return cache.get(key)
      const derived = deriveCategories(atom, { limit: 6 }).filter((id) => VOTING_DIMENSIONS.includes(DIMENSION_OF.get(id)))
      if (key !== null) cache.set(key, derived)
      return derived
    },
  }
}

/**
 * Whether an atom's categories agree with the request's, across dimensions.
 *
 * Kept as a named predicate so the rule is testable on its own: an `dom:` atom matches a
 * request whose `mod:` category names the same subsystem, and vice versa.
 *
 * @param {string[]} atomCategories - the atom's voting categories.
 * @param {{ explicit: string[], inferred: string[] }} query - the request's categories.
 * @returns {{ shared: string[], crossDimension: boolean }} the agreement.
 */
export function categoryAgreement(atomCategories, query) {
  const wanted = new Set([...query.explicit, ...query.inferred])
  const shared = atomCategories.filter((id) => wanted.has(id))
  return { shared, crossDimension: shared.length > 0 }
}
