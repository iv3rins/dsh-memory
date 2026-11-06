/**
 * Task Intent: the structured request a main model sends when it wants memory.
 *
 * The protocol exists so retrieval has a **query with fields** instead of a guess made
 * from whatever text happened to be in the last message. That is the difference between
 * "find atoms whose words overlap this paragraph" and "find constraints and past errors
 * that govern `auth`, for a bugfix, within 2000 tokens".
 *
 * Two boundaries hold the design together:
 *
 * - **The intent is a request, not an instruction to the main model.** A router reads it
 *   and answers with memory; it never gains the right to decide what the task is. So an
 *   intent is validated, bounded, and never carries an action.
 * - **A malformed intent degrades, it does not fail.** The caller falls back to the
 *   text-derived query, which is the pre-existing behaviour. An upgrade that can lose a
 *   turn is worse than the thing it replaced.
 *
 * Pure data + pure functions.
 */

import { CATEGORY_IDS, normalizeCategories } from './category.js'

/** Operations a task intent may name. Closed set: an unknown operation is not a filter. */
export const TASK_OPERATIONS = Object.freeze(['bugfix', 'feature', 'refactor', 'review', 'release', 'explain', 'other'])

/** Memory-need kinds a main model can ask for. */
export const MEMORY_NEEDS = Object.freeze([
  'historical_constraints',
  'architecture_decisions',
  'previous_errors',
  'conventions',
  'recent_changes',
  'open_questions',
])

/** Token ceiling bounds for one intent's `max_memory_tokens`. */
export const INTENT_MIN_TOKENS = 100
export const INTENT_MAX_TOKENS = 8000

/** A task summary is a line, not a paragraph. */
export const MAX_TASK_SUMMARY_CHARS = 300

/** How many module / need entries are honoured. */
export const MAX_INTENT_MODULES = 12
export const MAX_INTENT_NEEDS = 6

/** Map a memory need to the atom kinds it should pre-select. Pure data. */
export const NEED_TO_KINDS = Object.freeze({
  historical_constraints: ['constraint', 'preference'],
  architecture_decisions: ['decision'],
  previous_errors: ['pitfall'],
  conventions: ['constraint', 'preference', 'decision'],
  recent_changes: ['summary', 'task'],
  open_questions: ['question'],
})

/** Map an operation to the task category it implies. */
const OPERATION_CATEGORY = Object.freeze({
  bugfix: 'task:bugfix',
  feature: 'task:feature',
  refactor: 'task:refactor',
  review: 'task:review',
  release: 'task:release',
  explain: 'task:review',
  other: null,
})

/** Trim to a bounded single line. */
function oneLine(value, limit) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, limit)
}

/** Lowercase module token, stripped of noise. */
function moduleName(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\\/g, '/').trim().toLowerCase().replace(/^\.\//, '').replace(/\/+$/, '').slice(0, 40)
}

/**
 * Normalize one task intent.
 *
 * Unknown fields are dropped rather than kept: an intent is sent to a model, and an
 * attacker-shaped extra field would otherwise ride along into the router prompt.
 *
 * @param {unknown} raw - candidate intent from a tool call or an event.
 * @param {{ now?: string, maxMemoryTokensFallback?: number }} [options] - defaults.
 * @returns {{ ok: true, intent: { taskSummary: string, projectId: string, affectedModules: string[], operation: string, memoryNeeds: string[], categories: string[], maxMemoryTokens: number, createdAt: string } }
 *   | { ok: false, reason: string }} the normalized intent.
 */
