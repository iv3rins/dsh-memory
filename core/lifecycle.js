/**
 * Memory lifecycle: YOUNG → HOT → WARM → COLD, plus `pinned`.
 *
 * The single most important rule in this file: **retrieval is not use.** A candidate
 * that appears in a digest was *retrieved*; an atom that reached the model was
 * *delivered*; only an atom the model actually acted on was *used*. Collapsing those
 * into one counter is how a memory system talks itself into believing it is working —
 * a router that returns everything gets a perfect "hit rate" while delivering nothing
 * of value. The three counters are therefore stored separately and only `used`
 * contributes to the promotion score with full weight.
 *
 * Two further rules keep the tier from thrashing:
 *
 * - **Hysteresis.** Promotion needs a higher score than demotion. A single good or bad
 *   retrieval cannot move an atom across a boundary, which is what stops the store from
 *   oscillating between HOT and WARM every few steps.
 * - **Lifetime separates from status.** Lifecycle answers "how much context is this
 *   worth"; status answers "is this still valid". A superseded atom is `superseded`, not
 *   `cold`; an expired one is `expired`, not `cold`. Fusing them would make deletion look
 *   like ordinary cooling and lose the original bytes for no reason.
 *
 * Pure functions + one small JSON file for counters. No model calls.
 */

import path from 'node:path'
import { readJson, writeJsonAtomic } from './store.js'
import { MEMORY_DIR } from './paths.js'
import { estimateTokens } from './context.js'

/** Lifecycle tiers, coldest last. */
export const LIFECYCLE_TIERS = Object.freeze(['YOUNG', 'HOT', 'WARM', 'COLD'])

/**
 * Validity status, deliberately disjoint from lifecycle.
 *
 * `active` is the only status that takes part in lifecycle management. The other three
 * are terminal-ish: they stop injection for a *reason*, and that reason is not "it got
 * old".
 */
export const MEMORY_STATUSES = Object.freeze(['active', 'superseded', 'expired', 'retired'])

/** The lifecycle file. Counters are runtime metadata, so they live beside atoms, not in them. */
export const LIFECYCLE_FILE = `${MEMORY_DIR}/memory/lifecycle.json`

/** Schema version for the lifecycle sidecar. */
export const LIFECYCLE_SCHEMA = 1

/**
 * Scoring weights. Rule-based on purpose: the brief asks for a configurable policy and
 * explicitly not for a trained model, and a rule set a human can read is the only kind
 * that can be argued with when a promotion looks wrong.
 */
export const LIFECYCLE_WEIGHTS = Object.freeze({
  /** Confirmed use is the strongest signal there is. */
  used: 3,
  /** Delivery is weaker: the model saw it, which is not the same as needing it. */
  delivered: 0.8,
  /** Retrieval is weakest, and cannot promote on its own. */
  retrieved: 0.15,
  /** Recency of last *use*, decayed with a half-life. */
  recency: 2,
  /** Stored importance, 1–5. */
  importance: 0.5,
  /** Being referenced by many atoms raises the cost of losing it. */
  dependency: 0.6,
  /** Token cost is a penalty: an expensive atom must earn more to stay hot. */
  tokenCost: 0.004,
})

/** Half-life in days for the decayed access term. */
export const LIFECYCLE_HALF_LIFE_DAYS = 14

/**
 * Tier boundaries. Promotion uses the higher number, demotion the lower one, and the gap
 * between them is the hysteresis band.
 */
export const LIFECYCLE_THRESHOLDS = Object.freeze({
  /** YOUNG → HOT */
  hotPromote: 5.0,
  /** HOT → WARM */
  hotDemote: 3.6,
  /** WARM → HOT (re-promotion needs more than staying did) */
  hotRepromote: 5.4,
  /** WARM → COLD */
  coldDemote: 1.2,
  /** COLD → WARM */
  coldRepromote: 1.8,
  /** A YOUNG atom is promoted at most this many times before it must earn it elsewhere. */
  youngGraceSteps: 3,
})

/** How many recently used atoms to remember per project. */
export const MAX_RECENT_USES = 500

/** Empty lifecycle state. */
function emptyState() {
  return { schema: LIFECYCLE_SCHEMA, version: 0, atoms: {}, updatedAt: null }
}

