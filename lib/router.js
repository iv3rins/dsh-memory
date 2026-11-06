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
import { renderAtoms, STANDING_BUDGET_SHARE } from '../core/gate.js'

/**
 * Routing strategies. Each one changes what the router is asked to prioritise,
 * and therefore what its instructions say.
 *
 * These exist because "pick the relevant atoms" is not one question. A request to
 * rename a field and a request to explain the architecture need different memory,
 * and a model given one generic instruction answers both with the same bland
 * "these seem relevant" judgement. The strategy is a configuration choice, not a
 * guess: the user knows whether their work is mostly executing tasks or exploring
 * an unfamiliar codebase.
 */
export const ROUTER_STRATEGIES = Object.freeze([
  /** Weight what the step is about to do. The default. */
  'task',
  /** Weight the constraints and corrections that govern the files in play. */
  'compliance',
  /** Weight background and prior decisions, for orientation over action. */
  'orient',
])

/** What each strategy adds to the base instructions. Kept terse on purpose: every
 * token here is a token the digest cannot spend on showing a candidate atom. */
const STRATEGY_GUIDANCE = Object.freeze({
  task: 'Prioritise: (1) atoms constraining the files named in the request; (2) corrections the user made and decisions already settled, over anything you infer; (3) atoms naming a declared blocker on this task; (4) background that merely sounds important — last, only if budget remains.',
  compliance: 'Prioritise: (1) constraints and prohibitions governing the files in play, whether or not their wording matches the request; (2) user corrections and pitfalls already hit there; (3) decisions fixing how this code must change; (4) background — deprioritise it. Breaking a rule costs more than lacking context.',
  orient: 'Prioritise: (1) atoms explaining how the relevant subsystem works and why; (2) decisions already made, so an explanation does not contradict them; (3) pitfalls and unfinished work in the area; (4) step-by-step task state — deprioritise it. The request asks to understand, not to act.',
})

/**
 * Build the router instructions for a strategy.
 *
 * The distinction the old single prompt lacked is the one that matters most: a
 * constraint that governs the files in play is relevant *even when it shares no
 * vocabulary with the request*, while background that shares vocabulary may still
 * be useless. Telling the model to "prefer constraints" was not enough — it needed
 * to be told that sounding-important and being-relevant are different axes.
 *
 * @param {string} [strategy] - one of `ROUTER_STRATEGIES`.
 * @returns {string} the instructions.
 */
export function buildRouterInstructions(strategy = 'task') {
  const chosen = ROUTER_STRATEGIES.includes(strategy) ? strategy : 'task'
  return [
    'You are a memory router. Choose which stored atoms bear on the next request.',
    '',
    'You receive REQUEST CONTEXT and MEMORY ATOMS (id, kind, text). Reply JSON only:',
    '{"hot_memory_ids":["<id>"],"cold_memory_ids":["<id>"],"abstained":false,"reason":"<short>"}',
    'HOT: inject now. COLD: exists but not worth loading now. One list per id.',
    '',
    'Three cases, not the same:',
    '- RELEVANT: memory about this task, the files it touches, or the decision it implements.',
    '- BINDING: a constraint governing the files in play even if its wording looks unrelated. "Never rewrite AGENTS.md" governs every docs step, whether or not the request says so.',
    '- MERELY PROMINENT: background that sounds weighty but does not change what this step should do. Be suspicious of it, including your own sense that a statement is too important to omit.',
    '',
    STRATEGY_GUIDANCE[chosen],
    '',
    'Rules:',
    '- At most the requested count; fewer is correct when fewer are relevant.',
    '- Use ONLY ids listed. An invented id is discarded as an error.',
    '- Nothing relevant? Return {"hot_memory_ids":[],"cold_memory_ids":[],"abstained":true}. Binding constraints are kept regardless.',
    '- Never invent or rewrite an atom; you are selecting, not editing.',
  ].join('\n')
}

/** Instructions given to the router subagent, for the default strategy. */
export const ROUTER_INSTRUCTIONS = buildRouterInstructions('task')

/**
 * Render the router's input digest.
 *
 * The digest is what makes the router affordable: one line per atom, bounded by
 * the configured token budget, with an id the model can copy without ambiguity.
 *
 * **Candidate composition matters as much as the prompt.** Taking the first N atoms
 * in store order meant the oldest records filled the digest and a relevant recent
 * atom could be invisible to the router no matter how well the instructions were
 * written — the model cannot choose what it was never shown. When `rank` is supplied
 * (the deterministic gate's scores) the digest is assembled from:
 *
 * 1. every standing rule that fits, because those are the ones whose absence costs
 *    the most and whose wording is least likely to match the request;
 * 2. the highest-scoring atoms, which is where "relevant to this request" lives;
 * 3. one representative per remaining kind, so a whole category cannot vanish just
 *    because its atoms scored low against this particular wording.
 *
 * Without `rank` the old in-order behaviour is kept, so a caller that has no scores
 * still gets a usable digest.
 *
 * @param {{
 *   context: string,
 *   atoms: object[],
 *   limit: number,
 *   budget: number,
 *   notes?: string[],
 *   rank?: Map<string, number>,
 *   instructions?: string,
 * }} input - digest inputs.
 * @returns {{ text: string, offered: object[], tokens: number, truncated: boolean }} the digest and what fit.
 */
