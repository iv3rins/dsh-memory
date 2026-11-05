/**
 * The gate: sparse, budgeted selection of memory atoms for one model call.
 *
 * The name is deliberate. A memory store that dumps everything is not memory, it
 * is a second copy of the context; what makes the experts-mixture analogy useful
 * is that selection must be *sparse* (a few atoms out of many), *scored* (every
 * inclusion has an explainable reason), and *bounded* (a hard token ceiling that
 * the caller cannot exceed by accident).
 *
 * Two levels, matching how a sparse mixture actually computes:
 *
 * 1. **Experts** — atoms grouped by kind. A group's logit is the strength of its
 *    best atoms, so a single sharp constraint outranks five vague facts.
 * 2. **Tokens within an expert** — atoms compete inside their group by relevance,
 *    reinforcement, and recency.
 *
 * The softmax produces the gate distribution. Everything is deterministic: same
 * atoms, same query, same ranking, which is what makes a selection defensible
 * when it lands in a model's context and a reviewer asks why.
 *
 * Alongside the selection the gate answers a second question — *is the
 * deterministic route good enough?* — because the three-tier router decides from
 * it whether spending a model call would actually buy anything.
 *
 * Pure Node; no DSH import.
 */

import { tokenize } from './search.js'
import { atomTokens } from './memory.js'
import { estimateTokens } from './context.js'

/** Scoring weights. Every one of these is a deliberate, documented choice. */
export const GATE_WEIGHTS = Object.freeze({
  /** Query token overlap with the atom's surface. */
  overlap: 6,
  /** Overlap with tokens that are rare across the store (inverse document frequency). */
  rareOverlap: 10,
  /** Atom kind priority, scaled. */
  kind: 1.5,
  /** Reinforcement from repeated sightings. */
  seen: 2,
  /** Declared weight minus the neutral default of 2. */
  weight: 3,
  /** Declared confidence, centred on 0.5. */
  confidence: 4,
  /** Recency: worth this much at zero age, decaying to nothing over the half-life. */
  recency: 4,
})

/** Age at which the recency term is worth half its weight, in days. */
export const RECENCY_HALF_LIFE_DAYS = 21

/** Temperature of the expert softmax; lower makes the router pickier. */
export const GATE_TEMPERATURE = 1.4

/** Gate probability below which an expert is not activated at all. */
export const EXPERT_THRESHOLD = 0.12

/** Maximum experts activated in one route (the "sparse" in sparse mixture). */
export const MAX_ACTIVE_EXPERTS = 3

/**
 * Kinds whose atoms are guaranteed a share of the budget when they are heavy.
 *
 * Re-exported from `memory.js`, which owns the atom model. Two definitions of "what
 * counts as a standing rule" is one too many: they drifted apart and the gate's copy
 * decided safety while the store's copy described it.
 */
export { STANDING_KINDS } from './memory.js'

/**
 * Fraction of the budget hard rules may claim before relevance is scored.
 *
 * The cap matters in both directions: a store full of constraints cannot crowd out
 * the atoms the request is actually about, and a request that matches nothing
 * cannot crowd out the constraints.
 *
 * Note what this cap now does that it could not before: because standing no longer
 * requires `weight >= 4`, a store may hold many more standing atoms than before
 * (this project's own store went from 5 to 43). The cap is what keeps that from
 * turning every recall into a wall of rules — the standing atoms *compete* for their
 * share on score rather than each being guaranteed a slot.
 */
export const STANDING_BUDGET_SHARE = 0.4

/**
 * Weight from which a standing-kind atom is treated as a hard rule.
 *
 * @deprecated Kept only so old callers do not break. Standing is decided by
 * `memory.resolveStanding` from the atom's kind and its explicit `standing` flag,
 * never from importance. A safety property that a weight can silently switch off is
 * not a safety property: 43 of 136 atoms in this store were genuine constraints
 * recorded at the neutral default weight and therefore excluded from the standing
 * budget entirely.
 */
export const STANDING_MIN_WEIGHT = 4

/** Below this normalized relevance the deterministic route is considered weak. */
export const CONFIDENT_SCORE = 3.5

/** Below this query-token coverage the deterministic route is considered weak. */
export const CONFIDENT_COVERAGE = 0.34

