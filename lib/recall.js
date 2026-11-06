/**
 * Recall orchestration: what this step actually gets, and how it was chosen.
 *
 * `core/gate.js` decides what is *available*; this module decides what is
 * *spent*. It owns the three-tier policy in one place so the cost story is
 * auditable:
 *
 * | tier    | model calls per step | when |
 * |---------|----------------------|------|
 * | off     | 0 | deterministic gating only |
 * | smart   | 0, or 1 when gating is empty/weak | the default; cheap models can afford it |
 * | always  | 1 | when a cheap router model should see every request |
 *
 * Three properties this module guarantees regardless of tier:
 *
 * - **A recall never fails a step.** Every path returns `{ ok: false, reason }`
 *   instead of throwing, and the caller injects nothing.
 * - **A recall is bounded.** The token ceiling is enforced on whole atoms, and the
 *   router's input digest has its own ceiling, so a large project cannot make one
 *   step expensive.
 * - **A recall is honest.** The result records which route ran and why, so
 *   `/memory-route` can show the truth instead of "recall ran".
 *
 * Pure Node apart from an injected delegate; no DSH import.
 */

import { readAtoms } from '../core/memory.js'
import { buildQuery, gateAtoms, decideRoute, renderAtoms } from '../core/gate.js'
import { applyRouterSelection, renderRouted, runRouter } from './router.js'
import { estimateTokens } from '../core/context.js'
import { planSemanticRecall } from './semantic.js'

/**
 * Build the query surface for one step from the material a step actually has.
 *
 * Deliberately parsimonious: the last user message, the current task line, the
 * files the session has touched, and the names of documents already known. Each
 * of these is a genuine signal about what the next token needs; adding more (the
 * whole transcript, tool outputs) would make every atom match and destroy the
 * sparsity that makes gating useful.
 *
 * @param {{ messages?: any[], task?: any, touched?: any[], blockers?: any[], lastText?: string }} input - step material.
 * @returns {{ tokens: Set<string>, text: string }} the query surface.
 */
export function stepQuery(input) {
  const texts = []
  if (typeof input.lastText === 'string' && input.lastText !== '') texts.push(input.lastText)
  if (Array.isArray(input.messages)) {
    for (let index = input.messages.length - 1; index >= 0 && texts.length < 3; index -= 1) {
      const message = input.messages[index]
      if (message?.role !== 'user') continue
      const blocks = Array.isArray(message.content) ? message.content : []
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          texts.push(block.text.slice(0, 4000))
          break
        }
      }
    }
  }
  if (typeof input.task?.title === 'string' && input.task.title !== '') texts.push(input.task.title)
  if (typeof input.task?.phase === 'string' && input.task.phase !== '') texts.push(input.task.phase)
  for (const entry of input.touched ?? []) {
    if (typeof entry?.path === 'string') texts.push(entry.path)
  }
  for (const entry of input.blockers ?? []) {
    if (typeof entry?.text === 'string') texts.push(entry.text)
  }
  return buildQuery(texts)
}

/**
 * Recall memory for one step.
 *
 * @param {{
 *   root: string,
 *   settings: any,
 *   query: { tokens: Set<string>, text?: string },
 *   priorities?: Record<string, number>,
 *   delegate?: (input: { prompt: string, label: string, signal?: AbortSignal }) => Promise<string>,
 *   routerAvailable?: boolean,
 *   cooldown?: boolean,
 *   signal?: AbortSignal,
 *   now?: number,
 * }} input - recall inputs.
 * @returns {Promise<{
 *   ok: true,
 *   block: string,
 *   route: 'off' | 'deterministic' | 'subagent',
 *   reason: string,
 *   tier: string,
 *   atoms: number,
 *   tokens: number,
 *   confidence: string,
 *   router?: { ok: boolean, ids?: number, rejected?: number, digestTokens?: number, reason?: string },
 *   gating: any,
 * } | { ok: false, reason: string }>} the recall result.
 */
