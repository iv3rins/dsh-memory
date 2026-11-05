/**
 * System B — the development state document.
 *
 * One JSON document per project records what a session must learn to resume:
 * the current task, verified progress, next steps, blockers, decisions, and
 * invariants. Three properties make it trustworthy enough to inject into a
 * model's context:
 *
 * - **Optimistic concurrency** — every write carries the `rev` it read. A stale
 *   writer gets `conflict` plus a field-level diff instead of silently winning.
 * - **Idempotence** — a write whose normalized content equals the current
 *   document changes nothing: no revision bump, no disk write, no journal line.
 * - **Auditability** — each accepted write appends one line to `journal.jsonl`,
 *   so the sequence of decisions is reconstructible after a crash.
 *
 * Pure Node; no DSH import.
 */

import path from 'node:path'
import { createHash } from 'node:crypto'
import { MEMORY_DIR } from './paths.js'
import { readJson, writeJsonAtomic, readText, writeTextAtomic, withLock } from './store.js'

/** Current state schema version. */
export const STATE_SCHEMA = 2

/** Directories and files this module owns inside `.dsh-memory`. */
export const STATE_DIR = `${MEMORY_DIR}/state`
export const STATE_FILE = `${STATE_DIR}/current.json`
export const JOURNAL_FILE = `${STATE_DIR}/journal.jsonl`
export const LOCK_FILE = `${STATE_DIR}/.lock`

/** Fields whose writes append and deduplicate rather than replace. */
export const APPEND_FIELDS = Object.freeze(['next', 'blockers', 'decisions', 'touched', 'invariants', 'openQuestions'])

/** Maximum journal lines retained before compaction. */
export const MAX_JOURNAL_LINES = 500

/**
 * Build an empty state document for a project.
 * @param {{ projectId: string }} input - owning project.
 * @returns {object} a schema-valid state document.
 */
export function emptyState(input) {
  return {
    schema: STATE_SCHEMA,
    rev: 0,
    projectId: input.projectId,
    updatedAt: null,
    updatedBy: null,
    git: { branch: null, head: null, dirty: null, worktree: null, detached: false },
    task: null,
    progress: null,
    next: [],
    blockers: [],
    decisions: [],
    invariants: [],
    touched: [],
    openQuestions: [],
  }
}

/** Stable stringify: object keys sorted, so equal content hashes equally. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  const parts = []
  for (const key of keys) {
    if (value[key] === undefined) continue
    parts.push(`${JSON.stringify(key)}:${stableStringify(value[key])}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * Content hash of a state document, ignoring the volatile bookkeeping fields.
 * Used for the idempotence check.
 *
 * @param {object} state - state document.
 * @returns {string} hex digest.
 */
export function contentHash(state) {
  const { rev, updatedAt, updatedBy, ...rest } = state
  return createHash('sha256').update(stableStringify(rest)).digest('hex').slice(0, 16)
}

/**
 * Coerce a value into the shape the state schema expects, dropping unknown keys.
 * Writes come from a model, so shape assumptions must be enforced, not trusted.
 *
 * @param {unknown} value - candidate document.
 * @param {object} fallback - empty state to fall back to.
 * @returns {object} a normalized state document.
 */
export function normalizeState(value, fallback) {
  if (value === null || typeof value !== 'object') return fallback
  /** @type {any} */
  const raw = value
  const state = {
    schema: STATE_SCHEMA,
    rev: Number.isSafeInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0,
    projectId: typeof raw.projectId === 'string' ? raw.projectId : fallback.projectId,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    updatedBy: raw.updatedBy !== null && typeof raw.updatedBy === 'object' ? raw.updatedBy : null,
    git: {
      branch: typeof raw.git?.branch === 'string' ? raw.git.branch : null,
      head: typeof raw.git?.head === 'string' ? raw.git.head : null,
      dirty: typeof raw.git?.dirty === 'boolean' ? raw.git.dirty : null,
      worktree: typeof raw.git?.worktree === 'string' ? raw.git.worktree : null,
      detached: raw.git?.detached === true,
    },
    task: null,
    progress: null,
    next: [],
    blockers: [],
    decisions: [],
    invariants: [],
    touched: [],
    openQuestions: [],
  }
  if (raw.task !== null && typeof raw.task === 'object') {
    state.task = {
      id: typeof raw.task.id === 'string' ? raw.task.id : null,
      title: typeof raw.task.title === 'string' ? raw.task.title : '',
      status: typeof raw.task.status === 'string' ? raw.task.status : 'unknown',
      phase: typeof raw.task.phase === 'string' ? raw.task.phase : null,
      startedAt: typeof raw.task.startedAt === 'string' ? raw.task.startedAt : null,
    }
  }
  if (raw.progress !== null && typeof raw.progress === 'object') {
    state.progress = {
      summary: typeof raw.progress.summary === 'string' ? raw.progress.summary : '',
      lastVerifiedAt: typeof raw.progress.lastVerifiedAt === 'string' ? raw.progress.lastVerifiedAt : null,
      verifiedBy: typeof raw.progress.verifiedBy === 'string' ? raw.progress.verifiedBy : null,
    }
  }
  for (const field of APPEND_FIELDS) {
    const list = raw[field]
    if (!Array.isArray(list)) continue
    const seen = new Set()
    const items = []
    for (const entry of list) {
      const item = normalizeEntry(field, entry)
      if (item === null) continue
      const key = stableStringify(item)
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
    }
    state[field] = items
  }
  return state
}

