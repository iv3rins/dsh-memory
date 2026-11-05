/**
 * The router: a *subagent* used as a mixture-of-experts gating network.
 *
 * The deterministic gate in `core/gate.js` scores text similarity, which is cheap
 * and predictable but blind: it cannot know that an atom phrased as "the writer
 * must not touch `.blend1` files" is the one that matters to a request about
 * "backup noise in the export folder". Handing that judgement to a small model is
 * the point of the three-tier setting — a cheap model can afford to do it on
 * every step, and a user who does not want the spend turns it off.
 *
 * Three design constraints shape this file:
 *
 * 1. **The router never writes.** It is asked for ids from a supplied digest, and
 *    an id it invents is discarded. Memory mutation stays with deterministic code
 *    so a hallucination cannot corrupt the store.
 * 2. **The router cannot hang a turn.** Runs are bounded by a timeout and by the
 *    step's own abort signal, and every failure degrades to the deterministic
 *    selection instead of failing the step.
 * 3. **The router never sees unbounded input.** It receives a token-budgeted
 *    digest of atom ids and one-line statements, not the whole store, so its cost
 *    is bounded by configuration rather than by project size.
 *
 * Pure Node; no DSH import. The caller injects the delegation function.
 */

import { estimateTokens } from '../core/context.js'
import { renderAtoms } from '../core/gate.js'

/** Instructions given to the router subagent. */
export const ROUTER_INSTRUCTIONS = [
  'You are a memory router for a coding assistant. Your only job is to choose which stored memory atoms are relevant to the next request.',
  '',
  'You will receive:',
  '1. REQUEST CONTEXT — the current turn\'s text, task line, and files in play.',
  '2. MEMORY ATOMS — a numbered list of durable statements, each with an id, a kind, and its text.',
  '',
  'Return ONLY a JSON object of this shape, with no prose and no code fence:',
  '{"ids":["<id>", ...],"reason":"<one short sentence>"}',
  '',
  'Rules:',
  '- Choose at most the number of atoms you were asked for. Choosing fewer is correct when fewer are relevant.',
  '- Use ONLY ids that appear in MEMORY ATOMS. An id not in the list is discarded as an error.',
  '- Prefer atoms that state a constraint, a correction, a decision, or a pitfall over background facts.',
  '- If nothing is relevant, return {"ids":[],"reason":"..."} — an empty selection is a valid answer.',
  '- Never invent, rewrite, or summarize an atom. You are selecting, not editing.',
].join('\n')

/**
 * Render the router's input digest.
 *
 * The digest is what makes the router affordable: one line per atom, bounded by
 * the configured token budget, with an id the model can copy without ambiguity.
 *
 * @param {{
 *   context: string,
 *   atoms: object[],
 *   limit: number,
 *   budget: number,
 *   notes?: string[],
 * }} input - digest inputs.
 * @returns {{ text: string, offered: object[], tokens: number, truncated: boolean }} the digest and what fit.
 */
export function buildDigest(input) {
  const budget = Math.max(100, input.budget)
  const offered = []
  const lines = []
  let used = estimateTokens(input.context) + estimateTokens(ROUTER_INSTRUCTIONS)

  for (const atom of input.atoms) {
    const line = `${atom.id} [${atom.kind}] ${atom.text}`
    const cost = estimateTokens(line) + 1
    if (used + cost > budget) break
    used += cost
    offered.push(atom)
    lines.push(line)
  }

  const body = [
    ROUTER_INSTRUCTIONS,
    '',
    'REQUEST CONTEXT:',
    input.context.trim() === '' ? '(empty)' : input.context.trim(),
    '',
    `MEMORY ATOMS (${offered.length} of ${input.atoms.length} shown):`,
    offered.length === 0 ? '(none)' : lines.join('\n'),
    '',
    `Select at most ${input.limit} atom(s). Reply with JSON only.`,
  ]
  if (Array.isArray(input.notes) && input.notes.length > 0) {
    body.splice(body.length - 1, 0, '', `GATING NOTES: ${input.notes.join('; ')}`)
  }
  return { text: body.join('\n'), offered, tokens: estimateTokens(body.join('\n')), truncated: offered.length < input.atoms.length }
}

/**
 * Parse the router's reply into known atom ids.
 *
 * A model reply is untrusted text. Tolerating a code fence and a stray sentence is
 * worth it because a small model will produce them; tolerating an unknown id is
 * not, because that would let the router invent memory.
 *
 * @param {string} reply - the raw reply text.
 * @param {Set<string>} allowed - ids that actually exist.
 * @returns {{ ids: string[], reason: string | null, rejected: string[], error: string | null }} the parsed selection.
 */
export function parseRouterReply(reply, allowed) {
  const text = String(reply ?? '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced === null ? text : fenced[1]
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return { ids: [], reason: null, rejected: [], error: 'the router reply contained no JSON object' }
  let parsed
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1))
  } catch (error) {
    return { ids: [], reason: null, rejected: [], error: `the router reply was not valid JSON (${error instanceof Error ? error.message : String(error)})` }
  }
  const rawIds = Array.isArray(parsed?.ids) ? parsed.ids : []
  const ids = []
  const rejected = []
  for (const value of rawIds) {
    if (typeof value !== 'string') {
      rejected.push(String(value))
      continue
    }
    const trimmed = value.trim()
    if (!allowed.has(trimmed)) {
      rejected.push(trimmed)
      continue
    }
    if (!ids.includes(trimmed)) ids.push(trimmed)
  }
  return {
    ids,
    reason: typeof parsed?.reason === 'string' ? parsed.reason.slice(0, 300) : null,
    rejected,
    error: null,
  }
}

