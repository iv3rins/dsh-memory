/**
 * Compaction ledger: a durable record of every compaction this plugin observed.
 *
 * The atom store answers "what do I remember?". It cannot answer "how many
 * compactions happened, and how many of them produced nothing?" — an atom store
 * only contains successes, so a failure and a compaction that never occurred look
 * identical from inside it. A real audit found nineteen compactions and two
 * `compactionId`s in the store; nothing in the store could explain the gap.
 *
 * This ledger closes that hole. It records **one line per observed compaction**,
 * including — and this is the point — the ones that produced no atoms, with the
 * reason. A skipped compaction is a fact worth keeping: it is the difference
 * between "the plugin is working" and "the plugin is silently doing nothing".
 *
 * Design rules, each following from `session/event` semantics:
 *
 * 1. **Append-only, one JSON object per line.** Same shape as `journal.jsonl` and
 *    `atoms.jsonl`, so the same tools and eyeballs work on it.
 * 2. **Never throw.** The caller is a fire-and-forget event listener. A ledger
 *    failure must degrade to a log line, never to a lost compaction write.
 * 3. **Bounded.** The file is trimmed to the most recent `MAX_LEDGER_LINES`. This
 *    is an operational record, not the memory itself; old lines have served their
 *    purpose once an audit has read them.
 * 4. **Idempotent per `compactionId`.** A resumed session can replay a summary
 *    event. The ledger updates the existing line rather than appending a second
 *    one for the same id.
 *
 * Pure Node. No DSH import.
 */

import path from 'node:path'

import { MEMORY_DIR } from './paths.js'
import { readText, writeTextAtomic } from './store.js'

/** Ledger location relative to the project root. */
export const COMPACTIONS_FILE = `${MEMORY_DIR}/state/compactions.jsonl`

/** Maximum ledger lines retained before the oldest are dropped. */
export const MAX_LEDGER_LINES = 500

/**
 * Reasons a compaction can end without adding atoms. Kept as a closed set so an
 * audit can group them instead of string-matching prose.
 */
export const SKIP_REASONS = Object.freeze({
  /** `extractOnCompaction` is off; the user asked for no extraction. */
  DISABLED: 'extraction-disabled',
  /** The summary was empty or whitespace-only after rendering. */
  EMPTY_SUMMARY: 'empty-summary',
  /** No project root, so there is nowhere to write. */
  NO_ROOT: 'no-project-root',
  /** This process already handled the id and the store already has the atoms. */
  REPLAY: 'already-handled',
  /** The extractor ran and found nothing durable worth keeping. */
  NO_STATEMENTS: 'no-extractable-statements',
  /** Atoms were extracted but every one was already known, so nothing changed. */
  NO_CHANGE: 'no-new-knowledge',
  /** The store write itself failed. */
  WRITE_FAILED: 'store-write-failed',
  /** Too many writes were already pending; this one was dropped. */
  OVERLOADED: 'too-many-pending-writes',
})

/**
 * Read the ledger, oldest first.
 *
 * A truncated final line means the process died mid-append; it is skipped rather
 * than thrown, because reading an audit record must never fail the caller.
 *
 * @param {string} root - project root.
 * @param {{ limit?: number }} [options] - how many of the newest entries to return.
 * @returns {{ ok: boolean, entries: any[], reason?: string }} the entries.
 */
export function readLedger(root, options = {}) {
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 50
  const existing = readText(path.join(root, COMPACTIONS_FILE))
  if (!existing.ok) return { ok: existing.reason === 'absent', entries: [], reason: existing.reason }
  const entries = []
  for (const line of existing.text.split('\n')) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // Truncated tail from an interrupted append; the rest is still valid.
    }
  }
  return { ok: true, entries: entries.slice(-limit) }
}

/**
 * Serialize ledger entries back to file text, trimming to the newest lines.
 * @param {any[]} entries - every entry in order.
 * @returns {string} the file contents.
 */
function serialize(entries) {
  const kept = entries.length > MAX_LEDGER_LINES ? entries.slice(entries.length - MAX_LEDGER_LINES) : entries
  return `${kept.map((entry) => JSON.stringify(entry)).join('\n')}\n`
}