/**
 * Build the query surface from the texts that describe the current need.
 *
 * @param {string[]} texts - recent request text, task line, file paths, and so on.
 * @returns {{ tokens: Set<string>, text: string }} the query surface.
 */
export function buildQuery(texts) {
  const joined = texts.filter((text) => typeof text === 'string' && text !== '').join('\n')
  return { tokens: new Set(tokenize(joined)), text: joined }
}

/**
 * Document frequency per token across the live atoms.
 *
 * Rare tokens carry the routing signal: a token present in every atom ("the
 * project") cannot discriminate, while one present in a single atom identifies
 * it. This is the same idea as IDF, computed over the store rather than a corpus.
 *
 * @param {object[]} atoms - live atoms.
 * @returns {{ size: number, frequency: Map<string, number> }} the statistics.
 */
export function documentFrequency(atoms) {
  /** @type {Map<string, number>} */
  const frequency = new Map()
  for (const atom of atoms) {
    const { tokens } = atomTokens(atom)
    for (const token of tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1)
  }
  return { size: atoms.length, frequency }
}

/** Recency term: 1 at zero age, 0.5 at one half-life, monotonically decaying. */
function recencyFactor(updatedAt, now) {
  const stamp = Date.parse(updatedAt)
  if (!Number.isFinite(stamp)) return 0
  const ageDays = Math.max(0, (now - stamp) / 86400000)
  return 1 / (1 + ageDays / RECENCY_HALF_LIFE_DAYS)
}

/**
 * Score one atom against a query.
 *
 * @param {object} atom - the atom.
 * @param {{ tokens: Set<string> }} query - the query surface.
 * @param {{ statistics: { size: number, frequency: Map<string, number> }, now: number, priorities: Record<string, number> }} context - scoring context.
 * @returns {{ score: number, overlap: string[], reasons: string[] }} the score and why.
 */
export function scoreAtom(atom, query, context) {
  const { tokens } = atomTokens(atom)
  const overlap = []
  for (const token of query.tokens) {
    if (tokens.has(token)) overlap.push(token)
  }

  const reasons = []
  let score = 0

  if (overlap.length > 0) {
    score += Math.min(overlap.length, 5) * GATE_WEIGHTS.overlap
    reasons.push(`query match: ${overlap.join(', ')}`)
  }

  const rare = overlap.filter((token) => (context.statistics.frequency.get(token) ?? 0) <= 2)
  if (rare.length > 0) {
    score += Math.min(rare.length, 3) * GATE_WEIGHTS.rareOverlap
    reasons.push(`rare match: ${rare.join(', ')}`)
  }

  const priority = context.priorities[atom.kind] ?? 1
  score += (priority - 1) * GATE_WEIGHTS.kind
  if (priority > 1) reasons.push(`${atom.kind} ranks ${priority} of 5`)

  if (atom.seen > 1) {
    score += Math.log1p(atom.seen - 1) * GATE_WEIGHTS.seen
    reasons.push(`reinforced ${atom.seen}×`)
  }
  if (atom.weight > 2) score += (atom.weight - 2) * GATE_WEIGHTS.weight
  if (atom.confidence !== 0.5) score += (atom.confidence - 0.5) * GATE_WEIGHTS.confidence

  const recency = recencyFactor(atom.updatedAt, context.now)
  score += recency * GATE_WEIGHTS.recency

  // An atom that matches nothing in the query still competes on kind and
  // reinforcement, but it must not outrank one that does. Flooring the unmatched
  // region keeps the ordering honest without discarding durable memory.
  if (overlap.length === 0) score *= 0.35

  return { score: Math.round(score * 1000) / 1000, overlap, reasons }
}

/**
 * Apply a softmax over expert logits.
 * @param {number[]} logits - expert logits.
 * @param {number} temperature - softmax temperature.
 * @returns {number[]} probabilities summing to 1.
 */
export function softmax(logits, temperature) {
  if (logits.length === 0) return []
  const scaled = logits.map((logit) => logit / Math.max(0.05, temperature))
  const max = Math.max(...scaled)
  const exponentials = scaled.map((value) => Math.exp(value - max))
  const total = exponentials.reduce((sum, value) => sum + value, 0)
  if (total === 0) return logits.map(() => 1 / logits.length)
  return exponentials.map((value) => value / total)
}