/**
 * One atom's counter record.
 * @param {object} [raw] - stored record.
 * @returns {{ tier: string, status: string, pinned: boolean, retrieved: number, delivered: number, used: number, lastUsedAt: string | null, lastTransition: object | null }} the counters.
 */
function normalizeCounters(raw) {
  const record = raw !== null && typeof raw === 'object' ? raw : {}
  const counter = (value) => {
    const parsed = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
  }
  return {
    tier: LIFECYCLE_TIERS.includes(record.tier) ? record.tier : 'YOUNG',
    status: MEMORY_STATUSES.includes(record.status) ? record.status : 'active',
    pinned: record.pinned === true,
    retrieved: counter(record.retrieved),
    delivered: counter(record.delivered),
    used: counter(record.used),
    lastUsedAt: typeof record.lastUsedAt === 'string' ? record.lastUsedAt : null,
    lastTransition: record.lastTransition !== null && typeof record.lastTransition === 'object' ? record.lastTransition : null,
  }
}

/**
 * Read the lifecycle sidecar.
 *
 * A missing file is a fresh store, not an error: this subsystem must be able to start on
 * a project whose atoms predate it. A corrupt file is reported and read as empty, so a
 * half-written counter file costs counters, never memory.
 *
 * @param {string} root - project root.
 * @returns {{ ok: true, state: { schema: number, version: number, atoms: Record<string, any>, updatedAt: string | null }, existed: boolean, corrupt?: string }
 *   | { ok: false, reason: string }} the lifecycle state.
 */
export function readLifecycle(root) {
  const read = readJson(path.join(root, LIFECYCLE_FILE))
  if (read.ok !== true) {
    if (read.reason === 'absent') return { ok: true, state: emptyState(), existed: false }
    // `readJson` quarantines an unparsable file and reports `corrupt` rather than
    // returning garbage. Counters are metadata, so the right response is to start from a
    // clean count and say so — never to fail, and never to lose the atoms themselves.
    if (read.reason === 'corrupt') {
      return {
        ok: true,
        state: emptyState(),
        existed: true,
        corrupt: read.quarantinedTo === undefined
          ? 'the lifecycle file was unparsable'
          : `the lifecycle file was unparsable and moved to ${read.quarantinedTo}`,
      }
    }
    return { ok: false, reason: read.reason }
  }
  const raw = read.value
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: true, state: emptyState(), existed: true, corrupt: 'the lifecycle file did not contain an object' }
  }
  /** @type {Record<string, any>} */
  const atoms = {}
  const source = /** @type {any} */ (raw).atoms
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    for (const [id, value] of Object.entries(source)) {
      if (typeof id !== 'string' || id === '') continue
      atoms[id] = normalizeCounters(value)
    }
  }
  return {
    ok: true,
    state: {
      schema: LIFECYCLE_SCHEMA,
      version: Number.isSafeInteger(/** @type {any} */ (raw).version) ? /** @type {any} */ (raw).version : 0,
      atoms,
      updatedAt: typeof /** @type {any} */ (raw).updatedAt === 'string' ? /** @type {any} */ (raw).updatedAt : null,
    },
    existed: true,
  }
}

/**
 * Write the lifecycle sidecar.
 * @param {string} root - project root.
 * @param {object} state - the state to write.
 * @returns {{ ok: true } | { ok: false, reason: string }} the outcome.
 */
export function writeLifecycle(root, state) {
  const written = writeJsonAtomic(path.join(root, LIFECYCLE_FILE), state)
  if (written.ok !== true) return { ok: false, reason: written.error?.message ?? String(written.error) }
  return { ok: true }
}

/**
 * Resolve the counters for one atom, defaulting from the atom itself.
 *
 * `pinned` is defaulted from the atom so a constraint can be pinned by writing it with
 * `pinned: true` rather than by editing a sidecar. Validity status is also read from the
 * atom when present (`status`), which is how `memory_forget`-adjacent flows mark a
 * superseded statement without deleting it.
 *
 * @param {object} atom - the atom.
 * @param {Record<string, any>} counters - the sidecar map.
 * @returns {object} the counters to use.
 */