/** Normalize one entry of an append-type list; null drops a malformed item. */
function normalizeEntry(field, entry) {
  if (field === 'invariants' || field === 'openQuestions') {
    if (typeof entry === 'string') return entry.trim() === '' ? null : entry.trim()
    if (entry !== null && typeof entry === 'object' && typeof entry.text === 'string') {
      return entry.text.trim() === '' ? null : entry.text.trim()
    }
    return null
  }
  if (entry === null || typeof entry !== 'object') return null
  /** @type {any} */
  const raw = entry
  if (field === 'next') {
    if (typeof raw.step !== 'string' || raw.step.trim() === '') return null
    const item = { step: raw.step.trim() }
    if (typeof raw.why === 'string' && raw.why.trim() !== '') item.why = raw.why.trim()
    return item
  }
  if (field === 'blockers') {
    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    if (text === '') return null
    const item = { text }
    if (typeof raw.since === 'string') item.since = raw.since
    return item
  }
  if (field === 'decisions') {
    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    if (text === '') return null
    const item = { text }
    if (typeof raw.id === 'string' && raw.id.trim() !== '') item.id = raw.id.trim()
    if (typeof raw.ref === 'string' && raw.ref.trim() !== '') item.ref = raw.ref.trim()
    return item
  }
  // touched
  const filePath = typeof raw.path === 'string' ? raw.path.trim().replace(/\\/g, '/') : ''
  if (filePath === '') return null
  const item = { path: filePath }
  if (typeof raw.why === 'string' && raw.why.trim() !== '') item.why = raw.why.trim()
  return item
}

/**
 * Read the state document for a project without creating anything.
 *
 * @param {string} root - project root.
 * @param {{ projectId: string }} identity - owning project identity.
 * @returns {{ ok: true, state: object, existed: boolean, note?: string } | { ok: false, reason: string, quarantinedTo?: string, message?: string }} the read outcome.
 */
export function readState(root, identity) {
  const absolute = path.join(root, STATE_FILE)
  const result = readJson(absolute)
  if (!result.ok) {
    if (result.reason === 'absent') {
      return { ok: true, state: emptyState(identity), existed: false }
    }
    if (result.reason === 'corrupt') {
      return {
        ok: true,
        state: emptyState(identity),
        existed: false,
        note: `state file was corrupt and has been quarantined${result.quarantinedTo === undefined ? '' : ` to ${path.basename(result.quarantinedTo)}`}; starting from an empty state (${result.message ?? 'parse error'})`,
      }
    }
    return result
  }
  return { ok: true, state: normalizeState(result.value, emptyState(identity)), existed: true }
}

/**
 * Merge a patch into a state document.
 *
 * Scalars and objects replace. Append-type lists are unioned: existing entries
 * are kept in order and new ones are added when absent, so a retried write
 * cannot duplicate a step or a blocker. `remove` names entries to delete.
 *
 * @param {object} current - the state as read.
 * @param {object} patch - the requested changes.
 * @param {{ now: string, by: object | null }} meta - write metadata.
 * @returns {object} a new state document.
 */
