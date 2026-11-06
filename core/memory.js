/**
 * System C — durable memory atoms.
 *
 * Systems A and B describe the *project*: documents and development state. This
 * system describes the *session history* that compaction is about to discard.
 * When the harness compacts a conversation it replaces the shadowed span with a
 * summary and the original turns are gone; anything the summary omitted is lost
 * for the rest of that session. Atoms are the counter-measure: small, deduplicated,
 * independently addressable statements that survive compaction and can be
 * re-selected later.
 *
 * Three properties make them safe to inject:
 *
 * - **Content identity** — an atom's id is the hash of its kind and normalized
 *   text, so re-extracting the same fact twice merges instead of duplicating.
 * - **Atomic replacement** — the store is rewritten in one rename under a lock,
 *   so a reader sees the whole previous file or the whole next one.
 * - **Tombstones** — a forgotten atom keeps its id on disk as `forgotten: true`,
 *   so a later extraction pass cannot silently resurrect material the user
 *   removed.
 *
 * Pure Node; no DSH import.
 */

import path from 'node:path'
import { createHash } from 'node:crypto'
import { MEMORY_DIR } from './paths.js'
import { readText, writeTextAtomic, withLock } from './store.js'
import { tokenize } from './search.js'
import { stableStringify } from './state.js'
import { normalizeCategories, resolveCategories } from './category.js'

/** Schema version for one atom record. */
export const MEMORY_SCHEMA = 1

/** Files this module owns inside `.dsh-memory`. */
export const MEMORY_STORE_DIR = `${MEMORY_DIR}/memory`
export const ATOMS_FILE = `${MEMORY_STORE_DIR}/atoms.jsonl`
export const MEMORY_LOCK_FILE = `${MEMORY_STORE_DIR}/.lock`

/** Upper bound on retained records (live atoms plus tombstones). */
export const MAX_ATOM_RECORDS = 1200

/** Upper bound on live atoms after pruning. */
export const MAX_LIVE_ATOMS = 400

/** A single atom is a statement, not a paragraph. */
export const MAX_ATOM_CHARS = 480

/** Kinds an atom can carry; anything else degrades to `fact`. */
export const ATOM_KINDS = Object.freeze([
  'constraint',
  'decision',
  'fact',
  'task',
  'preference',
  'pitfall',
  'summary',
  'question',
])

/** Kinds privileged when scores tie, because losing them costs the most. */
export const KIND_PRIORITY = Object.freeze({
  constraint: 5,
  decision: 4,
  preference: 3,
  pitfall: 3,
  task: 2,
  fact: 1,
  summary: 1,
  question: 1,
})

/**
 * Kinds that may carry standing status — the right to be kept even when unrelated.
 *
 * Standing is a safety property: a hard rule that is dropped because the current
 * request's words do not match it is exactly the moment it gets violated. That is a
 * different question from how important the rule is, which is why the two are stored
 * separately.
 */
export const STANDING_KINDS = Object.freeze(['constraint'])

/**
 * Resolve whether an atom carries standing status.
 *
 * Two inputs, deliberately not three:
 *
 * - An explicit `standing` boolean on the record wins. That is how a caller says
 *   "keep this regardless" (and how it says "no").
 * - Otherwise a `STANDING_KINDS` atom is standing. Constraints are the rules a step
 *   must not break, so they default to standing.
 *
 * **`weight` is not consulted.** Importance and standing used to be fused through
 * `weight >= 4`, which meant a genuine rule recorded at the neutral default silently
 * lost its hard-rule status — 43 of 136 atoms in this project's own store were in
 * exactly that state. Raising their weights would have hidden the confusion rather
 * than fixed it; importance would still be deciding a safety question.
 *
 * This is a read-time rule, so existing `atoms.jsonl` files need no migration: old
 * constraints become standing on the next read, and nothing on disk is rewritten.
 *
 * @param {string} kind - the atom's kind.
 * @param {{ standing?: unknown }} record - the raw or stored record.
 * @returns {boolean} whether the atom is standing.
 */
export function resolveStanding(kind, record) {
  if (record !== null && typeof record === 'object' && typeof record.standing === 'boolean') return record.standing
  return STANDING_KINDS.includes(kind)
}