export function countersFor(atom, counters) {
  const stored = counters?.[atom?.id]
  const base = stored === undefined ? normalizeCounters(null) : normalizeCounters(stored)
  // An explicit value on the atom wins; the sidecar is runtime metadata and must not
  // override a hand-written pin or status.
  if (atom?.pinned === true) base.pinned = true
  if (MEMORY_STATUSES.includes(atom?.status)) base.status = atom.status
  return base
}

/** Decayed access term: 1 at zero age, 0.5 at one half-life. */
function decay(lastUsedAt, now) {
  if (typeof lastUsedAt !== 'string') return 0
  const stamp = Date.parse(lastUsedAt)
  if (!Number.isFinite(stamp)) return 0
  const ageDays = Math.max(0, (now - stamp) / 86400000)
  return 1 / (1 + ageDays / LIFECYCLE_HALF_LIFE_DAYS)
}

/**
 * Score one atom for lifecycle purposes.
 *
 * The score is a plain sum of interpretable terms. `dependency_score` is supplied by the
 * caller (it needs the whole store to compute) and defaults to 0.
 *
 * @param {object} atom - the atom.
 * @param {object} counters - resolved counters for the atom.
 * @param {{ now: number, dependency?: number, importance?: number }} context - scoring context.
 * @returns {{ score: number, terms: Record<string, number>, reasons: string[] }} the score and its parts.
 */
export function scoreLifecycle(atom, counters, context) {
  const now = Number.isFinite(context.now) ? context.now : Date.now()
  const importance = Number.isFinite(context.importance) ? context.importance : (atom?.weight ?? 2)
  const dependency = Number.isFinite(context.dependency) ? context.dependency : 0
  const tokens = estimateTokens(atom?.text ?? '')

  const terms = {
    used: Math.log1p(counters.used) * LIFECYCLE_WEIGHTS.used,
    delivered: Math.log1p(counters.delivered) * LIFECYCLE_WEIGHTS.delivered,
    retrieved: Math.log1p(counters.retrieved) * LIFECYCLE_WEIGHTS.retrieved,
    recency: decay(counters.lastUsedAt, now) * LIFECYCLE_WEIGHTS.recency,
    importance: Math.max(0, importance - 2) * LIFECYCLE_WEIGHTS.importance,
    dependency: dependency * LIFECYCLE_WEIGHTS.dependency,
    tokenCost: -tokens * LIFECYCLE_WEIGHTS.tokenCost,
  }
  const score = Object.values(terms).reduce((sum, value) => sum + value, 0)
  const reasons = []
  if (counters.used > 0) reasons.push(`used ${counters.used}×`)
  if (counters.delivered > 0 && counters.used === 0) reasons.push(`delivered ${counters.delivered}× but never confirmed used`)
  if (counters.retrieved > counters.delivered) reasons.push(`retrieved ${counters.retrieved}×, delivered ${counters.delivered}×`)
  if (terms.tokenCost < -1) reasons.push(`costs ${tokens} tokens`)
  return { score: Math.round(score * 1000) / 1000, terms, reasons }
}

/**
 * Decide the next tier for one atom.
 *
 * Returns the current tier unless the score clears the *hysteresis* boundary in the
 * relevant direction. In particular a COLD atom needs a higher score to return to WARM
 * than a WARM atom needs to stay there, so a single lucky retrieval cannot resurrect it.
 *
 * @param {{ tier: string, status: string, pinned: boolean }} current - current counters.
 * @param {number} score - the lifecycle score.
 * @param {{ protectedByStanding?: boolean }} [options] - standing protection.
 * @returns {{ tier: string, changed: boolean, reason: string | null }} the decision.
 */