export function mergeState(current, patch, meta) {
  const next = normalizeState(current, emptyState({ projectId: current.projectId }))
  /** @type {any} */
  const raw = patch !== null && typeof patch === 'object' ? patch : {}

  if (raw.task !== undefined) {
    if (raw.task === null) next.task = null
    else if (typeof raw.task === 'object') {
      const merged = { ...(next.task ?? { id: null, title: '', status: 'unknown', phase: null, startedAt: null }) }
      for (const key of ['id', 'title', 'status', 'phase', 'startedAt']) {
        if (typeof raw.task[key] === 'string') merged[key] = raw.task[key]
        else if (raw.task[key] === null) merged[key] = null
      }
      if (next.task === null && typeof merged.startedAt !== 'string') merged.startedAt = meta.now
      next.task = merged
    }
  }
  if (raw.progress !== undefined) {
    if (raw.progress === null) next.progress = null
    else if (typeof raw.progress === 'object') {
      const merged = { ...(next.progress ?? { summary: '', lastVerifiedAt: null, verifiedBy: null }) }
      if (typeof raw.progress.summary === 'string') merged.summary = raw.progress.summary
      if (typeof raw.progress.lastVerifiedAt === 'string') merged.lastVerifiedAt = raw.progress.lastVerifiedAt
      if (raw.progress.lastVerifiedAt === null) merged.lastVerifiedAt = null
      if (typeof raw.progress.verifiedBy === 'string') merged.verifiedBy = raw.progress.verifiedBy
      if (raw.progress.verifiedBy === null) merged.verifiedBy = null
      if (raw.progress.verifiedBy === 'test' && merged.lastVerifiedAt === null) merged.lastVerifiedAt = meta.now
      next.progress = merged
    }
  }
  if (raw.git !== undefined && raw.git !== null && typeof raw.git === 'object') {
    for (const key of ['branch', 'head', 'worktree']) {
      if (typeof raw.git[key] === 'string') next.git[key] = raw.git[key]
      else if (raw.git[key] === null) next.git[key] = null
    }
    if (typeof raw.git.dirty === 'boolean') next.git.dirty = raw.git.dirty
    else if (raw.git.dirty === null) next.git.dirty = null
    if (typeof raw.git.detached === 'boolean') next.git.detached = raw.git.detached
  }
  for (const field of APPEND_FIELDS) {
    if (!Array.isArray(raw[field])) continue
    const additions = raw[field].map((entry) => normalizeEntry(field, entry)).filter((entry) => entry !== null)
    next[field] = unionEntries(next[field], additions)
  }
  if (Array.isArray(raw.remove)) {
    for (const request of raw.remove) {
      if (request === null || typeof request !== 'object') continue
      const field = typeof request.field === 'string' ? request.field : ''
      if (!APPEND_FIELDS.includes(field)) continue
      const match = typeof request.match === 'string' ? request.match : ''
      if (match === '') continue
      next[field] = next[field].filter((entry) => {
        const haystack = typeof entry === 'string' ? entry : `${entry.step ?? ''}${entry.text ?? ''}${entry.path ?? ''}`
        return !haystack.includes(match)
      })
    }
  }
  return next
}

/** Union an existing list with additions, preserving order and dropping duplicates. */
function unionEntries(existing, additions) {
  const result = Array.isArray(existing) ? [...existing] : []
  const seen = new Set(result.map((entry) => stableStringify(entry)))
  for (const entry of additions) {
    const key = stableStringify(entry)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(entry)
  }
  return result
}

/**
 * Compare two state documents and describe the difference by field.
 * @param {object} before - the state the caller expected.
 * @param {object} after - the state on disk.
 * @returns {{ field: string, before: unknown, after: unknown }[]} per-field differences.
 */
export function diffState(before, after) {
  const fields = ['rev', 'updatedAt', 'task', 'progress', ...APPEND_FIELDS, 'git']
  const differences = []
  for (const field of fields) {
    const left = stableStringify(before?.[field] ?? null)
    const right = stableStringify(after?.[field] ?? null)
    if (left !== right) differences.push({ field, before: before?.[field] ?? null, after: after?.[field] ?? null })
  }
  return differences
}

/**
 * Apply one state patch under a lock, enforcing CAS, idempotence, and auditing.
 *
 * @param {object} input - the write request.
 * @param {string} input.root - project root.
 * @param {{ projectId: string }} input.identity - owning project identity.
 * @param {object} input.patch - requested changes.
 * @param {number | null} [input.baseRev] - the revision the caller read, for CAS.
 * @param {{ sessionId?: string | null, source: string }} input.by - who is writing.
 * @param {{ lockWaitMs?: number, now?: string }} [input.options] - timing knobs.
 * @returns {Promise<
 *   | { ok: true, status: 'written', state: object, rev: number, changed: string[] }
 *   | { ok: true, status: 'unchanged', state: object, rev: number }
 *   | { ok: true, status: 'conflict', state: object, rev: number, differences: unknown[] }
 *   | { ok: false, reason: string }
 * >} the write outcome.
 */