/**
 * Ask the router subagent for a selection.
 *
 * Every failure path returns `ok: false` with a reason instead of throwing: a
 * router that cannot answer must not cost the caller its step.
 *
 * @param {{
 *   delegate: (input: { prompt: string, label: string, signal?: AbortSignal }) => Promise<string>,
 *   context: string,
 *   atoms: object[],
 *   limit: number,
 *   budget: number,
 *   timeoutMs: number,
 *   signal?: AbortSignal,
 *   notes?: string[],
 * }} input - the routing request.
 * @returns {Promise<
 *   | { ok: true, ids: string[], reason: string | null, offered: number, rejected: string[], truncated: boolean, digestTokens: number }
 *   | { ok: false, reason: string }
 * >} the router's selection.
 */
export async function runRouter(input) {
  const digest = buildDigest({
    context: input.context,
    atoms: input.atoms,
    limit: input.limit,
    budget: input.budget,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  })
  if (digest.offered.length === 0) return { ok: false, reason: 'no atoms fit the router digest budget' }

  const controller = new AbortController()
  /** Resolves when the caller's deadline or cancellation fires. */
  let cancel = () => {}
  const cancelled = new Promise((_resolve, reject) => {
    cancel = (reason) => reject(reason instanceof Error ? reason : new Error(String(reason ?? 'cancelled')))
  })
  // A rejection nobody awaited would crash the process, and the common case is
  // "the delegate finished first".
  cancelled.catch(() => {})

  const timeout = setTimeout(() => {
    const reason = new Error(`router subagent timed out after ${input.timeoutMs} ms`)
    controller.abort(reason)
    cancel(reason)
  }, input.timeoutMs)
  const onAbort = () => {
    const reason = input.signal?.reason instanceof Error ? input.signal.reason : new Error('cancelled')
    controller.abort(reason)
    cancel(reason)
  }
  input.signal?.addEventListener('abort', onAbort, { once: true })
  if (input.signal?.aborted === true) onAbort()

  try {
    // The race is the point: aborting a signal does not settle a delegate that
    // ignores it, and a router that never returns must never hold the turn. Whichever
    // settles first wins, and the other is abandoned with its rejection contained.
    const reply = await Promise.race([
      Promise.resolve().then(() => input.delegate({ prompt: digest.text, label: 'memory-router', signal: controller.signal })),
      cancelled,
    ])
    const parsed = parseRouterReply(reply, new Set(digest.offered.map((atom) => atom.id)))
    if (parsed.error !== null) return { ok: false, reason: parsed.error }
    return {
      ok: true,
      ids: parsed.ids,
      reason: parsed.reason,
      offered: digest.offered.length,
      rejected: parsed.rejected,
      truncated: digest.truncated,
      digestTokens: digest.tokens,
    }
  } catch (error) {
    return { ok: false, reason: `router subagent failed: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Project a deterministic selection onto the ids the router chose.
 *
 * The router may return an atom the deterministic gate had excluded, which is the
 * point: it is allowed to disagree. What it may not do is exceed the budget, so
 * the final list is assembled by walking the router's own order and taking whole
 * atoms until the budget stops it.
 *
 * @param {{
 *   ids: string[],
 *   atoms: object[],
 *   gateOf: (atom: object) => number,
 *   budget: number,
 *   limit: number,
 * }} input - assembly inputs.
 * @returns {{ selected: { atom: object, score: number, gate: number, reasons: string[] }[], tokens: number, dropped: number }} the routed selection.
 */
export function applyRouterSelection(input) {
  const byId = new Map(input.atoms.map((atom) => [atom.id, atom]))
  const selected = []
  let tokens = 0
  let dropped = 0
  for (const id of input.ids) {
    if (selected.length >= input.limit) {
      dropped += 1
      continue
    }
    const atom = byId.get(id)
    if (atom === undefined) {
      dropped += 1
      continue
    }
    const cost = estimateTokens(atom.text) + 2
    if (tokens + cost > input.budget) {
      dropped += 1
      continue
    }
    tokens += cost
    selected.push({ atom, score: 0, gate: input.gateOf(atom), reasons: ['selected by the router subagent'] })
  }
  return { selected, tokens, dropped }
}

/**
 * Render the routed block with provenance that names the router.
 *
 * @param {{ selected: object[], reason: string | null, offered: number }} input - routed selection.
 * @returns {string} the block, or an empty string when nothing was selected.
 */
export function renderRouted(input) {
  if (input.selected.length === 0) return ''
  const header = [
    'Recalled project memory (durable atoms, selected by the router subagent):',
  ]
  if (input.reason !== null && input.reason !== '') header.push(`Router note: ${input.reason}`)
  return renderAtoms({ selected: input.selected, header: header.join('\n') })
}
