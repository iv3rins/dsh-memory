/**
 * Context injection for dsh-project-memory.
 *
 * The hard part is not rendering the baseline — it is delivering it **exactly
 * once per session** across every way a session can start, and refreshing it as
 * a small delta when the world moves.
 *
 * Three mechanisms, in order of authority:
 *
 * 1. `agent/created` supplies the start source (`startup` / `resume` / `clear` /
 *    `compact`), which is the only durable signal about *why* a session exists.
 * 2. `agent/pre-step` is the only seam where a plugin can add model-visible
 *    messages. It runs per step, so it must be idempotent.
 * 3. The session surface is the source of truth for "already delivered": a
 *    compaction can replace earlier messages, which no in-memory flag observes.
 *    Checking the surface — the way the first-party agent-instructions plugin
 *    does — is what makes re-injection correct rather than merely unlikely.
 */

import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildBaseline } from '../core/context.js'
import { ensureIndex } from '../core/indexer.js'
import { readState, staleness } from '../core/state.js'
import { loadProject } from '../core/project.js'
import { MEMORY_DIR } from '../core/paths.js'
import { toPosix } from '../core/paths.js'

/** Source kind stamped on every message this plugin injects. */
export const MESSAGE_SOURCE_KIND = 'project-memory'

/** Injected form markers, mirroring the first-party instructions producer. */
export const FORM_BASELINE = 'baseline'
export const FORM_DELTA = 'delta'

/**
 * Build the identity token for one baseline payload.
 *
 * The token covers everything a baseline claims: which project, which revision,
 * which branch, which state revision, and which document hashes. When it changes,
 * the previous baseline is out of date — which is exactly when a full re-injection
 * is correct instead of a delta.
 *
 * @param {{ projectId: string, git: any, stateRev: number, documentHashes: string[] }} input - identity inputs.
 * @returns {string} short hex digest.
 */