/**
 * Collapse whitespace and bound the length of one atom statement.
 *
 * The bound is a hard cap and this function silently applies it, which is correct for a
 * normalizer but wrong as the *only* place the cap exists: a statement longer than
 * `MAX_ATOM_CHARS` is stored as a prefix, and nothing downstream can tell a short fact from
 * a truncated one. A real project store was found with 11 of 401 atoms sitting exactly at
 * the cap. `atomTextTruncated` exists so callers can say so; see `renderAtoms`.
 *
 * @param {unknown} value - candidate text.
 * @returns {string} normalized text, or an empty string.
 */
export function normalizeAtomText(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_ATOM_CHARS)
}

/**
 * Whether a statement had to be cut to fit the atom cap.
 *
 * Reported rather than acted on: the cap protects the store's density, and a longer record
 * belongs in a document. What must not happen is silent loss of a fact that the model then
 * treats as complete.
 *
 * @param {unknown} value - the original statement, before normalization.
 * @returns {boolean} whether storing it would drop characters.
 */
export function atomTextTruncated(value) {
  if (typeof value !== 'string') return false
  return value.replace(/\s+/g, ' ').trim().length > MAX_ATOM_CHARS
}

/**
 * Whether a stored atom's text sits at the cap, and therefore may be a prefix.
 *
 * A stored string cannot be distinguished from a truncated one except by its length, so a
 * text exactly at the cap is treated as "possibly truncated" and rendered as such. Atoms
 * shorter than the cap are known complete.
 *
 * @param {{ text?: string }} atom - a stored atom.
 * @returns {boolean} whether the text may have been cut.
 */
export function atomMayBeTruncated(atom) {
  return typeof atom?.text === 'string' && atom.text.length >= MAX_ATOM_CHARS
}

/**
 * Derive the content identity of an atom.
 *
 * Identity is the hash of kind plus normalized text, so the same statement
 * extracted twice — from a compaction summary this session and from a tool
 * result next session — converges on one record instead of two.
 *
 * @param {string} kind - atom kind.
 * @param {string} text - normalized statement.
 * @returns {string} 16 hex characters.
 */
export function atomId(kind, text) {
  return createHash('sha256').update(`${kind}\u0000${normalizeAtomText(text).toLowerCase()}`).digest('hex').slice(0, 16)
}

/** Deduplicate a list of short strings, preserving order. */
function uniqueStrings(list, limit) {
  const seen = new Set()
  const result = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const value = entry.replace(/\\/g, '/').trim()
    if (value === '') continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
    if (result.length >= limit) break
  }
  return result
}