/**
 * Select atoms for one model call.
 *
 * Selection is sparse in two ways: at most `maxExperts` kinds are activated, and
 * the whole result must fit the token budget. Atoms are added whole — never
 * sliced — because a half statement is worse than none.
 *
 * @param {{
 *   atoms: object[],
 *   query: { tokens: Set<string>, text?: string },
 *   budget: number,
 *   limit?: number,
 *   now?: number,
 *   priorities?: Record<string, number>,
 *   maxExperts?: number,
 *   temperature?: number,
 * }} input - selection inputs.
 * @returns {{
 *   selected: { atom: object, score: number, gate: number, reasons: string[] }[],
 *   excluded: { atom: object, score: number, reasons: string[] }[],
 *   experts: { kind: string, logit: number, gate: number, activated: boolean }[],
 *   tokens: number,
 *   budget: number,
 *   coverage: number,
 *   confidence: 'strong' | 'weak' | 'empty',
 *   reasons: string[],
 * }} the route result.
 */
export function gateAtoms(input) {
  const now = input.now ?? Date.now()
  const nowIso = new Date(now).toISOString()
  const budget = Math.max(0, input.budget)
  const limit = input.limit ?? 12
  const priorities = input.priorities ?? {}
  const maxExperts = input.maxExperts ?? MAX_ACTIVE_EXPERTS
  const live = input.atoms.filter((atom) => atom.forgotten !== true)

  const statistics = documentFrequency(live)
  const context = { statistics, now, priorities }

  const scored = live.map((atom) => {
    const result = scoreAtom(atom, input.query, { ...context, now: Date.parse(nowIso) })
    return { atom, score: result.score, overlap: result.overlap, reasons: result.reasons }
  })

  // The expert logit is the strength of the group's best atoms, with a small
  // contribution from the rest so a deep group is not penalised by one weak member.
  /** @type {Map<string, { atom: object, score: number, overlap: string[], reasons: string[] }[]>} */
  const groups = new Map()
  for (const entry of scored) {
    const list = groups.get(entry.atom.kind)
    if (list === undefined) groups.set(entry.atom.kind, [entry])
    else list.push(entry)
  }
  const kindOrder = [...groups.keys()].sort()
  const logits = kindOrder.map((kind) => {
    const members = [...(groups.get(kind) ?? [])].sort((left, right) => right.score - left.score)
    const best = members[0]?.score ?? 0
    const runnerUp = members[1]?.score ?? 0
    return best + runnerUp * 0.25
  })
  // Softmax over raw scores saturates: a 70-point match against a 3-point group
  // becomes exp(48), which is a one-hot gate, which activates exactly one expert —
  // "sparse" by accident and wrong about every other kind. Dividing by the mean
  // non-zero logit puts the distribution back on a scale the temperature can govern,
  // so the gate expresses *relative strength between kinds* rather than the
  // arbitrary magnitude of the scoring weights.
  const nonZero = logits.filter((logit) => logit > 0)
  const scale = nonZero.length === 0 ? 1 : nonZero.reduce((sum, logit) => sum + logit, 0) / nonZero.length
  const normalized = logits.map((logit) => logit / Math.max(scale, 1))
  const gates = softmax(normalized, input.temperature ?? GATE_TEMPERATURE)

  const experts = kindOrder
    .map((kind, index) => ({
      kind,
      logit: Math.round(logits[index] * 1000) / 1000,
      gate: Math.round(gates[index] * 1000) / 1000,
      activated: false,
    }))
    .sort((left, right) => right.logit - left.logit)

  const activated = new Set(
    experts
      .filter((expert) => expert.gate >= EXPERT_THRESHOLD)
      .slice(0, maxExperts)
      .map((expert) => expert.kind),
  )
  for (const expert of experts) expert.activated = activated.has(expert.kind)

  // Walk activated experts from highest gate down, then their atoms by score, and
  // take whole atoms until the budget or the count limit stops us.
  const selected = []
  const excluded = []
  let tokens = 0
  const gateOfKind = new Map(experts.map((expert) => [expert.kind, expert.gate]))

  /**
   * Take one scored atom if it fits, recording why not when it does not.
   * @param {{ atom: object, score: number, reasons: string[] }} entry - the candidate.
   * @returns {boolean} whether it was taken.
   */
  const take = (entry) => {
    if (selected.length >= limit) {
      excluded.push({ atom: entry.atom, score: entry.score, reasons: ['over the per-call atom limit'] })
      return false
    }
    const cost = estimateTokens(entry.atom.text) + 2
    if (tokens + cost > budget) {
      excluded.push({ atom: entry.atom, score: entry.score, reasons: [`over the ${budget}-token budget`] })
      return false
    }
    tokens += cost
    selected.push({
      atom: entry.atom,
      score: entry.score,
      gate: Math.round((gateOfKind.get(entry.atom.kind) ?? 0) * 1000) / 1000,
      reasons: entry.reasons,
    })
    return true
  }

  /*
   * Standing rules get first claim on the budget.
   *
   * This is the whole reason atoms exist. A hard constraint — "never rewrite
   * AGENTS.md", "must pass baseRev" — is exactly the memory whose loss produces a
   * wrong action, and it is usually phrased nothing like the request that violates
   * it: "please tidy up the docs" shares no vocabulary with "never rewrite
   * AGENTS.md". Ranking purely by query overlap therefore drops the constraints
   * precisely when they matter, which is the failure this system exists to prevent.
   *
   * The claim is capped at a share of the budget and a share of the count, so a store
   * full of rules cannot starve the atoms the request is actually about.
   *
   * Eligibility comes from `atom.standing`, not from `atom.weight`. Importance ranks
   * these atoms against each other; it no longer decides whether a genuine rule is
   * treated as a rule at all.
   */
  const standingCap = Math.max(1, Math.min(limit, Math.floor(limit * STANDING_BUDGET_SHARE) + 1))
  const standingBudget = Math.max(1, Math.floor(budget * STANDING_BUDGET_SHARE))
  const standing = scored
    .filter((entry) => entry.atom.standing === true)
    .sort((left, right) => right.score - left.score)
  let standingTokens = 0
  let standingTaken = 0
  for (const entry of standing) {
    if (standingTaken >= standingCap) break
    const cost = estimateTokens(entry.atom.text) + 2
    if (standingTokens + cost > standingBudget) continue
    const before = tokens
    if (!take({ ...entry, reasons: entry.overlap.length === 0 ? [...entry.reasons, 'standing rule: kept regardless of wording'] : entry.reasons })) continue
    standingTokens += tokens - before
    standingTaken += 1
  }

  const ordered = scored
    .filter((entry) => activated.has(entry.atom.kind))
    .filter((entry) => !selected.some((already) => already.atom.id === entry.atom.id))
    .sort((left, right) => {
      const gateDelta = (gateOfKind.get(right.atom.kind) ?? 0) - (gateOfKind.get(left.atom.kind) ?? 0)
      return gateDelta === 0 ? right.score - left.score : gateDelta
    })

  for (const entry of ordered) take(entry)

  // Coverage is the honest measure of "did this route answer the question": how
  // much of the query's vocabulary the selected atoms actually contain. Standing
  // rules are excluded on purpose — a constraint kept regardless of wording must not
  // make an unrelated request look answered, or the `smart` tier would never escalate
  // the case it exists for.
  const coveredTokens = new Set()
  let queryTokens = 0
  for (const token of input.query.tokens) {
    queryTokens += 1
    for (const entry of selected) {
      if (entry.reasons.includes('standing rule: kept regardless of wording')) continue
      if (atomTokens(entry.atom).tokens.has(token)) {
        coveredTokens.add(token)
        break
      }
    }
  }
  const coverage = queryTokens === 0 ? 0 : Math.round((coveredTokens.size / queryTokens) * 1000) / 1000
  const relevant = selected.filter((entry) => !entry.reasons.includes('standing rule: kept regardless of wording'))
  const topScore = relevant.length === 0 ? 0 : Math.max(...relevant.map((entry) => entry.score))
  const confidence = relevant.length === 0 ? 'empty' : topScore >= CONFIDENT_SCORE && coverage >= CONFIDENT_COVERAGE ? 'strong' : 'weak'

  const reasons = []
  const standingOnly = selected.length > 0 && relevant.length === 0
  if (selected.length === 0) reasons.push(live.length === 0 ? 'no atoms are stored yet' : 'no atom matched this request')
  else if (standingOnly) reasons.push(`only standing rules apply (${selected.length} kept, none matched the request)`)
  else reasons.push(`${relevant.length} atom(s) from ${activated.size} expert(s) within ${tokens}/${budget} tokens`)
  if (live.length > 0 && activated.size === 0 && selected.length === 0) reasons.push('every expert fell below the activation threshold')
  if (confidence === 'weak' && relevant.length > 0) {
    reasons.push(`weak deterministic match (top score ${topScore.toFixed(2)}, coverage ${coverage.toFixed(2)})`)
  }

  return {
    selected,
    excluded,
    experts: experts.map((expert) => ({ ...expert })),
    tokens,
    budget,
    coverage,
    confidence,
    reasons,
    queryTokens,
    standing: selected.filter((entry) => entry.reasons.includes('standing rule: kept regardless of wording')).length,
    relevant: relevant.length,
  }
}

