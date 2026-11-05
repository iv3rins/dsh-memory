/**
 * Semantic categories: a stable, deterministic classification for memory atoms.
 *
 * Three decisions shape this module.
 *
 * 1. **Categories are derived, never guessed by a model.** An atom's categories are a
 *    pure function of its kind, tags, files and text, so the same statement always
 *    lands in the same buckets. A model-assigned category would drift between calls,
 *    and a drifting key cannot be used as a retrieval filter.
 * 2. **A category id is the only identity.** Colour lives in the UI and is looked up by
 *    id; nothing in this file decides relevance from a colour. Two atoms sharing a
 *    colour share a category by construction, but sharing a *colour* is never the test
 *    for sharing a memory — that inversion is the bug this constraint exists to prevent.
 * 3. **Multi-membership is normal.** One atom is often both `mod:core` and
 *    `dom:router`; the retrieval stage unions categories rather than picking one.
 *
 * Pure data + pure functions: no I/O, no config, no clock.
 */

/** Dimensions a category can belong to. A category id carries its dimension prefix. */
export const CATEGORY_DIMENSIONS = Object.freeze(['mod', 'task', 'dom'])

/** Hard cap on how many categories one atom may carry. */
export const MAX_ATOM_CATEGORIES = 6

/**
 * The catalog. Ids are permanent: `category_id` is stored on atoms and used as a
 * retrieval key, so renaming one orphans every memory that carries it.
 *
 * `color` is a *token name*, not an RGB value. The client resolves it against the
 * theme, which is what lets a category be styled without the host ever comparing
 * colour values.
 */
export const CATEGORY_CATALOG = Object.freeze([
  // --- module: where the work lives -------------------------------------------
  { id: 'mod:core', dimension: 'mod', label: 'core/', color: 'blue', keywords: ['core', 'gate', 'memory', 'store', 'state', 'config', 'indexer', 'extract'] },
  { id: 'mod:lib', dimension: 'mod', label: 'lib/', color: 'indigo', keywords: ['lib', 'router', 'recall', 'inject', 'delegate', 'panel', 'tools', 'commands'] },
  { id: 'mod:client', dimension: 'mod', label: 'client', color: 'violet', keywords: ['client', 'panel ui', 'react', 'css', 'slot', 'sidebar'] },
  { id: 'mod:tests', dimension: 'mod', label: 'tests/', color: 'teal', keywords: ['test', 'tests', 'assert', 'unit', 'regression', 'fixture'] },
  { id: 'mod:docs', dimension: 'mod', label: 'docs/', color: 'amber', keywords: ['doc', 'docs', 'readme', 'spec', 'adr', 'proposal'] },
  { id: 'mod:scripts', dimension: 'mod', label: 'scripts/', color: 'lime', keywords: ['script', 'scripts', 'migration', 'cli'] },

  // --- task: what kind of work the memory serves ------------------------------
  { id: 'task:bugfix', dimension: 'task', label: 'bugfix', color: 'red', keywords: ['fix', 'bug', 'repair', 'broken', 'regression', 'fails', 'failed', 'error'] },
  { id: 'task:feature', dimension: 'task', label: 'feature', color: 'green', keywords: ['add', 'implement', 'build', 'introduce', 'feature', 'support'] },
  { id: 'task:refactor', dimension: 'task', label: 'refactor', color: 'cyan', keywords: ['refactor', 'rename', 'split', 'extract', 'restructure', 'cleanup'] },
  { id: 'task:review', dimension: 'task', label: 'review', color: 'orange', keywords: ['review', 'audit', 'inspect', 'check', 'verify'] },
  { id: 'task:release', dimension: 'task', label: 'release', color: 'pink', keywords: ['release', 'version', 'publish', 'ship', 'changelog'] },

  // --- domain: what body of knowledge the memory belongs to --------------------
  { id: 'dom:constraint', dimension: 'dom', label: 'constraint', color: 'rose', keywords: ['must', 'never', 'always', 'required', 'forbidden', 'policy', 'rule'] },
  { id: 'dom:architecture', dimension: 'dom', label: 'architecture', color: 'slate', keywords: ['architecture', 'design', 'interface', 'contract', 'module', 'boundary'] },
  { id: 'dom:memory-routing', dimension: 'dom', label: 'memory routing', color: 'sky', keywords: ['memory', 'router', 'retrieval', 'recall', 'atom', 'category', 'lifecycle', 'digest'] },
  { id: 'dom:storage', dimension: 'dom', label: 'storage', color: 'stone', keywords: ['store', 'jsonl', 'database', 'sqlite', 'schema', 'migration', 'persist'] },
  { id: 'dom:ui', dimension: 'dom', label: 'ui', color: 'fuchsia', keywords: ['ui', 'panel', 'render', 'style', 'layout', 'view'] },
  { id: 'dom:process', dimension: 'dom', label: 'process', color: 'emerald', keywords: ['process', 'workflow', 'compaction', 'compact', 'session', 'handshake'] },
  { id: 'dom:general', dimension: 'dom', label: 'general', color: 'gray', keywords: [] },
])