export async function writeState(input) {
  const lockPath = path.join(input.root, LOCK_FILE)
  const locked = await withLock(
    lockPath,
    async () => {
      const current = readState(input.root, input.identity)
      if (!current.ok) {
        return { ok: /** @type {false} */ (false), reason: `cannot read state: ${current.reason}` }
      }
      const baseRev = typeof input.baseRev === 'number' && Number.isSafeInteger(input.baseRev) ? input.baseRev : null
      if (baseRev !== null && baseRev !== current.state.rev) {
        return {
          ok: /** @type {true} */ (true),
          status: /** @type {const} */ ('conflict'),
          state: current.state,
          rev: current.state.rev,
          differences: diffState({ rev: baseRev }, current.state).filter((entry) => entry.field !== 'rev'),
        }
      }
      const now = input.options?.now ?? new Date().toISOString()
      const merged = mergeState(current.state, input.patch, {
        now,
        by: { sessionId: input.by.sessionId ?? null, source: input.by.source },
      })
      const changed = diffState(current.state, merged)
        .map((entry) => entry.field)
        .filter((field) => field !== 'rev' && field !== 'updatedAt')
      if (changed.length === 0 || contentHash(merged) === contentHash(current.state)) {
        return {
          ok: /** @type {true} */ (true),
          status: /** @type {const} */ ('unchanged'),
          state: current.state,
          rev: current.state.rev,
        }
      }
      const nextState = {
        ...merged,
        rev: current.state.rev + 1,
        updatedAt: now,
        updatedBy: { sessionId: input.by.sessionId ?? null, source: input.by.source },
      }
      const written = writeJsonAtomic(path.join(input.root, STATE_FILE), nextState)
      if (!written.ok) {
        return { ok: /** @type {false} */ (false), reason: `cannot write state: ${written.error?.message ?? written.error}` }
      }
      appendJournal(input.root, {
        ts: now,
        rev: nextState.rev,
        op: 'state.update',
        fields: changed,
        by: nextState.updatedBy,
      })
      return {
        ok: /** @type {true} */ (true),
        status: /** @type {const} */ ('written'),
        state: nextState,
        rev: nextState.rev,
        changed,
      }
    },
    { waitMs: input.options?.lockWaitMs ?? 5000 },
  )
  if (!locked.ok) return locked
  return /** @type {any} */ (locked.value)
}

/**
 * Append one line to the audit journal, trimming it when it grows too long.
 *
 * Journal failures never fail the write they describe: the state is already
 * durable at that point, and refusing the whole operation would be worse than a
 * missing audit line.
 *
 * @param {string} root - project root.
 * @param {object} entry - the record to append.
 * @returns {void}
 */
export function appendJournal(root, entry) {
  const absolute = path.join(root, JOURNAL_FILE)
  const existing = readText(absolute)
  const previous = existing.ok ? existing.text.split('\n').filter((line) => line.trim() !== '') : []
  const lines = [...previous, JSON.stringify(entry)]
  const trimmed = lines.length > MAX_JOURNAL_LINES ? lines.slice(lines.length - MAX_JOURNAL_LINES) : lines
  writeTextAtomic(absolute, `${trimmed.join('\n')}\n`)
}

/**
 * Read the most recent journal records, newest last.
 * @param {string} root - project root.
 * @param {{ limit?: number }} [options] - how many records to return.
 * @returns {{ ok: boolean, entries: object[], reason?: string }} the records.
 */
export function readJournal(root, options = {}) {
  const limit = options.limit ?? 20
  const existing = readText(path.join(root, JOURNAL_FILE))
  if (!existing.ok) return { ok: existing.reason === 'absent', entries: [], reason: existing.reason }
  const entries = []
  for (const line of existing.text.split('\n')) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // A truncated final line means the process died mid-append; skip it.
    }
  }
  return { ok: true, entries: entries.slice(-limit) }
}

/**
 * Classify how far the recorded git facts have drifted from the live ones.
 *
 * @param {{ branch: string | null, head: string | null }} recorded - facts stored in the state.
 * @param {{ kind: string, branch: string | null, head: string | null, detached: boolean }} live - facts read now.
 * @returns {{ status: 'fresh' | 'advanced' | 'branch-changed' | 'unknown', detail: string }} the verdict.
 */
export function staleness(recorded, live) {
  if (live.kind !== 'repository') {
    return { status: 'unknown', detail: 'no git repository was detected, so the recorded revision cannot be checked' }
  }
  if (live.detached) {
    return { status: 'branch-changed', detail: `HEAD is detached at ${live.head ?? 'an unknown commit'}` }
  }
  if (recorded.branch === null || recorded.head === null) {
    return { status: 'unknown', detail: 'the saved state has no recorded branch or revision' }
  }
  if (recorded.branch !== live.branch) {
    return {
      status: 'branch-changed',
      detail: `saved on branch ${recorded.branch}, now on ${live.branch ?? 'an unnamed branch'}`,
    }
  }
  if (recorded.head !== live.head) {
    return { status: 'advanced', detail: `branch ${live.branch} moved from ${recorded.head} to ${live.head ?? 'an unknown commit'}` }
  }
  return { status: 'fresh', detail: `branch ${live.branch} at ${live.head}, unchanged since the state was written` }
}
