/**
 * The evidence-recovery funnel: at which stage does a question's evidence stop being
 * recoverable?
 *
 * `recoverability.mjs` reports two numbers — a ceiling ("the evidence atom exists") and a
 * delivered rate ("recall returns it"). A gap between them says *something* is lost, but
 * not *where*. The two plausible causes need opposite fixes:
 *
 * - **Extraction Miss** — the fact was never stored. Re-weighting the ranking cannot
 *   recover a string that is not in the store; only the extractor can.
 * - **Ranking / budget miss** — the fact is stored but did not reach the block. This is
 *   where tuning scoring weights, the limit, or the token budget actually helps.
 *
 * Guessing between them wastes an entire paid run, which is why this stage is measured
 * before any answer call.
 *
 * ## What each stage means in the real code
 *
 * | stage | the code it observes |
 * |---|---|
 * | `extraction` | the atom store on disk (`atoms.jsonl`) |
 * | `candidate` | `gateAtoms`: the atom was scored **and** its kind's expert activated |
 * | `selected` | `gateAtoms`: `take()` admitted it within `recallLimit` and `recallBudget` |
 * | `injected` | the rendered block returned by `recallForStep` |
 * | `answer` | a **stored** judge verdict from an earlier run — not computed here |
 *
 * `injected` is a consistency check, not a separate drop point. With `routerTier: 'off'`
 * the budget is already enforced inside `take()`, so everything selected is rendered and
 * `injected` must equal `selected`. If it does not, rendering lost an atom that selection
 * had kept — a defect, not a budget effect. The stage only becomes an independent drop
 * point when the router re-selects, and the router has never run against a live model,
 * so no such number is claimed here.
 *
 * ## Ground truth discipline
 *
 * Coverage is decided from the dataset's `evidence[]` annotations — session id plus raw
 * turn index — never from the reference answer. Searching for the answer's own words
 * would hand the retriever a paraphrase of the target and measure nothing. This is the
 * same rule `oracle.mjs` follows, and it is the difference between a diagnostic and a
 * mirror.
 *
 * ## Cost
 *
 * Extraction (the only step that calls a model) is read from the on-disk cache written
 * by `atoms.mjs`. This script therefore makes **no model calls and needs no API key**;
 * it refuses loudly if the cache is absent rather than silently triggering extraction.
 *
 * Run: node scripts/bench/funnel.mjs [projectId] [questionLimit]
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { BENCH, loadSessions } from './lib.mjs'
import { CACHE } from './atoms.mjs'
import { recallFor, seedStore } from './memory-arm.mjs'
import { readAtoms } from '../../core/memory.js'

/** The sample seed the scored runs use, so ids line up with a stored judge verdict. */
const SAMPLE_SEED = 'codememo-v1'

/**
 * The distinctive values a reference answer needs.
 *
 * These are the strings that make an answer *specific*: pinned versions, hashes, dotted
 * versions, and long identifiers. They are read from the answer because the question the
 * funnel asks is "did we save the value the answer needs", and only the answer names it.
 *
 * This does **not** violate the rule `oracle.mjs` follows. That rule forbids building the
 * *context handed to the model* out of the answer's own words, because the model would
 * then be reading a paraphrase of the target. Here the values are used only as a probe
 * over a store that was built before the answer was opened: an atom either already
 * contains `croniter 1.3.8` or it does not. Nothing is written and no model sees it. It
 * is the same criterion `recoverability.mjs` already uses, which keeps the two scripts
 * comparable instead of quietly disagreeing.
 *
 * @param {string} reference - the reference answer.
 * @returns {string[]} lowercase probes, most specific first.
 */
export function probesOf(reference) {
  const text = String(reference)
  const out = new Set()
  for (const match of text.matchAll(/[0-9a-f]{12,}/gi)) out.add(match[0].toLowerCase())
  for (const match of text.matchAll(/\d+\.\d+\.\d+/g)) out.add(match[0].toLowerCase())
  for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{7,}/g)) out.add(match[0].toLowerCase())
  return [...out]
}