export function buildDigest(input) {
  const budget = Math.max(100, input.budget)
  const instructions = typeof input.instructions === 'string' ? input.instructions : ROUTER_INSTRUCTIONS
  const offered = []
  const lines = []
  /*
   * The instructions and the request context are fixed overhead and are counted
   * against the same ceiling as the atoms: `routerDigestBudget` is a total, and a
   * digest that overshoots it is exactly the unbounded cost this ceiling exists to
   * prevent. That is also why the instructions are kept terse — every token spent
   * explaining the job is a token not available for showing a candidate.
   *
   * Terse is a hard constraint here, not a style preference: a paragraph of extra
   * protocol prose is enough to crowd every candidate out of a small budget, and a
   * router shown no candidates answers "nothing is relevant" about a store it never
   * saw. The protocol lines below are deliberately compressed for that reason.
   */
  let used = estimateTokens(input.context) + estimateTokens(instructions)

  /** Order the atoms by what is worth showing first, then fill the budget in that order. */
  const ordered = (() => {
    if (!(input.rank instanceof Map)) return input.atoms
    const score = (atom) => input.rank.get(atom.id) ?? 0
    const standing = input.atoms.filter((atom) => atom?.standing === true).sort((left, right) => score(right) - score(left))
    const rest = input.atoms
      .filter((atom) => atom?.standing !== true)
      .sort((left, right) => score(right) - score(left))
    const chosen = [...standing, ...rest]
    // Add one representative of any kind not already represented, at the back, so a
    // category cannot disappear from the digest entirely.
    const kinds = new Set(chosen.map((atom) => atom.kind))
    const stragglers = []
    for (const atom of input.atoms) {
      if (kinds.has(atom.kind)) continue
      kinds.add(atom.kind)
      stragglers.push(atom)
    }
    const seen = new Set()
    return [...chosen, ...stragglers].filter((atom) => {
      if (seen.has(atom.id)) return false
      seen.add(atom.id)
      return true
    })
  })()

  for (const atom of ordered) {
    const colors = input.categoryLabels === true && Array.isArray(atom.category_id) && atom.category_id.length > 0
      ? ` colors=${atom.category_id.join(',')}`
      : ''
    const line = `${atom.id} [${atom.kind}]${colors} ${atom.text}`
    const cost = estimateTokens(line) + 1
    if (used + cost > budget) break
    used += cost
    offered.push(atom)
    lines.push(line)
  }

  const body = [
    instructions,
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
 * Parse the router's reply into known atom ids, split into hot and cold.
 *
 * A model reply is untrusted text. Tolerating a code fence and a stray sentence is
 * worth it because a small model will produce them; tolerating an unknown id is
 * not, because that would let the router invent memory.
 *
 * The protocol is `hot_memory_ids` / `cold_memory_ids`, with `ids` accepted as a
 * legacy alias for hot. Two behaviours matter more than the field names:
 *
 * - **Validation lives here, not in the prompt.** Every id is checked against what
 *   the digest offered, so a hallucination cannot reach the model.
 * - **An explicit empty selection is an answer, not a missing answer.** The old
 *   parser read only `ids`, so a reply in the documented shape parsed as an empty
 *   selection — and an empty selection made the caller fall back to injecting its
 *   own deterministic guess. That is how "the router selected two atoms" turned
 *   into "every atom in the project was injected", and it is also why cold memory
 *   never existed: the field was never read at all.
 *
 * @param {string} reply - the raw reply text.
 * @param {Set<string>} allowed - ids that actually exist.
 * @returns {{ ids: string[], cold: string[], reason: string | null, rejected: string[], empty: boolean, error: string | null }} the parsed selection.
 */
export function parseRouterReply(reply, allowed) {
  const text = String(reply ?? '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced === null ? text : fenced[1]
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) {
    return { ids: [], cold: [], reason: null, rejected: [], empty: false, error: 'the router reply contained no JSON object' }
  }
  let parsed
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1))
  } catch (error) {
    return {
      ids: [],
      cold: [],
      reason: null,
      rejected: [],
      empty: false,
      error: `the router reply was not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    }
  }

  /** Collect one id list, rejecting every entry the digest did not offer. */
  const collect = (raw, rejected) => {
    const kept = []
    if (!Array.isArray(raw)) return kept
    for (const value of raw) {
      if (typeof value !== 'string') {
        rejected.push(String(value))
        continue
      }
      const trimmed = value.trim()
      if (!allowed.has(trimmed)) {
        rejected.push(trimmed)
        continue
      }
      if (!kept.includes(trimmed)) kept.push(trimmed)
    }
    return kept
  }

  const rejected = []
  const hotRaw = Array.isArray(parsed?.hot_memory_ids) ? parsed.hot_memory_ids : parsed?.ids
  const coldRaw = parsed?.cold_memory_ids
  const ids = collect(hotRaw, rejected)
  const cold = collect(coldRaw, rejected).filter((id) => !ids.includes(id))

  // "Did the router answer with a selection" is a different question from "what did it
  // select". `abstained: true` or an explicit empty list both mean "nothing is hot",
  // and the caller must honour that instead of substituting its own guess.
  const answered = Array.isArray(hotRaw) || Array.isArray(coldRaw) || parsed?.abstained === true

  return {
    ids,
    cold,
    reason: typeof parsed?.reason === 'string' ? parsed.reason.slice(0, 300) : null,
    rejected,
    empty: answered && ids.length === 0,
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
  const strategy = ROUTER_STRATEGIES.includes(input.strategy) ? input.strategy : 'task'
  const digest = buildDigest({
    context: input.context,
    atoms: input.atoms,
    limit: input.limit,
    budget: input.budget,
    instructions: buildRouterInstructions(strategy),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.rank === undefined ? {} : { rank: input.rank }),
    categoryLabels: input.categoryLabels === true,
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
      cold: parsed.cold,
      empty: parsed.empty,
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

  const take = (atom, reasons) => {
    if (selected.length >= input.limit) return false
    const cost = estimateTokens(atom.text) + 2
    if (tokens + cost > input.budget) return false
    tokens += cost
    selected.push({ atom, score: 0, gate: input.gateOf(atom), reasons })
    return true
  }

  /*
   * Standing rules are kept *before* the router is consulted, and the router cannot
   * remove them.
   *
   * This is the structural guarantee the tier used to lack. The router is a model
   * reading a truncated digest; returning `[]`, or a plausible-looking subset that
   * omits the constraint the step is about to violate, are both ordinary model
   * outputs. Letting that replace the deterministic selection meant the cheapest way
   * to lose a hard rule was for the router to be unimpressed by it — precisely the
   * failure this memory exists to prevent. Order is now: standing first, router adds,
   * budget applies last.
   *
   * The standing count keeps the same share cap the deterministic gate uses, so a
   * store with many constraints cannot fill the whole block from this path either.
   */
  const standingCap = Math.max(1, Math.min(input.limit, Math.floor(input.limit * STANDING_BUDGET_SHARE) + 1))
  let standingKept = 0
  const standingFirst = input.atoms.filter((atom) => atom?.standing === true)
  for (const atom of standingFirst) {
    if (standingKept >= standingCap) break
    if (take(atom, ['standing rule: kept regardless of the router'])) standingKept += 1
  }

  for (const id of input.ids) {
    if (selected.some((entry) => entry.atom.id === id)) continue
    const atom = byId.get(id)
    if (atom === undefined) {
      dropped += 1
      continue
    }
    if (!take(atom, ['selected by the router subagent'])) dropped += 1
  }

  return { selected, tokens, dropped, standingKept }
}

/**
 * Render the routed block with provenance that names the router.
 *
 * Cold atoms are appended as *references only*: an id, a one-line gist and the token
 * cost of loading the full text. The point of the hot/cold split is that the model can
 * decide to look one up with `memory_read` instead of paying for every historical
 * detail on every step, so the reference has to say enough to make that decision and
 * not one token more.
 *
 * @param {{ selected: object[], cold?: object[], reason: string | null, offered: number }} input - routed selection.
 * @returns {string} the block, or an empty string when nothing was selected.
 */
export function renderRouted(input) {
  const cold = Array.isArray(input.cold) ? input.cold : []
  if (input.selected.length === 0 && cold.length === 0) return ''
  const parts = []
  if (input.selected.length > 0) {
    const header = ['Recalled project memory (durable atoms, selected by the router subagent):']
    if (input.reason !== null && input.reason !== '') header.push(`Router note: ${input.reason}`)
    parts.push(renderAtoms({ selected: input.selected, header: header.join('\n') }))
  }
  if (cold.length > 0) {
    const lines = [
      'Older project memory matching this request, NOT loaded (call memory_read with the id to see it):',
    ]
    for (const atom of cold) {
      const gist = atom.text.length > 120 ? `${atom.text.slice(0, 117)}...` : atom.text
      lines.push(`- ${atom.id} [${atom.kind}] ~${estimateTokens(atom.text)} tokens: ${gist}`)
    }
    parts.push(lines.join('\n'))
  }
  return parts.join('\n\n')
}