/**
 * Record one compaction outcome, replacing any earlier line for the same id.
 *
 * Called once per compaction, at whichever point its outcome became known. The
 * same id may arrive twice (a replayed summary on resume), so the existing line is
 * replaced in place: the ledger has one row per compaction, not per event.
 *
 * @param {{ root: string, entry: {
 *   compactionId: string,
 *   sessionId?: string | null,
 *   at?: string,
 *   summaryChars?: number,
 *   atomsAdded?: number,
 *   atomsUpdated?: number,
 *   atomsUnchanged?: number,
 *   statementsSkipped?: number,
 *   skipReason?: string | null,
 *   turn?: number | null,
 * } }} input - the outcome.
 * @returns {{ ok: boolean, reason?: string, entries: number }} the write result.
 */
export function recordCompaction(input) {
  const { root, entry } = input
  if (typeof root !== 'string' || root === '') return { ok: false, reason: 'no-root', entries: 0 }
  const id = entry?.compactionId
  if (typeof id !== 'string' || id === '') return { ok: false, reason: 'no-compaction-id', entries: 0 }

  try {
    const absolute = path.join(root, COMPACTIONS_FILE)
    const existing = readText(absolute)
    /** @type {any[]} */
    const entries = []
    if (existing.ok) {
      for (const line of existing.text.split('\n')) {
        if (line.trim() === '') continue
        try {
          const parsed = JSON.parse(line)
          // Drop the older row for this id; the newest outcome wins.
          if (parsed?.compactionId !== id) entries.push(parsed)
        } catch {
          // Skip the damaged line; one lost row cannot block a new one.
        }
      }
    }
    entries.push({
      compactionId: id,
      sessionId: entry.sessionId ?? null,
      at: entry.at ?? new Date().toISOString(),
      turn: entry.turn ?? null,
      summaryChars: Number.isSafeInteger(entry.summaryChars) ? entry.summaryChars : 0,
      atomsAdded: Number.isSafeInteger(entry.atomsAdded) ? entry.atomsAdded : 0,
      atomsUpdated: Number.isSafeInteger(entry.atomsUpdated) ? entry.atomsUpdated : 0,
      atomsUnchanged: Number.isSafeInteger(entry.atomsUnchanged) ? entry.atomsUnchanged : 0,
      statementsSkipped: Number.isSafeInteger(entry.statementsSkipped) ? entry.statementsSkipped : 0,
      skipReason: typeof entry.skipReason === 'string' ? entry.skipReason : null,
    })
    const written = writeTextAtomic(absolute, serialize(entries))
    if (!written.ok) return { ok: false, reason: written.reason, entries: 0 }
    return { ok: true, entries: entries.length }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), entries: 0 }
  }
}

/**
 * Summarize the ledger for `/memory-status` and for audits.
 *
 * Answers the question the atom store cannot: how often did this plugin observe a
 * compaction, and how many of those were silent?
 *
 * @param {any[]} entries - ledger entries.
 * @returns {{
 *   total: number,
 *   produced: number,
 *   skipped: number,
 *   atoms: number,
 *   byReason: Record<string, number>,
 *   lastAt: string | null,
 *   lastCompactionId: string | null,
 * }} the summary.
 */
export function summarizeLedger(entries) {
  const byReason = {}
  let produced = 0
  let atoms = 0
  for (const entry of Array.isArray(entries) ? entries : []) {
    const added = Number.isSafeInteger(entry?.atomsAdded) ? entry.atomsAdded : 0
    atoms += added
    if (added > 0) {
      produced += 1
    } else {
      const reason = typeof entry?.skipReason === 'string' ? entry.skipReason : 'unknown'
      byReason[reason] = (byReason[reason] || 0) + 1
    }
  }
  const list = Array.isArray(entries) ? entries : []
  const last = list.length > 0 ? list[list.length - 1] : null
  return {
    total: list.length,
    produced,
    skipped: list.length - produced,
    atoms,
    byReason,
    lastAt: typeof last?.at === 'string' ? last.at : null,
    lastCompactionId: typeof last?.compactionId === 'string' ? last.compactionId : null,
  }
}