/**
 * Decide how this call should retrieve: nothing, deterministic gating, or a
 * router subagent.
 *
 * This is the whole three-tier setting in one function. `off` never routes,
 * `always` always spends the model call, and `smart` spends it only when the
 * deterministic route is demonstrably bad — no atoms selected, or a weak match —
 * because those are exactly the cases where the cheap path has nothing to lose.
 *
 * @param {{
 *   tier: 'always' | 'smart' | 'off',
 *   gating: ReturnType<typeof gateAtoms>,
 *   storedAtoms?: number,
 *   routerAvailable?: boolean,
 *   cooldown?: boolean,
 * }} input - routing inputs.
 * @returns {{ route: 'off' | 'deterministic' | 'subagent', reason: string }} the decision.
 */
export function decideRoute(input) {
  const stored = input.storedAtoms ?? 0
  if (stored === 0) return { route: 'off', reason: 'no memory atoms are stored for this project yet' }
  if (input.tier === 'off') return { route: 'off', reason: 'router tier is "off": deterministic gating only, no router call' }
  if (input.routerAvailable !== true) {
    return { route: 'deterministic', reason: 'router tier wants a subagent but the subagents service is unavailable' }
  }
  if (input.cooldown === true) {
    return { route: 'deterministic', reason: 'a router call already ran for this turn; reusing its atoms' }
  }
  if (input.tier === 'always') {
    return { route: 'subagent', reason: 'router tier is "always": every call asks the router subagent' }
  }
  // smart
  const gating = input.gating
  // A recall made only of standing rules answered nothing: it kept the constraints,
  // which is correct, but it did not find what the request was about. That is the
  // strongest case for escalation, so it is checked before the "selected nothing" case.
  // `relevant` is optional in the input because a caller may hand-build a gating
  // summary; without it, every selected atom is assumed relevant.
  const relevant = Number.isSafeInteger(gating.relevant) ? gating.relevant : gating.selected.length
  if (relevant === 0) {
    return {
      route: 'subagent',
      reason: gating.selected.length === 0
        ? 'deterministic gating selected nothing; asking the router subagent'
        : 'deterministic gating found no relevant atom (only standing rules apply); asking the router subagent',
    }
  }
  if (gating.confidence === 'weak') {
    return { route: 'subagent', reason: `deterministic gating is weak (${gating.reasons.at(-1) ?? 'low relevance'}); asking the router subagent` }
  }
  return { route: 'deterministic', reason: `deterministic gating is confident (coverage ${gating.coverage.toFixed(2)})` }
}

/**
 * Render selected atoms as the block that will be injected.
 *
 * Provenance is part of the payload, not decoration: a model that cannot tell
 * where a sentence came from will treat a stale compaction summary as a current
 * instruction.
 *
 * @param {{ selected: { atom: object, score: number, gate: number, reasons: string[] }[], header?: string }} input - selected atoms.
 * @returns {string} the rendered block, or an empty string.
 */
export function renderAtoms(input) {
  if (input.selected.length === 0) return ''
  const lines = [input.header ?? 'Recalled project memory (durable atoms, ranked for this request):']
  for (const entry of input.selected) {
    const atom = entry.atom
    const provenance = [
      atom.kind,
      atom.source.compactionId === null ? null : 'from a compaction summary',
      entry.reasons.includes('standing rule: kept regardless of wording') ? 'standing rule' : null,
      `score ${entry.score.toFixed(2)}`,
    ].filter((part) => part !== null)
    lines.push(`- ${atom.text} [${provenance.join('; ')}]`)
  }
  return lines.join('\n')
}