export function decideTier(current, score, options = {}) {
  const tier = LIFECYCLE_TIERS.includes(current.tier) ? current.tier : 'YOUNG'

  // A pinned atom never cools on its own. Pinning exists so an important constraint
  // cannot be demoted by a scoring rule that cannot see the consequence of losing it.
  if (current.pinned === true) {
    return { tier: tier === 'COLD' ? 'WARM' : tier, changed: tier === 'COLD', reason: 'pinned: lifecycle changes are suppressed' }
  }
  // Standing rules are treated as at least WARM: they are kept regardless of relevance,
  // so cooling one would be a claim the scoring rule cannot support.
  if (options.protectedByStanding === true && tier === 'COLD') {
    return { tier: 'WARM', changed: true, reason: 'standing rule: floored at WARM' }
  }

  if (tier === 'YOUNG') {
    if (score >= LIFECYCLE_THRESHOLDS.hotPromote) return { tier: 'HOT', changed: true, reason: `young atom promoted at score ${score} ≥ ${LIFECYCLE_THRESHOLDS.hotPromote}` }
    return { tier: 'YOUNG', changed: false, reason: null }
  }
  if (tier === 'HOT') {
    if (score < LIFECYCLE_THRESHOLDS.hotDemote) return { tier: 'WARM', changed: true, reason: `hot atom cooled at score ${score} < ${LIFECYCLE_THRESHOLDS.hotDemote}` }
    return { tier: 'HOT', changed: false, reason: null }
  }
  if (tier === 'WARM') {
    if (score >= LIFECYCLE_THRESHOLDS.hotRepromote) return { tier: 'HOT', changed: true, reason: `warm atom re-promoted at score ${score} ≥ ${LIFECYCLE_THRESHOLDS.hotRepromote}` }
    if (score < LIFECYCLE_THRESHOLDS.coldDemote) return { tier: 'COLD', changed: true, reason: `warm atom cooled out at score ${score} < ${LIFECYCLE_THRESHOLDS.coldDemote}` }
    return { tier: 'WARM', changed: false, reason: null }
  }
  // COLD
  if (score >= LIFECYCLE_THRESHOLDS.coldRepromote) return { tier: 'WARM', changed: true, reason: `cold atom re-warmed at score ${score} ≥ ${LIFECYCLE_THRESHOLDS.coldRepromote}` }
  return { tier: 'COLD', changed: false, reason: null }
}

/**
 * Record one retrieval event for a set of atoms.
 *
 * Called by the recall path. This is the *weakest* signal and is recorded separately so
 * a later audit can tell "was considered" from "was shown" from "was needed".
 *
 * @param {object[]} atoms - atoms that entered the router digest or deterministic selection.
 * @param {Record<string, any>} counters - the sidecar map, mutated in place.
 * @param {{ now: string }} options - clock.
 * @returns {number} how many records changed.
 */
export function noteRetrieved(atoms, counters, options) {
  let changed = 0
  for (const atom of atoms) {
    if (atom?.id === undefined) continue
    const current = normalizeCounters(counters[atom.id])
    counters[atom.id] = { ...current, retrieved: current.retrieved + 1 }
    changed += 1
  }
  return changed
}

/**
 * Record a delivery event: the atom's text actually entered the model's request.
 * @param {object[]} atoms - delivered atoms.
 * @param {Record<string, any>} counters - the sidecar map, mutated in place.
 * @param {{ now: string }} options - clock.
 * @returns {number} how many records changed.
 */
export function noteDelivered(atoms, counters, options) {
  let changed = 0
  for (const atom of atoms) {
    if (atom?.id === undefined) continue
    const current = normalizeCounters(counters[atom.id])
    const now = options.now
    counters[atom.id] = {
      ...current,
      delivered: current.delivered + 1,
      // Delivery is evidence of attention, not of usefulness, so it refreshes recency
      // only when the atom has never been confirmed used.
      lastUsedAt: current.used === 0 ? now : current.lastUsedAt,
    }
    changed += 1
  }
  return changed
}

/**
 * Record a confirmed use.
 *
 * Only a caller that can actually observe the model acting on the memory should call
 * this — today that is the explicit `memory_confirm_used` tool, because an inference that
 * a delivery was useful is exactly the self-deception the three counters exist to avoid.
 *
 * @param {object[]} atoms - confirmed atoms.
 * @param {Record<string, any>} counters - the sidecar map, mutated in place.
 * @param {{ now: string }} options - clock.
 * @returns {number} how many records changed.
 */
export function noteUsed(atoms, counters, options) {
  let changed = 0
  for (const atom of atoms) {
    if (atom?.id === undefined) continue
    const current = normalizeCounters(counters[atom.id])
    counters[atom.id] = { ...current, used: current.used + 1, lastUsedAt: options.now }
    changed += 1
  }
  return changed
}