/** Lookup index built once from the catalog. */
const BY_ID = new Map(CATEGORY_CATALOG.map((entry) => [entry.id, entry]))

/** Every valid category id. */
export const CATEGORY_IDS = Object.freeze(CATEGORY_CATALOG.map((entry) => entry.id))

/** The fallback category, always valid. */
export const DEFAULT_CATEGORY = 'dom:general'

/**
 * Kind → domain category. Kind is the strongest classification signal available,
 * because it is chosen deliberately when the atom is written.
 */
const KIND_DOMAIN = Object.freeze({
  constraint: 'dom:constraint',
  decision: 'dom:architecture',
  preference: 'dom:constraint',
  pitfall: 'dom:process',
  task: 'dom:process',
  summary: 'dom:process',
  fact: 'dom:general',
  question: 'dom:general',
})

/**
 * Whether a string is a known category id.
 * @param {unknown} value - candidate id.
 * @returns {boolean} true when the catalog knows it.
 */
export function isCategoryId(value) {
  return typeof value === 'string' && BY_ID.has(value)
}

/**
 * Resolve one category's display metadata.
 * @param {string} id - category id.
 * @returns {{ id: string, dimension: string, label: string, color: string } | null} the entry, or null.
 */
export function categoryInfo(id) {
  const entry = BY_ID.get(id)
  if (entry === undefined) return null
  return { id: entry.id, dimension: entry.dimension, label: entry.label, color: entry.color }
}

/**
 * Keep only known ids, de-duplicated, order-preserving, capped.
 *
 * Unknown ids are dropped rather than stored: an atom carrying a category that the
 * catalog does not define would be invisible to every category filter, which is
 * indistinguishable from having no category at all — and silently worse, because it
 * looks classified.
 *
 * @param {unknown} list - candidate ids.
 * @param {{ limit?: number }} [options] - cap override.
 * @returns {string[]} valid ids.
 */
export function normalizeCategories(list, options = {}) {
  const limit = Math.min(MAX_ATOM_CATEGORIES, Math.max(1, options.limit ?? MAX_ATOM_CATEGORIES))
  if (!Array.isArray(list)) return []
  const kept = []
  for (const value of list) {
    if (!isCategoryId(value)) continue
    if (kept.includes(value)) continue
    kept.push(value)
    if (kept.length >= limit) break
  }
  return kept
}

/** Lowercased word set of a string, roughly matching the gate's tokenizer intent. */
function words(text) {
  if (typeof text !== 'string' || text === '') return []
  return text.toLowerCase().split(/[^a-z0-9_]+/).filter((word) => word.length >= 3)
}

/** Add an id unless present or over the cap. */
function push(list, id, limit) {
  if (list.length >= limit) return
  if (!isCategoryId(id)) return
  if (list.includes(id)) return
  list.push(id)
}

/**
 * Derive the categories of one atom.
 *
 * Signals, in the order they are trusted: explicit `kind`, explicit `tags` that name a
 * category, file paths (they name a module), then keyword hits in the text. Every
 * signal is deterministic, so re-deriving never changes the answer for the same atom.
 *
 * @param {{ kind?: string, tags?: string[], files?: string[], text?: string }} atom - the atom.
 * @param {{ limit?: number }} [options] - cap override.
 * @returns {string[]} at least one category id.
 */