export function normalizeTaskIntent(raw, options = {}) {
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'a task intent must be an object' }
  /** @type {any} */
  const record = raw
  const taskSummary = oneLine(record.task_summary ?? record.taskSummary, MAX_TASK_SUMMARY_CHARS)
  if (taskSummary === '') return { ok: false, reason: 'task_summary is required: it is the only field the router cannot guess' }

  const operationRaw = oneLine(record.operation, 20).toLowerCase()
  const operation = TASK_OPERATIONS.includes(operationRaw) ? operationRaw : 'other'

  const modules = []
  for (const value of Array.isArray(record.affected_modules) ? record.affected_modules : []) {
    const name = moduleName(value)
    if (name === '' || modules.includes(name)) continue
    modules.push(name)
    if (modules.length >= MAX_INTENT_MODULES) break
  }

  const needs = []
  for (const value of Array.isArray(record.memory_needs) ? record.memory_needs : []) {
    const need = oneLine(value, 40).toLowerCase()
    if (!MEMORY_NEEDS.includes(need) || needs.includes(need)) continue
    needs.push(need)
    if (needs.length >= MAX_INTENT_NEEDS) break
  }

  // Categories may be named explicitly; an intent may also omit them, in which case the
  // operation and modules imply them below.
  const explicit = normalizeCategories(record.categories, { limit: CATEGORY_IDS.length })

  const tokensRaw = record.max_memory_tokens ?? record.maxMemoryTokens
  const parsedTokens = typeof tokensRaw === 'number' ? tokensRaw : Number(tokensRaw)
  const fallback = Number.isFinite(options.maxMemoryTokensFallback) ? options.maxMemoryTokensFallback : 2000
  const maxMemoryTokens = Number.isFinite(parsedTokens)
    ? Math.min(INTENT_MAX_TOKENS, Math.max(INTENT_MIN_TOKENS, Math.trunc(parsedTokens)))
    : fallback

  return {
    ok: true,
    intent: {
      taskSummary,
      projectId: oneLine(record.project_id ?? record.projectId ?? 'current', 80) || 'current',
      affectedModules: modules,
      operation,
      memoryNeeds: needs,
      categories: explicit,
      maxMemoryTokens,
      createdAt: typeof options.now === 'string' ? options.now : new Date().toISOString(),
    },
  }
}

/**
 * Derive the categories a task intent implies.
 *
 * Explicit categories win. Otherwise the operation names a task category and each module
 * names a module category. This is what lets a router start from a semantic colour rather
 * than from full-text search, without a model having to know the catalog.
 *
 * @param {object} intent - a normalized intent.
 * @returns {string[]} category ids.
 */
export function intentCategories(intent) {
  const explicit = normalizeCategories(intent?.categories, { limit: CATEGORY_IDS.length })
  if (explicit.length > 0) return explicit
  const derived = []
  const operation = OPERATION_CATEGORY[intent?.operation]
  if (typeof operation === 'string' && operation !== null) derived.push(operation)
  for (const name of Array.isArray(intent?.affectedModules) ? intent.affectedModules : []) {
    const id = `mod:${name.split('/')[0]}`
    if (CATEGORY_IDS.includes(id) && !derived.includes(id)) derived.push(id)
  }
  // A memory-need always implies a domain, because "give me constraints" is a statement
  // about what kind of knowledge is wanted, regardless of module.
  for (const need of Array.isArray(intent?.memoryNeeds) ? intent.memoryNeeds : []) {
    const kinds = NEED_TO_KINDS[need]
    if (kinds === undefined) continue
    if (kinds.includes('constraint') && !derived.includes('dom:constraint')) derived.push('dom:constraint')
    if (kinds.includes('decision') && !derived.includes('dom:architecture')) derived.push('dom:architecture')
    if (kinds.includes('pitfall') && !derived.includes('dom:process')) derived.push('dom:process')
  }
  return derived
}

/**
 * The atom kinds an intent pre-selects.
 * @param {object} intent - a normalized intent.
 * @returns {string[]} kind names, possibly empty.
 */
export function intentKinds(intent) {
  const kinds = []
  for (const need of Array.isArray(intent?.memoryNeeds) ? intent.memoryNeeds : []) {
    for (const kind of NEED_TO_KINDS[need] ?? []) {
      if (!kinds.includes(kind)) kinds.push(kind)
    }
  }
  return kinds
}

/**
 * Render the text a deterministic gate should match against.
 *
 * The summary carries the task; modules and needs add vocabulary that appears in the
 * atoms but not in a terse summary. Joining them is what makes the first-stage recall
 * meaningfully better than matching the raw user message.
 *
 * @param {object} intent - a normalized intent.
 * @returns {string} query text.
 */