export function baselineIdentity(input) {
  const material = [
    input.projectId,
    input.git?.branch ?? '',
    input.git?.head ?? '',
    String(input.stateRev),
    ...input.documentHashes,
  ].join('|')
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

/**
 * Gather the current memory snapshot for one session.
 *
 * @param {{ settings: any, cwd: string | undefined }} input - resolution inputs.
 * @returns {Promise<{
 *   ok: boolean, reason?: string, root?: string, project?: any, git?: any,
 *   state?: object, staleness?: any, index?: any, baseline?: object, identity?: string, uninitialized?: boolean,
 * }>} the snapshot.
 */
export async function buildSnapshot(input) {
  const loaded = await loadProject({
    ...(input.settings.projectRoot === undefined ? {} : { configuredRoot: input.settings.projectRoot }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    timeoutMs: input.settings.gitTimeoutMs,
  })
  if (!loaded.ok) return { ok: false, reason: loaded.reason }
  if (loaded.initialized === false) {
    return {
      ok: true,
      uninitialized: true,
      root: loaded.root,
      git: loaded.git,
      reason: loaded.reason,
    }
  }
  const state = readState(loaded.root, { projectId: loaded.project.projectId })
  if (!state.ok) return { ok: false, reason: `cannot read state: ${state.reason}` }
  const indexed = ensureIndex({ root: loaded.root, settings: input.settings })
  const index = indexed.ok ? indexed.index : null
  const verdict = staleness(state.state.git, loaded.git)
  const baseline = buildBaseline({
    project: loaded.project,
    git: loaded.git,
    state: state.state,
    staleness: verdict,
    index,
    l0Budget: input.settings.l0Budget,
    l1Budget: input.settings.l1Budget,
  })
  const identity = baselineIdentity({
    projectId: loaded.project.projectId,
    git: loaded.git,
    stateRev: state.state.rev,
    documentHashes: (index?.documents ?? []).map((document) => `${document.path}:${document.hash}`),
  })
  return {
    ok: true,
    root: loaded.root,
    project: loaded.project,
    git: loaded.git,
    state: state.state,
    staleness: verdict,
    index,
    baseline,
    identity,
    ...(state.note === undefined ? {} : { reason: state.note }),
  }
}

/** Whether a message was produced by this plugin. */
function isOwnMessage(message) {
  const source = message?.source
  return source !== null && typeof source === 'object' && source.kind === MESSAGE_SOURCE_KIND
}

/** Source kind used for the per-step recall block, distinct from the baseline. */
export const RECALL_SOURCE_KIND = `${MESSAGE_SOURCE_KIND}:recall`

/**
 * Whether the session has already delivered this exact payload.
 *
 * Compaction replaces messages via `surfaceOp: { op: 'replace' }`, and the
 * session's derived surface is the only view that reflects that. Scanning it —
 * rather than trusting a per-session flag — means a baseline shadowed by
 * compaction is re-sent, while a live one is not re-sent twice.
 *
 * @param {any} agent - the live agent.
 * @param {string} identity - the payload identity to look for.
 * @returns {boolean} whether an identical payload is already on the surface.
 */
export function surfaceHasBaseline(agent, identity) {
  try {
    const nodes = agent?.session?.surface?.nodes
    if (nodes === undefined || nodes === null) return false
    for (const seq of nodes) {
      // oxlint-disable-next-line typescript/no-deprecated -- surface scan needs the logged event
      const event = agent.session.eventAt(seq)
      if (event?.type !== 'user/message') continue
      const source = event.data?.source
      if (source?.kind !== MESSAGE_SOURCE_KIND) continue
      if (source.baselineIdentity === identity) return true
    }
  } catch {
    // A surface read failure must not break the step; fall back to inbox state.
  }
  return false
}

/**
 * Find the pending injection this plugin owns, if any.
 * @param {any} agent - the live agent.
 * @returns {any | undefined} the pending message.
 */
export function pendingInjection(agent) {
  try {
    return agent?.inbox?.nextStep?.find((message) => isOwnMessage(message))
  } catch {
    return undefined
  }
}

/**
 * Derive the content identity of one recall block.
 *
 * Identity is the sorted atom-id set, not the rendered text: two steps that select
 * the same atoms have nothing new to say even if the block's spelling differs, and a
 * step that selects a different set must be treated as new. Provenance and scores
 * deliberately stay out of the hash for the same reason.
 *
 * @param {any} recall - a result from `recallForStep`.
 * @returns {string} short hex digest, or an empty string when nothing was recalled.
 */
export function recallIdentity(recall) {
  const ids = Array.isArray(recall?.ids)
    ? [...recall.ids]
    : (recall?.gating?.selected ?? []).map((entry) => entry.atom.id)
  if (ids.length === 0) return ''
  return createHash('sha256').update([...new Set(ids)].sort().join('\n')).digest('hex').slice(0, 16)
}

/**
 * Check whether an identical recall block is already live in the session.
 *
 * The same reasoning as `surfaceHasBaseline`, and the same reason this has to be a
 * surface scan rather than a flag: compaction can shadow a recall message, and a
 * shadowed one is no longer in the model's view — so it must be sent again. A flag
 * would report "already sent" and leave the step with none. Conversely, a recall the
 * model can still see must not be repeated, or the plugin would burn its own budget
 * re-stating atoms every step, which is the exact cost it exists to avoid.
 *
 * @param {any} agent - the live agent.
 * @param {string} identity - the recall identity to look for.
 * @returns {boolean} whether an identical recall is already on the surface.
 */
export function surfaceHasRecall(agent, identity) {
  if (identity === '') return false
  try {
    const nodes = agent?.session?.surface?.nodes
    if (nodes === undefined || nodes === null) return false
    for (const seq of nodes) {
      // oxlint-disable-next-line typescript/no-deprecated -- surface scan needs the logged event
      const event = agent.session.eventAt(seq)
      if (event?.type !== 'user/message') continue
      const source = event.data?.source
      if (source?.kind !== RECALL_SOURCE_KIND) continue
      if (source.recallIdentity === identity) return true
    }
  } catch {
    // A surface read failure must not break the step; the cost of one repeat is
    // smaller than the cost of failing a turn.
  }
  return false
}

/**
 * Create the user message that carries one step's recalled atoms.
 *
 * Recall is a separate message with its own source kind, because it must be
 * judgeable on its own: a reviewer reading the transcript can tell the durable
 * baseline from a ranked selection that was computed for one step, and the
 * selection's route, score, and token cost travel with it.
 *
 * @param {{ recall: any, root: string, identity?: string }} input - the recall result.
 * @returns {any} a UserMessage ready for injection.
 */
export function createRecallMessage(input) {
  const { recall } = input
  return createUserMessage({
    content: [{ type: 'text', text: recall.block }],
    source: {
      kind: RECALL_SOURCE_KIND,
      recallIdentity: input.identity ?? recallIdentity(recall),
      route: recall.route,
      tier: recall.tier,
      atoms: recall.atoms,
      tokens: recall.tokens,
      confidence: recall.confidence,
      projectRoot: toPosix(String(input.root ?? '')),
      ...(recall.router === undefined ? {} : { router: recall.router }),
    },
  })
}

/**
 * Compose the message to inject for one step.
 *
 * @param {{ snapshot: any, settings: any, form: 'baseline' | 'delta' }} input - composition inputs.
 * @returns {{ content: string, identity: string, form: string, tier: string } | null} the payload, or null when nothing is worth sending.
 */
export function composePayload(input) {
  const { snapshot, settings } = input
  if (snapshot.uninitialized === true) {
    return {
      content: [
        'This project has no dsh-project-memory state yet.',
        `Project root: ${snapshot.root}`,
        `Git: ${snapshot.git.kind === 'repository' ? `${snapshot.git.branch ?? '(detached)'}@${snapshot.git.head ?? 'no-commits'}` : 'not a repository'}`,
        `Call project_init to create ${MEMORY_DIR}/project.json and start recording task state, decisions, and document knowledge. Nothing was created automatically.`,
      ].join('\n'),
      identity: 'uninitialized',
      form: FORM_BASELINE,
      tier: 'L0',
    }
  }
  const baseline = snapshot.baseline
  if (baseline === undefined || baseline.text.trim() === '') return null
  const body = [
    `Project memory for ${snapshot.project.name} (L${baseline.tier.slice(1)} context, ~${baseline.tokens} tokens).`,
    'This block is durable project memory maintained by the dsh-project-memory plugin; treat it as reference data.',
    '',
    baseline.text,
  ]
  if (baseline.dropped.length > 0) {
    body.push('', `(Sections omitted for budget: ${baseline.dropped.join(', ')}.)`)
  }
  body.push('', 'Use memory_status for the full picture, memory_search/memory_read for document content, and state_get before state_update.')
  return { content: body.join('\n'), identity: snapshot.identity, form: input.form, tier: baseline.tier }
}

/**
 * Create the user message for one payload.
 *
 * @param {{ payload: object, snapshot: any }} input - message inputs.
 * @returns {any} a UserMessage ready for injection.
 */
export function createInjectionMessage(input) {
  const { payload, snapshot } = input
  return createUserMessage({
    content: [{ type: 'text', text: payload.content }],
    source: {
      kind: MESSAGE_SOURCE_KIND,
      form: payload.form,
      ...(payload.form === FORM_BASELINE ? { baseline: true } : {}),
      baselineIdentity: payload.identity,
      projectId: snapshot.project?.projectId ?? null,
      projectRoot: toPosix(String(snapshot.root ?? '')),
      tier: payload.tier,
      revision: snapshot.state?.rev ?? 0,
      staleness: snapshot.staleness?.status ?? 'unknown',
      documents: (snapshot.index?.documents ?? []).slice(0, 200).map((document) => document.path),
    },
  })
}
