/**
 * Cluster-first recall and the execution model's review boundary.
 *
 * The routing model selects proposed IDs. Approval resolves them from the live
 * store, so a forgotten or newly ineligible atom cannot slip through a pending offer.
 */
import { randomUUID } from 'node:crypto'
import { clusterCandidates } from '../core/clusters.js'
import { categoryContext } from '../core/query-category.js'
import { readAtoms } from '../core/memory.js'
import { partitionByLifecycle, readLifecycle } from '../core/lifecycle.js'
import { decideRoute, gateAtoms, renderAtoms } from '../core/gate.js'
import { framePassage } from '../core/guard.js'
import { resolveWithin } from '../core/paths.js'
import { applyRouterSelection, runRouter } from './router.js'
import { connectedRouterDelegate, localRouterEnabled } from './local-router.js'

export function routingModelConfigured(settings) {
  return settings.routerTier !== 'off' && (localRouterEnabled(settings) || Boolean(settings.routerProvider || settings.routerModel))
}

function eligibleStore(root, settings) {
  const store = readAtoms(root)
  if (!store.ok) return store
  const lifecycle = readLifecycle(root)
  if (!lifecycle.ok) return lifecycle
  const { injectable } = partitionByLifecycle(store.live, lifecycle.state.atoms, {
    includeCold: settings.lifecycleEnabled !== true,
  })
  return { ...store, eligible: injectable }
}

export async function recallFromClusters(input) {
  const { settings, query } = input
  if (settings.injectRecall !== true) return { ok: false, reason: 'Memory recall is disabled.' }
  if (input.signal?.aborted) return { ok: false, reason: 'Memory recall was cancelled.' }

  const store = eligibleStore(input.root, settings)
  if (!store.ok) return { ok: false, reason: `Cannot read project memory: ${store.reason}` }
  if (store.eligible.length === 0) return { ok: false, reason: 'No eligible project memory.' }

  const eligible = store.eligible.filter((atom) => !input.excludedIds?.has(atom.id))
  const { atoms: candidates, clusterIds } = clusterCandidates({
    clusters: store.clusters,
    atoms: eligible,
    query: input.projectEvidence || query,
    limit: Math.max(40, settings.recallLimit * 4),
    includeStanding: true,
  })
  const configured = routingModelConfigured(settings)
  if (!configured || (settings.routerTier === 'smart' && !input.requestReview)) {
    const gating = gateAtoms({
      atoms: candidates,
      query,
      budget: settings.recallBudget,
      limit: settings.recallLimit,
      categories: categoryContext({ text: query.text ?? '', explicit: input.intent?.categories }),
    })
    if (!configured) {
      if (gating.selected.length === 0) return { ok: false, reason: 'No matching project memory.' }
      return {
        ok: true,
        route: settings.routerTier === 'off' ? 'off' : 'deterministic',
        tier: `recall/${settings.routerTier}`,
        block: renderAtoms({ selected: gating.selected }),
        selected: gating.selected,
        ids: gating.selected.map(({ atom }) => atom.id),
        atoms: gating.selected.length,
        tokens: gating.tokens,
        confidence: gating.confidence,
      }
    }
    const decision = decideRoute({ tier: 'smart', gating, storedAtoms: store.eligible.length, routerAvailable: true })
    if (decision.route === 'deterministic') {
      return { ok: true, route: 'deterministic', review: true, selected: gating.selected, clusterIds }
    }
  }

  const local = localRouterEnabled(settings)
  const route = local ? 'local' : 'subagent'
  const empty = (reason, router) => ({ ok: false, route, reason, router })
  if (candidates.length === 0) {
    return empty('No matching memory clusters.', { ok: true, rounds: 0, ids: 0 })
  }

  const connection = local ? connectedRouterDelegate(settings, input.readApiKey) : { delegate: input.delegate }
  if (typeof connection.delegate !== 'function') {
    return empty(connection.reason ?? 'The routing model is unavailable.', { ok: false, rounds: 0, ids: 0 })
  }

  const routed = await runRouter({
    delegate: connection.delegate,
    context: query.text ?? '',
    atoms: candidates,
    clusterIds,
    limit: settings.recallLimit,
    budget: settings.routerDigestBudget,
    timeoutMs: settings.routerTimeoutMs,
    strategy: settings.routerStrategy,
    strict: true,
    signal: input.signal,
  })
  if (!routed.ok) {
    return empty(routed.reason, { ok: false, rounds: 1, ids: 0, reason: routed.reason })
  }
  const selected = applyRouterSelection({
    ids: routed.ids,
    atoms: candidates,
    budget: settings.recallBudget,
    limit: settings.recallLimit,
    keepStanding: false,
  }).selected
  const router = { ok: true, rounds: 1, ids: selected.length, digestTokens: routed.digestTokens }
  if (selected.length === 0) return empty('The routing model returned no relevant memory.', router)
  return { ok: true, route, router, review: true, selected, clusterIds }
}

/** Store only the identifiers and sources needed to review the offer. */
export function createRecallProposal({ root, projectId, recall, intent, taskQuery, feedback = '', budget, excludedIds }) {
  return {
    id: randomUUID(),
    root,
    projectId,
    route: recall.route,
    intent,
    taskQuery,
    feedback,
    budget,
    excludedIds: excludedIds ?? new Set(),
    offered: recall.selected.map(({ atom }) => ({
      id: atom.id,
      kind: atom.kind,
      cluster_id: recall.clusterIds.get(atom.id),
      files: atom.files.filter((file) => file.length <= 240).map((file) => resolveWithin(root, file))
        .filter((file) => file.ok && file.relative !== '').slice(0, 3).map((file) => file.relative),
    })),
  }
}

export function describeRecallProposal(proposal) {
  const sources = framePassage({
    source: 'memory cluster metadata',
    text: proposal.offered.map(({ id, kind, cluster_id, files }) =>
      `- ${id} [${kind}] cluster ${cluster_id ?? 'unknown'} ${JSON.stringify(files)}`).join('\n'),
  }).text
  return [
    `Memory proposal ${proposal.id}. Compare the sources with the current project before accepting memory.`,
    'Call memory_intent with this proposal_id and accept_memory_ids to load only those IDs. Use an empty list to reject all, or provide feedback with project evidence to request a new proposal.',
    sources,
  ].join('\n')
}

export function resolveRecallApproval({ proposal, ids, settings }) {
  const accepted = new Set(ids)
  const offered = new Set(proposal.offered.map((entry) => entry.id))
  for (const id of accepted) {
    if (!offered.has(id)) throw new Error('Only IDs from this memory proposal can be accepted.')
  }
  if (accepted.size === 0) return { selected: [], tokens: 0 }
  const store = eligibleStore(proposal.root, settings)
  if (!store.ok) throw new Error(`Cannot read project memory: ${store.reason}`)
  return applyRouterSelection({
    ids: [...accepted],
    atoms: store.eligible.filter((atom) => accepted.has(atom.id)),
    keepStanding: false,
    budget: proposal.budget,
    limit: proposal.offered.length,
  })
}