/**
 * Apply lifecycle decisions across the store.
 *
 * `pinned` and standing atoms are protected here rather than in the scorer, because
 * protection is a policy about consequences, not a scoring term.
 *
 * @param {{
 *   atoms: object[],
 *   counters: Record<string, any>,
 *   dependency?: Map<string, number>,
 *   now?: number,
 *   write?: boolean,
 * }} input - the sweep request.
 * @returns {{ decisions: { id: string, from: string, to: string, score: number, reason: string }[], promoted: number, demoted: number, unchanged: number }} the sweep result.
 */
export function sweepLifecycle(input) {
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const decisions = []
  let promoted = 0
  let demoted = 0
  let unchanged = 0
  const promotedToHot = LIFECYCLE_TIERS.indexOf('HOT')

  for (const atom of input.atoms) {
    if (atom?.id === undefined) continue
    if (atom.forgotten === true) continue
    const current = countersFor(atom, input.counters)
    // A non-active status is not a lifecycle question: the atom is out of rotation for a
    // reason that a score cannot revisit.
    if (current.status !== 'active') {
      unchanged += 1
      continue
    }
    const { score } = scoreLifecycle(atom, current, {
      now,
      ...(input.dependency?.has(atom.id) === true ? { dependency: input.dependency.get(atom.id) } : {}),
    })
    const decision = decideTier(current, score, { protectedByStanding: atom.standing === true })
    if (decision.changed !== true) {
      unchanged += 1
      // Keep the record fresh even when the tier did not move: the score is what a debug
      // view shows, and a stale score is a misleading one.
      input.counters[atom.id] = { ...current, lastTransition: current.lastTransition }
      continue
    }
    input.counters[atom.id] = {
      ...current,
      tier: decision.tier,
      lastTransition: { at: new Date(now).toISOString(), from: current.tier, to: decision.tier, score, reason: decision.reason },
    }
    decisions.push({ id: atom.id, from: current.tier, to: decision.tier, score, reason: decision.reason ?? '' })
    if (LIFECYCLE_TIERS.indexOf(decision.tier) < LIFECYCLE_TIERS.indexOf(current.tier)) promoted += 1
    else if (LIFECYCLE_TIERS.indexOf(decision.tier) > LIFECYCLE_TIERS.indexOf(current.tier)) demoted += 1
  }
  return { decisions, promoted, demoted, unchanged, promotedToHot }
}

/**
 * Count lifecycle tiers across a store, for metrics and the panel.
 * @param {object[]} atoms - live atoms.
 * @param {Record<string, any>} counters - the sidecar map.
 * @returns {{ YOUNG: number, HOT: number, WARM: number, COLD: number, pinned: number, inactive: number }} counts.
 */
export function countTiers(atoms, counters) {
  const counts = { YOUNG: 0, HOT: 0, WARM: 0, COLD: 0, pinned: 0, inactive: 0 }
  for (const atom of atoms) {
    if (atom?.forgotten === true) continue
    const current = countersFor(atom, counters)
    counts[current.tier] = (counts[current.tier] ?? 0) + 1
    if (current.pinned === true) counts.pinned += 1
    if (current.status !== 'active') counts.inactive += 1
  }
  return counts
}

/**
 * Choose which atoms a recall may inject, given lifecycle tiers.
 *
 * COLD atoms are excluded from injection but stay in the store and remain reachable
 * through cold references — which is exactly the brief's "do not delete, inject less".
 *
 * @param {object[]} atoms - live atoms.
 * @param {Record<string, any>} counters - the sidecar map.
 * @param {{ includeCold?: boolean }} [options] - override.
 * @returns {{ injectable: object[], cold: object[], inactive: object[] }} the partition.
 */
export function partitionByLifecycle(atoms, counters, options = {}) {
  const injectable = []
  const cold = []
  const inactive = []
  for (const atom of atoms) {
    const current = countersFor(atom, counters)
    if (current.status !== 'active') {
      inactive.push(atom)
      continue
    }
    if (current.tier === 'COLD' && options.includeCold !== true) {
      cold.push(atom)
      continue
    }
    injectable.push(atom)
  }
  return { injectable, cold, inactive }
}