/** Accept a finite number inside an inclusive range. */
function clamp(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Later of two ISO timestamps, tolerating nulls. */
function laterTimestamp(left, right) {
  if (typeof left !== 'string') return typeof right === 'string' ? right : null
  if (typeof right !== 'string') return left
  return left >= right ? left : right
}

/**
 * Coerce an untrusted record into a schema-valid atom.
 *
 * Atoms come from a model, from a compaction summary, or from disk after a
 * crash, so shape assumptions are enforced rather than trusted.
 *
 * @param {unknown} raw - candidate record.
 * @param {{ now?: string }} [options] - clock override for deterministic tests.
 * @returns {object | null} a normalized atom, or null when there is nothing to store.
 */
export function normalizeAtom(raw, options = {}) {
  if (raw === null || typeof raw !== 'object') return null
  /** @type {any} */
  const record = raw
  const kind = ATOM_KINDS.includes(record.kind) ? record.kind : 'fact'
  const text = normalizeAtomText(record.text)
  if (text === '') return null
  const now = options.now ?? new Date().toISOString()
  const createdAt = typeof record.createdAt === 'string' && record.createdAt !== '' ? record.createdAt : now
  const source = record.source !== null && typeof record.source === 'object' ? record.source : {}
  return {
    schema: MEMORY_SCHEMA,
    id: atomId(kind, text),
    kind,
    text,
    tags: uniqueStrings(Array.isArray(record.tags) ? record.tags : [], 12),
    files: uniqueStrings(Array.isArray(record.files) ? record.files : [], 12).slice(0, 12),
    category_id: normalizeCategories(record.category_id),
    weight: Math.round(clamp(record.weight, 2, 1, 5)),
    confidence: Math.round(clamp(record.confidence, 0.5, 0, 1) * 100) / 100,
    standing: resolveStanding(kind, record),
    seen: Math.round(clamp(record.seen, 1, 1, 100000)),
    createdAt,
    updatedAt: typeof record.updatedAt === 'string' && record.updatedAt !== '' ? record.updatedAt : createdAt,
    source: {
      sessionId: typeof source.sessionId === 'string' ? source.sessionId : null,
      compactionId: typeof source.compactionId === 'string' ? source.compactionId : null,
      seq: Number.isSafeInteger(source.seq) ? source.seq : null,
    },
    forgotten: record.forgotten === true,
  }
}

/**
 * Merge a fresh observation into the atom already stored under the same id.
 *
 * Reinforcement is additive: max weight and confidence, unioned tags and files,
 * one more sighting.
 *
 * `forgotten` is **sticky**: once an atom is forgotten, no later observation
 * revives it. That is the entire point of the tombstone — the same statement is
 * re-extracted from the next compaction summary, in the same words, with the same
 * content hash. A last-wins flag would silently undo the user's decision a few
 * turns after they made it. Reviving is therefore an explicit act (delete the
 * record by hand), never a side effect of reading memory again.
 *
 * @param {object} existing - the stored atom.
 * @param {object} incoming - the newly observed atom.
 * @returns {object} the merged atom.
 */
export function mergeAtom(existing, incoming) {
  return {
    ...existing,
    tags: uniqueStrings([...existing.tags, ...incoming.tags], 12),
    files: uniqueStrings([...existing.files, ...incoming.files], 12).slice(0, 12),
    category_id: normalizeCategories([...(existing.category_id ?? []), ...(incoming.category_id ?? [])]),
    weight: Math.max(existing.weight, incoming.weight),
    confidence: Math.max(existing.confidence, incoming.confidence),
    // Standing is sticky in the permissive direction: a rule that ever earned it
    // keeps it through reinforcement. Re-deriving it per observation would let a
    // re-extraction with weaker wording demote a rule the user stated plainly.
    standing: existing.standing === true || incoming.standing === true,
    seen: existing.seen + 1,
    updatedAt: laterTimestamp(existing.updatedAt, incoming.updatedAt),
    source: {
      sessionId: incoming.source.sessionId ?? existing.source.sessionId,
      compactionId: incoming.source.compactionId ?? existing.source.compactionId,
      seq: incoming.source.seq ?? existing.source.seq,
    },
    forgotten: existing.forgotten === true || incoming.forgotten === true,
  }
}

/**
 * Read every atom record for a project.
 *
 * Last record wins per id, so a partially rewritten file cannot resurrect an
 * older version of an atom. A malformed line is counted and skipped: one bad
 * byte must not cost a session its whole memory.
 *
 * @param {string} root - project root.
 * @returns {{ ok: true, atoms: object[], live: object[], lines: number, invalid: number, existed: boolean }
 *   | { ok: false, reason: string }} the store contents.
 */
export function readAtoms(root) {
  const absolute = path.join(root, ATOMS_FILE)
  const text = readText(absolute)
  if (!text.ok) {
    if (text.reason === 'absent') return { ok: true, atoms: [], live: [], lines: 0, invalid: 0, existed: false }
    return { ok: false, reason: text.reason }
  }
  /** @type {Map<string, object>} */
  const records = new Map()
  let lines = 0
  let invalid = 0
  for (const line of text.text.split('\n')) {
    if (line.trim() === '') continue
    lines += 1
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      invalid += 1
      continue
    }
    const atom = normalizeAtom(parsed)
    if (atom !== null && atom.category_id.length === 0) atom.category_id = resolveCategories(atom)
    if (atom === null) {
      invalid += 1
      continue
    }
    records.set(atom.id, atom)
  }
  const atoms = [...records.values()]
  return {
    ok: true,
    atoms,
    live: atoms.filter((atom) => atom.forgotten !== true),
    lines,
    invalid,
    existed: true,
  }
}

