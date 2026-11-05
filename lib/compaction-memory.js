/**
 * Compaction memory: harvest durable atoms at exactly the moment context is lost.
 *
 * Compaction replaces a span of the conversation with one summary message and
 * discards the rest. That is the moment memory is most valuable and most at risk:
 * the summary is the only surviving record of the span, and it is prose, so
 * anything the summarizer compressed away is unrecoverable for the rest of the
 * session.
 *
 * This module listens to the compaction lifecycle through `session/event` — the
 * documented observation seam — and never touches `ctx.compaction` itself, because
 * exactly one plugin may implement that service and this is not it. Four rules
 * follow from that boundary, and each one is load-bearing:
 *
 * 1. **Never throw.** `session/event` is post-commit and fire-and-forget; a
 *    listener that throws is logged and contained, but the memory it was going to
 *    write is simply lost. Every path returns a result object.
 * 2. **Idempotent per `compactionId`.** The lifecycle emits start, summary, and end
 *    as separate events, and a resumed session can replay a summary event from its
 *    seed. Atoms carry the id, and the store merges by content identity, so a
 *    replay reinforces instead of duplicating.
 * 3. **Bounded and non-blocking.** Writing is queued per host, so a slow store
 *    never delays the compaction that triggered it, and the queue has a ceiling so
 *    a pathological session cannot grow it without limit.
 * 4. **Silent when uninitialized.** A project with no `.dsh-memory` yet gets
 *    nothing — the plugin never creates memory behind the user's back.
 *
 * Pure Node apart from `recordAtoms`; no DSH import.
 */

import { extractFromSummary, withSource } from '../core/extract.js'
import { recordAtoms } from '../core/memory.js'

/** Upper bound on pending writes held at once before the newest is dropped. */
export const MAX_PENDING_WRITES = 4

/** Upper bound on the remembered compaction ids used for idempotence. */
export const MAX_HANDLED_IDS = 512

/**
 * Track the compaction lifecycle for one host plugin instance.
 *
 * @param {{
 *   logger: { info: Function, warn: Function },
 *   settings: any,
 *   resolveRoot: (session: any) => string | null,
 *   onWritten?: (input: { root: string, sessionId: string | null, compactionId: string, added: number, updated: number }) => void,
 * }} input - host wiring.
 * @returns {{
 *   observe: (session: any, event: any) => void,
 *   pending: () => number,
 *   drain: () => Promise<void>,
 *   stats: () => { observed: number, written: number, skipped: number, failed: number, atoms: number, lastCompactionId: string | null },
 * }} the observer.
 */