export function deriveCategories(atom, options = {}) {
  const limit = Math.min(MAX_ATOM_CATEGORIES, Math.max(1, options.limit ?? MAX_ATOM_CATEGORIES))
  const record = atom !== null && typeof atom === 'object' ? atom : {}
  const found = []

  // 1. An explicit category tag wins outright: the writer already knew the answer.
  if (Array.isArray(record.tags)) {
    for (const tag of record.tags) {
      if (isCategoryId(tag)) push(found, tag, limit)
    }
  }

  // 2. Kind is deliberate, so its domain outranks keyword guessing.
  const kind = typeof record.kind === 'string' ? record.kind : ''
  if (KIND_DOMAIN[kind] !== undefined) push(found, KIND_DOMAIN[kind], limit)

  // 3. File paths name a module directly.
  if (Array.isArray(record.files)) {
    for (const file of record.files) {
      if (typeof file !== 'string') continue
      const normalized = file.replace(/\\/g, '/').toLowerCase()
      const head = normalized.split('/')[0]
      const moduleId = `mod:${head}`
      if (head !== '' && isCategoryId(moduleId)) push(found, moduleId, limit)
    }
  }

  // 4. Keywords, counted so the strongest hit wins rather than the first in the text.
  const text = typeof record.text === 'string' ? record.text.toLowerCase() : ''
  if (text !== '') {
    const textWords = new Set(words(text))
    const scored = []
    for (const entry of CATEGORY_CATALOG) {
      if (entry.keywords.length === 0) continue
      let hits = 0
      for (const keyword of entry.keywords) {
        if (keyword.includes(' ') ? text.includes(keyword) : textWords.has(keyword)) hits += 1
      }
      if (hits > 0) scored.push({ id: entry.id, hits })
    }
    scored.sort((left, right) => right.hits - left.hits || left.id.localeCompare(right.id))
    for (const entry of scored) push(found, entry.id, limit)
  }

  if (found.length === 0) found.push(DEFAULT_CATEGORY)
  return found
}

/**
 * Resolve an atom's categories for reading.
 *
 * Stored `category_id` wins when present and valid, so a hand-corrected classification
 * survives; otherwise the categories are derived and never written back. That keeps the
 * upgrade read-only for existing stores — the same rule `resolveStanding` uses — so a
 * 400-atom `atoms.jsonl` needs no migration pass and no rewrite risk.
 *
 * @param {object} atom - stored or raw atom.
 * @param {{ persisted?: boolean }} [options] - `persisted` forces derivation to be skipped.
 * @returns {string[]} category ids.
 */
export function resolveCategories(atom) {
  const record = atom !== null && typeof atom === 'object' ? atom : {}
  const stored = normalizeCategories(record.category_id)
  if (stored.length > 0) return stored
  return deriveCategories(record)
}

/**
 * Group category ids by dimension, for display.
 * @param {string[]} ids - category ids.
 * @returns {{ mod: string[], task: string[], dom: string[] }} grouped ids.
 */
export function groupByDimension(ids) {
  const grouped = { mod: [], task: [], dom: [] }
  for (const id of normalizeCategories(ids)) {
    const info = categoryInfo(id)
    if (info === null) continue
    grouped[/** @type {'mod'|'task'|'dom'} */ (info.dimension)].push(id)
  }
  return grouped
}

/**
 * Expand a category selection into the set a candidate query should filter on.
 *
 * Used by retrieval: when a task intent names categories, the deterministic stage keeps
 * atoms in those categories *plus* whatever the gate ranked highly outside them, which
 * is what stops a mis-classified atom from becoming an invisible one.
 *
 * @param {unknown} selected - category ids from a task intent.
 * @returns {{ chosen: string[], empty: boolean }} the expanded selection.
 */
export function expandCategorySelection(selected) {
  const chosen = normalizeCategories(selected, { limit: CATEGORY_IDS.length })
  return { chosen, empty: chosen.length === 0 }
}