export async function recallForStep(input) {
  const settings = input.settings
  if (settings.injectRecall !== true) return { ok: false, reason: 'memory recall is disabled by config' }

  /*
   * The GC-inspired upgrade plugs in here and nowhere else.
   *
   * `planSemanticRecall` returns `enabled: false` when every switch is off, which is the
   * default; in that case nothing below changes and the pre-upgrade path runs byte for
   * byte. When it is on, the plan supplies a category-filtered candidate set, a lifecycle
   * partition and the intent, and the code below simply has fewer atoms to consider.
   */
  const plan = planSemanticRecall({
    root: input.root,
    settings,
    projectId: input.projectId ?? 'current',
    intent: input.intent ?? null,
    ...(input.query.text === undefined ? {} : { queryText: input.query.text }),
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  // A broken semantic layer must not cost the step its memory: fall through to the
  // classic path and say so.
  const planReason = plan.ok === true ? null : plan.reason
  const planOn = plan.ok === true && plan.enabled === true

  const store = readAtoms(input.root)
  if (store.ok !== true) return { ok: false, reason: `cannot read memory atoms: ${store.reason}` }
  if (store.live.length === 0) return { ok: false, reason: 'no memory atoms are stored for this project yet' }

  // With a plan, the candidates are the lifecycle-filtered, category-ranked atoms; the
  // router still speaks about `store.live` so an id it returns for an atom the plan
  // withheld is resolved rather than silently dropped.
  const gateAtomsList = planOn ? plan.plan.candidates.map((entry) => entry.atom) : store.live

  const gating = gateAtoms({
    atoms: gateAtomsList,
    query: input.query,
    budget: settings.recallBudget,
    limit: settings.recallLimit,
    ...(input.priorities === undefined ? {} : { priorities: input.priorities }),
    ...(input.now === undefined ? {} : { now: input.now }),
    // Per-request data, not a setting: the request's own categories, computed by the caller.
    // Absent means the semantic term contributes nothing and the score is unchanged.
    ...(input.categories === undefined ? {} : { categories: input.categories }),
    // An override used to measure whether pinned rules crowd out relevant atoms.
    ...(input.standingShare === undefined ? {} : { standingShare: input.standingShare }),
  })

  const decision = decideRoute({
    tier: settings.routerTier,
    gating,
    storedAtoms: store.live.length,
    routerAvailable: input.routerAvailable === true,
    ...(input.cooldown === undefined ? {} : { cooldown: input.cooldown }),
  })

  if (decision.route !== 'subagent') {
    const block = renderAtoms({ selected: gating.selected })
    if (block === '') return { ok: false, reason: `${decision.reason}; nothing was selected` }
    return {
      ok: true,
      block,
      route: decision.route,
      reason: decision.reason,
      tier: `recall/${settings.routerTier}`,
      atoms: gating.selected.length,
      // The ids actually rendered, which is what a dedupe key must be built from —
      // on the routed path they differ from the deterministic selection.
      ids: gating.selected.map((entry) => entry.atom.id),
      tokens: gating.tokens,
      confidence: gating.confidence,
      gating,
      ...(planOn
        ? {
            semantic: {
              enabled: true,
              categories: plan.plan.categories.map((entry) => entry.id),
              candidates: plan.plan.candidates.length,
              tiers: plan.plan.tiers,
              excludedByLifecycle: plan.plan.excludedByLifecycle,
              excludedByStatus: plan.plan.excludedByStatus,
              cached: plan.cached === true,
            },
          }
        : {}),
      ...(planReason === null ? {} : { semanticReason: planReason }),
    }
  }

  // The router runs against the full live store, not the deterministic selection:
  // its whole purpose is to disagree when text similarity got it wrong.
  //
  // `rank` carries the gate's own ordering into the digest so the *candidates* are
  // chosen well, not merely ordered well. Without it the digest was the first N atoms
  // in store order, and a relevant recent atom could be invisible to the model — no
  // wording of the instructions can fix a candidate that was never shown.
  //
  // The gate exposes selection, not raw scores, so the ranking is reconstructed from
  // what it kept and what it dropped: kept atoms first (in the order it chose them),
  // then the excluded ones.
  const rank = new Map()
  gating.selected.forEach((entry, index) => rank.set(entry.atom.id, gating.selected.length - index))
  for (const entry of gating.excluded) {
    if (!rank.has(entry.atom.id)) rank.set(entry.atom.id, -1)
  }
  const routed = await runRouter({
    delegate: input.delegate ?? (async () => '{"ids":[]}'),
    context: input.query.text ?? '',
    // With a plan, the digest offers the category/lifecycle-filtered candidates. Without
    // one it offers the whole live store, exactly as before the upgrade.
    atoms: gateAtomsList,
    limit: settings.recallLimit,
    budget: settings.routerDigestBudget,
    timeoutMs: settings.routerTimeoutMs,
    strategy: settings.routerStrategy,
    rank,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(gating.confidence === 'weak' ? { notes: gating.reasons.slice(-1) } : {}),
  })

  const gateOf = (atom) => {
    const expert = gating.experts.find((entry) => entry.kind === atom.kind)
    return expert === undefined ? 0 : expert.gate
  }

  if (routed.ok !== true) {
    // Degrade to the deterministic answer rather than losing the step's memory.
    const block = renderAtoms({ selected: gating.selected })
    const combined = `${decision.reason}; ${routed.reason}`
    if (block === '') return { ok: false, reason: combined }
    return {
      ok: true,
      block,
      route: 'deterministic',
      reason: combined,
      tier: `recall/${settings.routerTier} (router degraded)`,
      atoms: gating.selected.length,
      ids: gating.selected.map((entry) => entry.atom.id),
      tokens: gating.tokens,
      confidence: gating.confidence,
      router: { ok: false, reason: routed.reason },
      gating,
    }
  }

  const applied = applyRouterSelection({
    ids: routed.ids,
    atoms: gateAtomsList,
    gateOf,
    budget: settings.recallBudget,
    limit: settings.recallLimit,
  })
  // Cold atoms are resolved to their stored record so the reference line can state the
  // real token cost, but their text is never put in the block. With lifecycle gating on,
  // the plan's own cold set is included so a lifecycle-cold atom is still reachable by id.
  const coldIds = Array.isArray(routed.cold) ? routed.cold : []
  const planCold = planOn && Array.isArray(plan.plan.cold) ? plan.plan.cold.map((atom) => atom.id) : []
  const allColdIds = [...new Set([...coldIds, ...planCold])]
  const coldAtoms = store.live.filter((atom) => allColdIds.includes(atom.id))
  const block = renderRouted({
    selected: applied.selected,
    cold: coldAtoms,
    reason: routed.reason,
    offered: routed.offered,
  })
  const router = {
    ok: true,
    ids: routed.ids.length,
    cold: coldIds.length,
    rejected: routed.rejected.length,
    digestTokens: routed.digestTokens,
    ...(routed.reason === null ? {} : { reason: routed.reason }),
  }
  if (block === '') {
    // An explicit "nothing is hot" is a real answer and must not be replaced by the
    // deterministic guess: that substitution is what used to inject the whole store.
    return {
      ok: false,
      reason: `the router selected no relevant atoms (${routed.offered} offered)`,
      .../** @type {any} */ ({ route: 'subagent', router, gating }),
    }
  }
  return {
    ok: true,
    block,
    route: 'subagent',
    reason: routed.reason ?? decision.reason,
    tier: `recall/${settings.routerTier}`,
    atoms: applied.selected.length,
    ids: applied.selected.map((entry) => entry.atom.id),
    tokens: estimateTokens(block),
    confidence: 'routed',
    router,
    gating,
    ...(planOn
      ? {
          semantic: {
            enabled: true,
            categories: plan.plan.categories.map((entry) => entry.id),
            candidates: plan.plan.candidates.length,
            tiers: plan.plan.tiers,
            excludedByLifecycle: plan.plan.excludedByLifecycle,
            excludedByStatus: plan.plan.excludedByStatus,
            cached: plan.cached === true,
          },
        }
      : {}),
    ...(planReason === null ? {} : { semanticReason: planReason }),
  }
}

/**
 * Describe a recall outcome for a log line or a command reply.
 * @param {any} recall - a result from `recallForStep`.
 * @returns {string} one line.
 */
export function describeRecall(recall) {
  if (recall?.ok !== true) return `no recall: ${recall?.reason ?? 'unknown reason'}`
  const parts = [
    `route ${recall.route}`,
    `${recall.atoms} atom(s)`,
    `~${recall.tokens} tokens`,
    `confidence ${recall.confidence}`,
  ]
  if (recall.router !== undefined) {
    parts.push(recall.router.ok ? `router ids ${recall.router.ids}` : `router failed: ${recall.router.reason}`)
  }
  return parts.join(', ')
}