/** Serialize atoms as the one-record-per-line store format. */
function serializeAtoms(atoms) {
  if (atoms.length === 0) return ''
  return `${atoms.map((atom) => JSON.stringify(atom)).join('\n')}\n`
}

/**
 * Drop records that no longer earn their bytes.
 *
 * Tombstones go first and oldest-first: their only job is to block
 * resurrection, and an old one has had plenty of chances to do it. Live atoms
 * then fall back to the weakest-first order the gate itself would use.
 *
 * @param {object[]} atoms - all records.
 * @returns {{ atoms: object[], dropped: number }} the retained records.
 */
export function pruneAtoms(atoms) {
  if (atoms.length <= MAX_ATOM_RECORDS) {
    const live = atoms.filter((atom) => atom.forgotten !== true)
    if (live.length <= MAX_LIVE_ATOMS) return { atoms, dropped: 0 }
  }
  const tombstones = atoms.filter((atom) => atom.forgotten === true).sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
  const live = atoms
    .filter((atom) => atom.forgotten !== true)
    .sort((left, right) => scoreForRetention(right) - scoreForRetention(left))
  const keptTombstones = tombstones.slice(Math.max(0, tombstones.length - Math.max(0, MAX_ATOM_RECORDS - MAX_LIVE_ATOMS)))
  const keptLive = live.slice(0, MAX_LIVE_ATOMS)
  const kept = [...keptLive, ...keptTombstones]
  return { atoms: kept, dropped: atoms.length - kept.length }
}

/**
 * Retention order for pruning: reinforcement, weight, and recency.
 * @param {object} atom - the atom.
 * @returns {number} a comparable score.
 */
function scoreForRetention(atom) {
  const recency = Date.parse(atom.updatedAt)
  const ageDays = Number.isFinite(recency) ? Math.max(0, (Date.now() - recency) / 86400000) : 365
  return Math.log1p(atom.seen) * 2 + atom.weight + atom.confidence - Math.min(ageDays / 60, 3)
}

/**
 * Record atoms, merging with what is already stored.
 *
 * Duplicate content is the normal case — the same decision shows up in a
 * summary, in a tool result, and in the next compaction — so this is written as
 * a merge rather than an insert, and reports what it did.
 *
 * @param {{
 *   root: string,
 *   atoms: unknown[],
 *   by?: { sessionId?: string | null, source?: string },
 *   options?: { now?: string, lockWaitMs?: number, prune?: boolean },
 * }} input - the write request.
 * @returns {Promise<
 *   | { ok: true, added: number, updated: number, unchanged: number, invalid: number, records: number, live: number, pruned: number }
 *   | { ok: false, reason: string }
 * >} the write outcome.
 */
export async function recordAtoms(input) {
  const now = input.options?.now ?? new Date().toISOString()
  const lockPath = path.join(input.root, MEMORY_LOCK_FILE)
  const locked = await withLock(
    lockPath,
    async () => {
      const current = readAtoms(input.root)
      if (!current.ok) return { ok: /** @type {false} */ (false), reason: `cannot read memory atoms: ${current.reason}` }
      /** @type {Map<string, object>} */
      const byId = new Map(current.atoms.map((atom) => [atom.id, atom]))
      let added = 0
      let updated = 0
      let unchanged = 0
      let invalid = 0

      for (const raw of input.atoms) {
        const observation = normalizeAtom(raw, { now })
        if (observation === null) {
          invalid += 1
          continue
        }
        const existing = byId.get(observation.id)
        if (existing === undefined) {
          const fresh = { ...observation, createdAt: observation.createdAt, updatedAt: now }
          byId.set(fresh.id, fresh)
          added += 1
          continue
        }
        const merged = mergeAtom(existing, { ...observation, updatedAt: now })
        if (stableStringify(merged) === stableStringify(existing)) {
          unchanged += 1
          continue
        }
        byId.set(merged.id, merged)
        updated += 1
      }

      if (added === 0 && updated === 0) {
        const live = current.atoms.filter((atom) => atom.forgotten !== true).length
        return {
          ok: /** @type {true} */ (true),
          added: 0,
          updated: 0,
          unchanged,
          invalid,
          records: current.atoms.length,
          live,
          pruned: 0,
        }
      }

      const pruned = input.options?.prune === false ? { atoms: [...byId.values()], dropped: 0 } : pruneAtoms([...byId.values()])
      const written = writeTextAtomic(path.join(input.root, ATOMS_FILE), serializeAtoms(pruned.atoms))
      if (!written.ok) return { ok: /** @type {false} */ (false), reason: `cannot write memory atoms: ${written.error?.message ?? written.error}` }
      return {
        ok: /** @type {true} */ (true),
        added,
        updated,
        unchanged,
        invalid,
        records: pruned.atoms.length,
        live: pruned.atoms.filter((atom) => atom.forgotten !== true).length,
        pruned: pruned.dropped,
      }
    },
    input.options?.lockWaitMs === undefined ? {} : { waitMs: input.options.lockWaitMs },
  )
  if (!locked.ok) return { ok: false, reason: locked.reason }
  return locked.value
}