export function createCompactionObserver(input) {
  const { logger, settings } = input
  /** @type {Map<string, { sessionId: string | null, root: string | null, turn: number | null }>} */
  const open = new Map()
  /** @type {Set<string>} */
  const handled = new Set()
  /** @type {Promise<unknown>[]} */
  const inflight = []
  const counters = { observed: 0, written: 0, skipped: 0, failed: 0, atoms: 0, lastCompactionId: null }

  const keyOf = (session, compactionId) => `${session?.id ?? 'unknown'}\u0000${compactionId}`

  /**
   * Queue one write and keep it from delaying its caller.
   * @param {() => Promise<unknown>} task - the work.
   * @returns {void}
   */
  const queue = (task) => {
    if (inflight.length >= MAX_PENDING_WRITES) {
      logger.warn(`dropping a queued memory write: ${inflight.length} still pending`)
      counters.skipped += 1
      return
    }
    const promise = task()
      .catch((error) => {
        counters.failed += 1
        logger.warn(`memory write failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        const index = inflight.indexOf(promise)
        if (index !== -1) inflight.splice(index, 1)
      })
    inflight.push(promise)
  }

  /**
   * Handle one compaction summary.
   * @param {{ session: any, root: string, compactionId: string, summary: string, seq: number | null, sessionId: string | null }} summary - the summary.
   * @returns {void}
   */
  const handleSummary = (summary) => {
    if (settings.extractOnCompaction !== true) {
      counters.skipped += 1
      return
    }
    const key = keyOf(summary.session, summary.compactionId)
    if (handled.has(key)) {
      counters.skipped += 1
      return
    }
    handled.add(key)
    if (handled.size > MAX_HANDLED_IDS) {
      // Bounded memory for the dedupe set itself. An id evicted from here has long
      // since been merged into the store, so re-handling it only reinforces atoms.
      const oldest = handled.values().next().value
      if (oldest !== undefined) handled.delete(oldest)
    }
    counters.lastCompactionId = summary.compactionId

    const extracted = extractFromSummary({
      summary: summary.summary,
      compactionId: summary.compactionId,
      sessionId: summary.sessionId,
      maxAtoms: 80,
    })
    if (extracted.atoms.length === 0) {
      counters.skipped += 1
      logger.info(`compaction ${summary.compactionId.slice(0, 8)} produced no memory atoms (${extracted.skipped} statement(s) skipped)`)
      return
    }
    const atoms = withSource(extracted.atoms, {
      sessionId: summary.sessionId,
      compactionId: summary.compactionId,
      seq: summary.seq,
    })
    queue(async () => {
      const result = await recordAtoms({
        root: summary.root,
        atoms,
        by: { sessionId: summary.sessionId, source: 'compaction' },
      })
      if (result.ok !== true) {
        counters.failed += 1
        logger.warn(`compaction memory not stored: ${result.reason}`)
        return
      }
      counters.written += 1
      counters.atoms += result.added
      logger.info(`compaction memory: ${result.added} new atom(s), ${result.updated} reinforced, ${result.unchanged} unchanged (store ${result.live} live)`)
      try {
        input.onWritten?.({
          root: summary.root,
          sessionId: summary.sessionId,
          compactionId: summary.compactionId,
          added: result.added,
          updated: result.updated,
        })
      } catch {
        // A listener here is a notification, not part of the write.
      }
    })
  }

  return {
    /**
     * Observe one session event.
     * @param {any} session - the session that emitted it.
     * @param {any} event - the event.
     * @returns {void}
     */
    observe(session, event) {
      try {
        const type = event?.type
        if (type === 'compaction/start') {
          counters.observed += 1
          const compactionId = event.data?.compactionId
          if (typeof compactionId !== 'string' || compactionId === '') return
          open.set(keyOf(session, compactionId), {
            sessionId: typeof session?.id === 'string' ? session.id : null,
            root: input.resolveRoot(session),
            turn: Number.isSafeInteger(event.data?.turn) ? event.data.turn : null,
          })
          return
        }
        if (type === 'compaction/summary') {
          const data = event.data
          if (data === null || typeof data !== 'object') return
          const compactionId = data.compactionId
          if (typeof compactionId !== 'string' || compactionId === '') return
          const text = Array.isArray(data.summary)
            ? data.summary.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
            : typeof data.summary === 'string' ? data.summary : ''
          if (text.trim() === '') {
            counters.skipped += 1
            return
          }
          const tracked = open.get(keyOf(session, compactionId))
          const root = tracked?.root ?? input.resolveRoot(session)
          if (root === null || root === '') {
            counters.skipped += 1
            return
          }
          handleSummary({
            session,
            root,
            compactionId,
            summary: text,
            seq: Number.isSafeInteger(event.seq) ? event.seq : null,
            sessionId: tracked?.sessionId ?? (typeof session?.id === 'string' ? session.id : null),
          })
          return
        }
        if (type === 'compaction/end' || type === 'compaction/prune') {
          const compactionId = event.data?.compactionId
          if (typeof compactionId !== 'string') return
          open.delete(keyOf(session, compactionId))
        }
      } catch (error) {
        counters.failed += 1
        logger.warn(`compaction observation failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    /** How many writes are still in flight. */
    pending: () => inflight.length,
    /** Wait for every queued write; used by tests and by clean shutdown. */
    async drain() {
      while (inflight.length > 0) await Promise.allSettled([...inflight])
    },
    /** Counters for `/memory-status` and tests. */
    stats: () => ({ ...counters }),
  }
}