/**
 * The atoms that carry any of a question's probes.
 *
 * Matching is on the probe as a substring of the atom text, and the atoms are identified
 * by id so the four stages can be tracked without ambiguity. An earlier version tested
 * whether the *rendered block* contained a token, which reported `injected` for atoms
 * the block never held — a different atom sharing one word was enough to fake a hit. The
 * id is the only safe handle.
 *
 * @param {object[]} atoms - stored atoms.
 * @param {string[]} probes - lowercase probes.
 * @returns {object[]} carrying atoms.
 */
export function atomsCarrying(atoms, probes) {
  if (probes.length === 0) return []
  return atoms.filter((atom) => {
    const text = String(atom.text ?? '').toLowerCase()
    return probes.some((probe) => text.includes(probe))
  })
}

/** A deterministic sample, identical to the scored runs. */
export function sampleQuestions(questions, limit) {
  return questions
    .map((item) => ({ item, key: createHash('sha256').update(`${SAMPLE_SEED}:${item.id}`).digest('hex') }))
    .sort((left, right) => (left.key < right.key ? -1 : 1))
    .slice(0, limit)
    .map((entry) => entry.item)
}

/**
 * Resolve one question's labelled evidence turns to their text.
 *
 * `turn_index` indexes the session file's raw records, not the filtered conversation, so
 * the lookup goes through `turn.rawIndex`. Assuming the two were the same made most
 * annotations land outside their session in an earlier harness.
 *
 * @param {Map<string, any>} sessions - session id → session.
 * @param {object} question - one dataset question.
 * @returns {{ resolved: string[], missing: string[] }} evidence text and what failed.
 */
export function resolveEvidence(sessions, question) {
  const resolved = []
  const missing = []
  for (const evidence of question.evidence ?? []) {
    const session = sessions.get(evidence.session_id)
    if (session === undefined) {
      missing.push(`${evidence.session_id}: session not in corpus`)
      continue
    }
    const turn = session.turns.find((candidate) => candidate.rawIndex === Number(evidence.turn_index))
    if (turn === undefined) {
      missing.push(`${evidence.session_id}#${evidence.turn_index}: not a user/assistant turn`)
      continue
    }
    resolved.push(turn.text)
  }
  return { resolved, missing }
}

/**
 * The ISO stamp inside a stored result filename.
 *
 * Parsed with a pattern anchored on the ISO shape rather than by splitting on `-`:
 * `project_01_cli_tool-2026-…` and a project id containing dashes both defeat a naive
 * split, and picking the wrong file means reporting a superseded run.
 *
 * @param {string} name - a result filename.
 * @returns {string | null} the stamp, or null when the name carries none.
 */