/**
 * Mark atoms as forgotten, keeping their ids as tombstones.
 *
 * Deletion cannot be a plain removal: the next extraction pass sees the same
 * compaction summary and would put the atom straight back. The tombstone is the
 * record that the user already rejected it.
 *
 * @param {{ root: string, ids: string[], options?: { now?: string, lockWaitMs?: number } }} input - what to forget.
 * @returns {Promise<{ ok: true, forgotten: number, missing: number, records: number } | { ok: false, reason: string }>} the outcome.
 */
export async function forgetAtoms(input) {
  const wanted = new Set(input.ids)
  if (wanted.size === 0) return { ok: true, forgotten: 0, missing: 0, records: 0 }
  const now = input.options?.now ?? new Date().toISOString()
  const lockPath = path.join(input.root, MEMORY_LOCK_FILE)
  const locked = await withLock(
    lockPath,
    async () => {
      const current = readAtoms(input.root)
      if (!current.ok) return { ok: /** @type {false} */ (false), reason: `cannot read memory atoms: ${current.reason}` }
      let forgotten = 0
      let missing = 0
      for (const id of wanted) {
        const atom = current.atoms.find((candidate) => candidate.id === id)
        if (atom === undefined) {
          missing += 1
          continue
        }
        if (atom.forgotten === true) continue
        atom.forgotten = true
        atom.updatedAt = now
        forgotten += 1
      }
      if (forgotten === 0) {
        return { ok: /** @type {true} */ (true), forgotten: 0, missing, records: current.atoms.length }
      }
      const written = writeTextAtomic(path.join(input.root, ATOMS_FILE), serializeAtoms(current.atoms))
      if (!written.ok) return { ok: /** @type {false} */ (false), reason: `cannot write memory atoms: ${written.error?.message ?? written.error}` }
      return { ok: /** @type {true} */ (true), forgotten, missing, records: current.atoms.length }
    },
    input.options?.lockWaitMs === undefined ? {} : { waitMs: input.options.lockWaitMs },
  )
  if (!locked.ok) return { ok: false, reason: locked.reason }
  return locked.value
}

/**
 * Token set of an atom, used for gating and search.
 *
 * Tags and file basenames are added on top of the statement text because they
 * are the highest-signal words an atom carries: a path segment matches a task
 * far more reliably than a word in a sentence.
 *
 * @param {object} atom - the atom.
 * @returns {{ tokens: Set<string>, text: string }} its matching surface.
 */
export function atomTokens(atom) {
  const extra = []
  for (const file of atom.files) {
    for (const segment of file.split('/')) extra.push(segment)
  }
  const surface = `${atom.text}\n${atom.tags.join(' ')}\n${extra.join(' ')}`
  return { tokens: new Set(tokenize(surface)), text: atom.text }
}

/**
 * Count atoms by kind and state.
 * @param {object[]} atoms - all records.
 * @returns {{ records: number, live: number, forgotten: number, byKind: Record<string, number> }} counts.
 */
export function atomStats(atoms) {
  /** @type {Record<string, number>} */
  const byKind = {}
  let live = 0
  for (const atom of atoms) {
    if (atom.forgotten === true) continue
    live += 1
    byKind[atom.kind] = (byKind[atom.kind] ?? 0) + 1
  }
  return { records: atoms.length, live, forgotten: atoms.length - live, byKind }
}