export function intentQueryText(intent) {
  const parts = [intent?.taskSummary ?? '']
  if (Array.isArray(intent?.affectedModules) && intent.affectedModules.length > 0) {
    parts.push(intent.affectedModules.join(' '))
  }
  if (Array.isArray(intent?.memoryNeeds) && intent.memoryNeeds.length > 0) {
    parts.push(intent.memoryNeeds.join(' ').replace(/_/g, ' '))
  }
  return parts.filter((part) => typeof part === 'string' && part !== '').join('\n')
}

/**
 * Build the cache key for an intent decision.
 *
 * The key must change whenever a cached decision could be wrong, and must not change for
 * anything else — a cache that misses constantly is a cache that only costs.
 *
 * Four inputs, each load-bearing:
 *
 * - `projectId` — cross-project reuse is forbidden outright, not merely discouraged.
 * - the intent, canonicalised — same task, same categories, same budget.
 * - `memoryVersion` — a counter bumped whenever the store changes, so a new atom
 *   invalidates every decision made before it existed.
 * - `scope` — the resolved project root, so two checkouts of the same project id cannot
 *   share a decision.
 *
 * @param {{ projectId: string, intent: object, memoryVersion: number | string, scope: string }} input - key inputs.
 * @returns {string} a stable key.
 */
export function intentCacheKey(input) {
  const canonical = {
    projectId: String(input.projectId ?? ''),
    scope: String(input.scope ?? ''),
    memoryVersion: String(input.memoryVersion ?? ''),
    intent: {
      taskSummary: String(input.intent?.taskSummary ?? ''),
      projectId: String(input.intent?.projectId ?? ''),
      affectedModules: [...(input.intent?.affectedModules ?? [])].sort(),
      operation: String(input.intent?.operation ?? ''),
      memoryNeeds: [...(input.intent?.memoryNeeds ?? [])].sort(),
      categories: [...(input.intent?.categories ?? [])].sort(),
      maxMemoryTokens: Number(input.intent?.maxMemoryTokens ?? 0),
    },
  }
  return JSON.stringify(canonical)
}

/**
 * Decide whether a cached decision may still be used.
 *
 * A cache entry is reused only when every input still matches *and* the entry has not
 * aged past `maxAgeMs`. Age is included because a decision made from a store that has
 * since been compacted is not observably different by key alone when the version counter
 * is unavailable — an explicit age bound makes the worst case a re-run, not a wrong answer.
 *
 * @param {{ entry: object | undefined, key: string, now: number, maxAgeMs: number }} input - validation inputs.
 * @returns {{ hit: boolean, reason: string }} the verdict.
 */
export function validateIntentCache(input) {
  const { entry, key, now } = input
  if (entry === undefined || entry === null) return { hit: false, reason: 'no cached decision' }
  if (entry.key !== key) return { hit: false, reason: 'the task intent, memory version or scope changed' }
  const age = now - (Number.isFinite(entry.at) ? entry.at : 0)
  if (age > input.maxAgeMs) return { hit: false, reason: `the cached decision aged out (${Math.round(age / 1000)}s > ${Math.round(input.maxAgeMs / 1000)}s)` }
  // A compaction invalidates the decision because it can rewrite the store between the
  // decision and its reuse. The field is optional: an entry that never observed a
  // compaction is not stale, so only a *present and different* version counts.
  if (entry.compactionVersion !== undefined && entry.compactionVersion !== entry.memoryVersion) {
    return { hit: false, reason: 'the store was compacted after this decision was cached' }
  }
  return { hit: true, reason: `cached ${Math.round(age / 1000)}s ago` }
}

/**
 * Summarize an intent for a log line or the panel.
 * @param {object} intent - normalized intent.
 * @returns {string} one line.
 */
export function describeIntent(intent) {
  if (intent === null || typeof intent !== 'object') return 'no task intent'
  const parts = [intent.taskSummary ?? '']
  if (intent.operation !== undefined) parts.push(`op ${intent.operation}`)
  if (Array.isArray(intent.affectedModules) && intent.affectedModules.length > 0) parts.push(`modules ${intent.affectedModules.join(',')}`)
  if (Array.isArray(intent.memoryNeeds) && intent.memoryNeeds.length > 0) parts.push(`needs ${intent.memoryNeeds.join(',')}`)
  parts.push(`≤${intent.maxMemoryTokens} tokens`)
  return parts.filter((part) => part !== '').join('; ')
}