export function runStampOf(name) {
  const match = /-(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.json$/.exec(name)
  return match === null ? null : match[1]
}

/**
 * Load the newest plain run for a project and index arm C's verdicts by question.
 *
 * Phase-2/3 files are excluded: they change several variables at once, so their verdicts
 * are not comparable to the four-stage recall path measured here.
 *
 * @param {string} projectId - project id.
 * @returns {{ source: string, verdicts: Map<string, string>, atoms: number|null } | null} the run, or null.
 */
export function loadStoredVerdicts(projectId) {
  const dir = path.join(BENCH, 'results')
  if (!existsSync(dir)) return null
  const candidates = readdirSync(dir)
    .filter((name) => name.startsWith(`${projectId}-`) && !name.startsWith('phase'))
    .map((name) => ({ name, stamp: runStampOf(name) }))
    .filter((entry) => entry.stamp !== null)
    .sort((left, right) => (left.stamp < right.stamp ? 1 : -1))
  if (candidates.length === 0) return null
  const chosen = candidates[0]
  const parsed = JSON.parse(readFileSync(path.join(dir, chosen.name), 'utf8'))
  const verdicts = new Map()
  for (const row of parsed.rows ?? []) {
    const verdict = row?.arms?.C?.verdict
    if (typeof row?.id === 'string' && typeof verdict === 'string') verdicts.set(row.id, verdict)
  }
  return { source: chosen.name, verdicts, atoms: Number.isInteger(parsed.atoms) ? parsed.atoms : null }
}

/**
 * Classify one question through the four measurable stages.
 *
 * @param {{ question: object, atoms: object[], sessions: Map<string, any>, root: string }} input - material.
 * @returns {Promise<object>} the per-question funnel record.
 */
export async function funnelForQuestion(input) {
  const { question, atoms, extractedAtoms, sessions, root } = input
  const { resolved, missing } = resolveEvidence(sessions, question)
  const record = {
    id: question.id,
    evidenceTurns: resolved.length,
    ...(missing.length === 0 ? {} : { evidenceMissing: missing }),
  }
  if (resolved.length === 0) return { ...record, evidenceResolvable: false, firstMiss: 'evidence' }
  record.evidenceResolvable = true

  const probes = probesOf(question.answer_short ?? question.answer)
  record.probes = probes.length

  /*
   * Two different questions, kept apart on purpose.
   *
   * `extracted` asks whether the extractor ever produced an atom carrying the evidence.
   * `retained` asks whether that atom survived into the store the plugin actually reads.
   * They differ whenever the store is at `MAX_LIVE_ATOMS` and pruning evicts a record.
   *
   * Folding them together mislabels an eviction as an extraction failure, and the two
   * need opposite fixes: a real extraction miss is an extractor problem, while an
   * eviction is a capacity/pruning problem. On the 806-atom project here the bench
   * seeds every atom with an identical timestamp and weight, so retention scores tie and
   * pruning degenerates to store order — which makes the distinction louder, not less
   * necessary to report.
   */
  const extractedCarrying = atomsCarrying(extractedAtoms ?? atoms, probes)
  const retainedCarrying = atomsCarrying(atoms, probes)
  const retainedIds = new Set(retainedCarrying.map((atom) => atom.id))
  record.extracted = extractedCarrying.length > 0
  record.retained = retainedCarrying.length > 0
  record.atomsCarrying = retainedCarrying.length
  record.atomsExtracted = extractedCarrying.length

  const { recall } = await recallFor(root, question.question)
  const gating = recall?.gating
  const selectedIds = new Set((gating?.selected ?? []).map((entry) => entry.atom.id))
  const activatedKinds = new Set(
    (gating?.experts ?? []).filter((expert) => expert.activated === true).map((expert) => expert.kind),
  )

  // Candidate = scored and its kind's expert activated: eligible for `take()`.
  const candidateHit = retainedCarrying.some((atom) => activatedKinds.has(atom.kind))
  const selectedHit = retainedCarrying.some((atom) => selectedIds.has(atom.id))

  /*
   * Injected is decided by atom id, not by string-searching the block.
   *
   * The block is plain text with no ids in it, so membership has to come from the
   * selection the renderer was handed. With `routerTier: 'off'` the budget is already
   * enforced inside `take()`, so `injected` must equal `selected`; a difference means
   * rendering dropped an atom that selection kept. That is a defect, and the report says
   * so rather than presenting it as a fifth budget stage.
   */
  const injectedHit = recall?.ok === true && [...selectedIds].some((id) => retainedIds.has(id))
  record.activatedKinds = activatedKinds.size
  record.candidate = candidateHit
  record.selected = selectedHit
  record.injected = injectedHit
  record.recallAtoms = Number.isInteger(recall?.atoms) ? recall.atoms : 0
  record.recallTokens = Number.isInteger(recall?.tokens) ? recall.tokens : 0
  if (typeof recall?.reason === 'string' && recall.ok !== true) record.recallReason = recall.reason

  const stages = [
    ['extraction', record.extracted],
    ['retained', record.retained],
    ['candidate', candidateHit],
    ['selected', selectedHit],
    ['injected', injectedHit],
  ]
  const failed = stages.find(([, passed]) => passed !== true)
  record.firstMiss = failed === undefined ? null : failed[0]

  /*
   * Why stored evidence was not selected.
   *
   * A carrying atom need not match the *question*: it states the value, it does not
   * necessarily repeat the ask. Separating the two stops a vocabulary mismatch from
   * being read as a scoring defect, which would send the next change to the wrong file.
   */
  const questionText = String(question.question).toLowerCase()
  record.questionOverlap = probes.filter((probe) => questionText.includes(probe)).length
  record.selectionMissKind = selectedHit || !record.retained || !candidateHit
    ? null
    : (record.questionOverlap === 0 ? 'no lexical overlap with the question' : 'overlapped but ranked out or over budget')

  return record
}

// ---------------------------------------------------------------- reporting

/**
 * Render one project's funnel.
 *
 * @param {string} projectId - project id.
 * @param {object[]} records - per-question funnel records.
 * @param {{ source: string, verdicts: Map<string, string>, atoms: number|null } | null} stored - stored verdicts.
 * @returns {string} the report.
 */
export function renderFunnel(projectId, records, stored) {
  const measurable = records.filter((record) => record.evidenceResolvable === true)
  const n = measurable.length
  const count = (key) => measurable.filter((record) => record[key] === true).length
  const pct = (value) => (n === 0 ? '0.0%' : `${((value / n) * 100).toFixed(1)}%`)

  const lines = []
  lines.push(`=== ${projectId} — evidence-recovery funnel (no model calls) ===`)
  lines.push(`questions: ${records.length}  with resolvable evidence: ${n}`)
  const unresolvable = records.length - n
  if (unresolvable > 0) lines.push(`evidence annotations that did not resolve: ${unresolvable} (excluded from the funnel)`)

  const stages = [
    ['extraction (atom produced)', count('extracted')],
    ['retained   (survived the store cap)', count('retained')],
    ['candidate  (expert active)', count('candidate')],
    ['selected   (within limit+budget)', count('selected')],
    ['injected   (in rendered block)', count('injected')],
  ]
  lines.push('')
  let previous = null
  for (const [label, value] of stages) {
    const delta = previous === null ? '' : `   (-${previous - value})`
    lines.push(`  ${label.padEnd(34)} ${String(value).padStart(3)}  ${pct(value).padStart(6)}${delta}`)
    previous = value
  }

  // The first stage that fails is the actionable one.
  const byMiss = new Map()
  for (const record of measurable) {
    const key = record.firstMiss ?? 'none'
    byMiss.set(key, (byMiss.get(key) ?? 0) + 1)
  }
  lines.push('')
  lines.push('first failing stage:')
  for (const key of ['extraction', 'retained', 'candidate', 'selected', 'injected', 'none']) {
    if ((byMiss.get(key) ?? 0) === 0) continue
    const label = key === 'none' ? 'reached the block' : key
    lines.push(`  ${label.padEnd(34)} ${String(byMiss.get(key)).padStart(3)}`)
  }

  /*
   * Name the dominant loss, and only that one.
   *
   * An earlier version printed "the bottleneck is extraction" whenever the extraction
   * count was non-zero, which called 2 of 38 a bottleneck while 4 downstream misses went
   * unmentioned. The sentence has to follow the largest gap between consecutive stages,
   * or it recommends fixing the wrong file.
   */
  const gaps = [
    { stage: 'extraction', lost: n - count('extracted') },
    { stage: 'retained', lost: count('extracted') - count('retained') },
    { stage: 'candidate', lost: count('retained') - count('candidate') },
    { stage: 'selected', lost: count('candidate') - count('selected') },
    { stage: 'injected', lost: count('selected') - count('injected') },
  ].sort((left, right) => right.lost - left.lost)
  const dominant = gaps[0]

  /*
   * A selection loss has two very different causes, so the advice splits on them.
   *
   * `atomsCarrying` matches by value (`croniter 1.3.8`), while `gateAtoms` scores by
   * vocabulary overlap with the question. An atom can state the needed value and share no
   * word with the ask — "which version did we pin and why did we move off dateutil" gives
   * the scorer almost nothing to match against an atom that only says `croniter==1.3.8`.
   *
   * When that is the dominant cause, re-weighting is not a tuning opportunity, it is a
   * dead end: there is no shared term for a weight to multiply. The honest advice is that
   * the lexical scorer cannot reach it and the fix has to widen recall (semantic index,
   * router, or a category channel), not redistribute score.
   */
  const selectionMisses = measurable.filter((record) => record.selectionMissKind !== null)
  const noOverlap = selectionMisses.filter((record) => record.selectionMissKind === 'no lexical overlap with the question').length
  const rankedOut = selectionMisses.length - noOverlap

  const dominantSelectionIsVocabulary = dominant.stage === 'selected' && noOverlap > rankedOut

  lines.push('')
  if (n === 0) {
    lines.push('No question in this sample resolved to evidence text, so no stage can be measured.')
  } else if (count('injected') === n) {
    lines.push('No stage loses the evidence on this sample: every question with resolvable evidence')
    lines.push('reached the block. A wrong answer here is an attribution problem, not recall.')
  } else if (dominant.lost === 0) {
    lines.push('No single stage dominates the loss; re-run before drawing a conclusion.')
  } else if (dominant.stage === 'extraction') {
    lines.push(`The largest loss is extraction: ${dominant.lost}/${n} question(s) have no atom carrying`)
    lines.push('the evidence, not even before pruning. Ranking weights, `recallLimit` and')
    lines.push('`recallBudget` cannot recover those; only the extractor can. Fix coverage first,')
    lines.push('then re-measure before touching scoring.')
  } else if (dominant.stage === 'retained') {
    lines.push(`The largest loss is retention: ${dominant.lost} question(s) had an atom carrying the`)
    lines.push('evidence, but it did not survive into the store the plugin reads. The store is at')
    lines.push('`MAX_LIVE_ATOMS` and pruning evicted it. This is a capacity/pruning problem, not a')
    lines.push('ranking one — tuning weights cannot bring back a record that is no longer on disk.')
  } else if (dominantSelectionIsVocabulary) {
    lines.push(`The largest loss is selection, and its dominant cause is vocabulary, not ranking:`)
    lines.push(`${noOverlap} of ${dominant.lost} question(s) have a stored atom carrying the evidence that`)
    lines.push('shares no term with the question. Re-weighting cannot fix that — there is no shared')
    lines.push('token for a weight to multiply. Widening recall (a semantic index, the router, or a')
    lines.push('category channel) is the only thing that reaches these; only')
    lines.push(`${rankedOut} miss(es) are a genuine ranked-out-or-over-budget case.`)
  } else if (dominant.stage === 'selected') {
    lines.push(`The largest loss is selection: ${dominant.lost} question(s) have an atom carrying the`)
    lines.push('evidence, in an activated kind, that was not taken within `recallLimit`/`recallBudget`.')
    lines.push(`Here ${rankedOut} of those DID share terms with the question and still lost, which is the`)
    lines.push('case scoring weights and the limit/budget actually govern.')
  } else if (dominant.stage === 'candidate') {
    lines.push(`The largest loss is the expert gate: ${dominant.lost} question(s) have a carrying atom`)
    lines.push('whose kind never activated, so `take()` never saw it. Raise `maxExperts` or the')
    lines.push('activation threshold; scoring weights alone will not reach it.')
  } else {
    lines.push(`Rendering dropped ${dominant.lost} atom(s) that selection had kept. That is a defect,`)
    lines.push('not a budget effect: with the router off, `injected` must equal `selected`.')
  }
  const others = gaps.slice(1).filter((gap) => gap.lost > 0)
  if (others.length > 0) {
    lines.push('')
    lines.push(`secondary losses: ${others.map((gap) => `${gap.stage} ${gap.lost}`).join(', ')}`)
  }

  // Why a stored-evidence question still failed to be selected.
  if (selectionMisses.length > 0) {
    lines.push('')
    lines.push('why stored evidence was not selected:')
    const kinds = new Map()
    for (const record of selectionMisses) kinds.set(record.selectionMissKind, (kinds.get(record.selectionMissKind) ?? 0) + 1)
    for (const [kind, value] of [...kinds].sort((left, right) => right[1] - left[1])) {
      lines.push(`  ${String(value).padStart(3)}  ${kind}`)
    }
  }

  // Answer correctness is read, never computed, and only where a run exists.
  if (stored === null) {
    lines.push('')
    lines.push('answer_correct: no stored run for this project, so the last stage is unmeasured.')
  } else {
    const withVerdict = measurable.filter((record) => stored.verdicts.has(record.id))
    if (withVerdict.length === 0) {
      lines.push('')
      lines.push(`answer_correct: ${stored.source} holds no verdict for this sample.`)
    } else {
      const correct = withVerdict.filter((record) => stored.verdicts.get(record.id) === 'CORRECT').length
      lines.push('')
      lines.push(`answer_correct: ${correct}/${withVerdict.length} CORRECT (${pct(correct)}), read from ${stored.source}`)
      lines.push('')
      lines.push('  stage reached          n   correct')
      for (const key of ['extraction', 'retained', 'candidate', 'selected', 'injected', 'none']) {
        const group = withVerdict.filter((record) => (record.firstMiss ?? 'none') === key)
        if (group.length === 0) continue
        const right = group.filter((record) => stored.verdicts.get(record.id) === 'CORRECT').length
        lines.push(`  ${key.padEnd(20)} ${String(group.length).padStart(3)}   ${right}`)
      }
      lines.push('')
      lines.push('These are descriptive counts on one sample, not an effect size: no interval is')
      lines.push('computed and none should be quoted as one. The verdict came from a specific')
      lines.push('model and judge on a specific day; it is evidence about that run, not a constant.')
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------- main

async function main() {
  const projectId = process.argv[2] ?? 'project_02_multi_repo_tool'
  const limit = Number(process.argv[3] ?? '40')

  const cacheFile = path.join(CACHE, `${projectId}.json`)
  if (!existsSync(cacheFile)) {
    console.error(`no atom cache at ${cacheFile}`)
    console.error('This script never calls a model. Build the store first with:')
    console.error(`  node scripts/bench/codememo.mjs --project ${projectId} --questions ${limit}`)
    process.exit(2)
  }
  const cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
  const atoms = cached.atoms
  console.log(`atoms: ${atoms.length} from cache ${path.basename(cacheFile)}`)

  const sessions = loadSessions(projectId)
  const sessionMap = new Map(sessions.map((session) => [session.id, session]))
  const questions = JSON.parse(readFileSync(path.join(BENCH, `${projectId}-questions.json`), 'utf8'))
  const sampled = sampleQuestions(questions, limit)

  // Seed the same throwaway root the scored runs used, then measure against what the
  // store actually holds. The cache carries `kind`/`text` but no id — an atom's id is a
  // content hash assigned by `normalizeAtom`, the same one the plugin computes — so
  // comparing cache records against ids from `gateAtoms` would compare against
  // `undefined` and report every selection as a miss. Reading the store back is also the
  // more honest target: it is the file the plugin reads at runtime.
  const root = path.join(BENCH, 'plugin-root', projectId)
  const seeded = await seedStore(root, atoms.map((atom) => ({ kind: atom.kind, text: atom.text, tags: atom.tags })))
  const stored = readAtoms(root)
  if (stored.ok !== true) {
    console.error(`cannot read back the seeded store: ${stored.reason}`)
    process.exit(2)
  }
  const storedAtoms = stored.live
  console.log(`store: ${seeded.written} atoms written, ${storedAtoms.length} live`)
  if (storedAtoms.length < atoms.length) {
    console.log(`note: pruning evicted ${atoms.length - storedAtoms.length} atom(s); the funnel reports`)
    console.log('      extraction and retention as separate stages so the two are not confused.')
  }

  const records = []
  for (const question of sampled) {
    records.push(await funnelForQuestion({
      question,
      atoms: storedAtoms,
      extractedAtoms: atoms,
      sessions: sessionMap,
      root,
    }))
  }

  const storedRun = loadStoredVerdicts(projectId)
  const report = renderFunnel(projectId, records, storedRun)
  console.log('')
  console.log(report)

  const dir = path.join(BENCH, 'funnel')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outFile = path.join(dir, `${projectId}-${stamp}.json`)
  writeFileSync(outFile, JSON.stringify({
    projectId,
    sampleSeed: SAMPLE_SEED,
    limit,
    atoms: atoms.length,
    storedRun: storedRun === null ? null : storedRun.source,
    records,
  }, null, 1), 'utf8')
  console.log('')
  console.log(`wrote ${path.relative(path.join(BENCH, '..', '..'), outFile)}`)
}

// Only run when invoked directly, so the exports stay importable by a test.
if (process.argv[1] !== undefined && import.meta.filename === path.resolve(process.argv[1])) {
  await main()
}
