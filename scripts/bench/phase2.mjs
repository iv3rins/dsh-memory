/**
 * Phase 2: per-question failure attribution and the oracle ceiling.
 *
 * Phase 1 reported three accuracy numbers. This answers *why* arm C failed on a given
 * question, using only evidence that can be observed: what the extractor wrote, what the
 * candidate set contained, what recall returned, what reached the context, and what the
 * model said.
 *
 * The attribution ladder is ordered by where in the pipeline a loss occurs, and each
 * rung is decided by a fact, not a guess:
 *
 *   1. EXTRACTION_FAILURE   no stored atom carries the evidence's distinctive values
 *   2. RETRIEVAL_FAILURE    a matching atom exists but the candidate set never held it
 *   3. RANKING_FAILURE      it was a candidate but the final selection dropped it
 *   4. BUDGET_FAILURE       it ranked high but the token ceiling cut it
 *   5. DELIVERY_FAILURE     it was selected but the rendered block does not contain it
 *   6. REASONING_FAILURE    the evidence reached the context and the answer was still wrong
 *   7. INSUFFICIENT_EVIDENCE the evidence resolved but carries none of the answer's values
 *   8. UNKNOWN              none of the above could be established
 *
 * Steps 2–5 are gated on step 1: if nothing was extracted, the later rungs cannot have
 * happened, and reporting RANKING_FAILURE for an atom that was never extracted is the
 * exact form of guessing this report must avoid.
 *
 * Run:
 *   node scripts/bench/phase2.mjs --project project_01_cli_tool --questions 40
 *   node scripts/bench/phase2.mjs --all
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { BENCH, OUT, MODEL, JUDGE_MODEL, apiKey, answer, compact, estimateTokens, flatten, judge, loadSessions, tailWithin } from './lib.mjs'
import { buildAtoms } from './atoms.mjs'
import { recallFor, seedStore } from './memory-arm.mjs'
import { buildOracleContext, loadProjectMaterial } from './oracle.mjs'

const TAIL_BUDGET = 6000
const SUMMARY_BUDGET = 2000
/** An atom "carries" the evidence when it contains one of these. */
const VALUE_PATTERN = /\b\d+\.\d+\.\d+\b|[0-9a-f]{16,}|[A-Za-z_][A-Za-z0-9_]{8,}/g

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const runAll = args.includes('--all')
const projects = runAll
  ? ['project_01_cli_tool', 'project_02_multi_repo_tool']
  : [flag('project', 'project_01_cli_tool')]
const questionCount = Number(flag('questions', '40'))

/**
 * Distinctive values a correct answer must contain.
 *
 * Three tiers, and each was added because the previous one alone mislabelled real rows:
 *
 * 1. **identifiers** — version strings, hashes, long code-like tokens. Unambiguous.
 * 2. **multi-digit numbers** — three digits or more. Two-digit numbers were tried and
 *    removed: `26`, `36`, `87` appear by coincidence in any long store, so a "match" on
 *    them proved nothing and turned ranking losses into reasoning losses.
 * 3. **content words** — the longest non-stopword terms, lowercased. Without this every
 *    prose answer became UNKNOWN, including seven the oracle answered correctly.
 *
 * The result is used two ways: any hit means "the pipeline had something to work with",
 * and a *strict* check (see `stronglyCovered`) requires an identifier or two words so an
 * incidental number cannot be mistaken for evidence.
 */
function referenceValues(question) {
  const text = String(question.answer_short ?? question.answer)
  const values = new Set()

  // `v0.12.0` is a version with a prefix letter; matching only `\d+\.\d+\.\d+` missed it
  // and left three questions with no inspectable value at all.
  for (const match of text.match(/\bv?\d+\.\d+\.\d+\b|[0-9a-f]{16,}|[A-Za-z_][A-Za-z0-9_]{8,}/g) ?? []) {
    values.add(match.toLowerCase())
    // Also keep the unprefixed form, because the store may write either.
    if (/^v\d/.test(match)) values.add(match.slice(1).toLowerCase())
  }
  // Three digits or more: durations, counts, thresholds. Short numbers are noise.
  for (const match of text.match(/\b\d{3,}\b/g) ?? []) values.add(match.toLowerCase())

  const STOP = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'was', 'were', 'are', 'not',
    'but', 'had', 'has', 'have', 'been', 'they', 'then', 'than', 'its', 'into', 'when',
    'which', 'there', 'their', 'because', 'would', 'could', 'should', 'about', 'after',
    'before', 'while', 'also', 'only', 'more', 'most', 'some', 'such', 'each', 'other',
    'session', 'sessions', 'answer', 'question', 'reference', 'instead', 'rather',
  ])
  const words = (text.toLowerCase().match(/[a-z][a-z-]{5,}/g) ?? []).filter((word) => STOP.has(word) === false)
  const ranked = [...new Set(words)].sort((left, right) => right.length - left.length).slice(0, 4)
  for (const word of ranked) values.add(word)

  return [...values]
}

/**
 * Whether a text carries *convincing* evidence, not an incidental token.
 *
 * A single content word can collide with unrelated prose; a version string cannot. So a
 * strict hit needs either an identifier, or two independent content words.
 *
 * @param {string} text - the rendered context, lowercased.
 * @param {string[]} values - the question's distinctive values.
 * @returns {boolean} whether the text convincingly covers the answer.
 */
export function stronglyCovered(text, values) {
  const identifier = /^v?\d+\.\d+\.\d+$|^[0-9a-f]{16,}$|^[a-z_][a-z0-9_]{8,}$/
  const identifiers = values.filter((value) => identifier.test(value))
  if (identifiers.length > 0) return identifiers.some((value) => text.includes(value))
  const words = values.filter((value) => /^[a-z][a-z-]{4,}$/.test(value))
  const hits = words.filter((value) => text.includes(value))
  return hits.length >= 2
}

/** Deterministic sample, identical to the Phase 1 run so the rows pair up. */
function sample(items, count) {
  return items
    .map((item) => ({ item, key: createHash('sha256').update(`codememo-v1:${item.id}`).digest('hex') }))
    .sort((left, right) => (left.key < right.key ? -1 : 1))
    .slice(0, count)
    .map((entry) => entry.item)
}

/**
 * Classify one question's arm-C failure from observable facts.
 *
 * `PARTIAL` is treated as a failure with a separate label: the answer was close but
 * incomplete, which is a different defect from "wrong", and collapsing the two would
 * hide exactly the case memory is supposed to improve.
 *
 * @param {object} input - everything observed for this question.
 * @returns {{ category: string, detail: string }} the attribution.
 */
export function attribute(input) {
  const {
    verdict,
    values,
    matchingAtoms,
    candidateIds,
    selectedIds,
    deliveredText,
    oracleOk,
    oracleHasValue,
  } = input

  // A correct answer needs no failure attributed to it.
  if (verdict === 'CORRECT') return { category: 'NONE', detail: 'answered correctly' }

  // UNKNOWN is reserved for the case where the question itself gives us nothing to test
  // against: no distinctive values means this classifier cannot see success or failure.
  if (values.length === 0) {
    return { category: 'UNKNOWN', detail: 'the reference answer carries no distinctive value, so the pipeline cannot be inspected' }
  }

  const matchingIds = matchingAtoms.map((atom) => atom.id)
  if (matchingIds.length === 0) {
    // Before blaming extraction, check the evidence itself: if the annotated evidence
    // never contained those values, no extractor could have produced them.
    if (oracleOk === true && oracleHasValue === false) {
      return {
        category: 'INSUFFICIENT_EVIDENCE',
        detail: 'the labelled evidence does not contain the answer values, so nothing downstream could recover them',
      }
    }
    return { category: 'EXTRACTION_FAILURE', detail: `no stored atom contains any of: ${values.slice(0, 3).join(', ')}` }
  }

  const inCandidates = matchingIds.some((id) => candidateIds.includes(id))
  if (inCandidates !== true) {
    return { category: 'RETRIEVAL_FAILURE', detail: `${matchingIds.length} matching atom(s) exist but none entered the candidate set` }
  }

  // Whether the value is *convincingly* present in what the model was shown. A bare
  // substring hit on a short number would otherwise count as delivery and push the
  // blame onto the model for a loss the pipeline actually caused.
  const valueInBlock = stronglyCovered(deliveredText, values)

  const inSelection = matchingIds.some((id) => selectedIds.includes(id))
  if (inSelection !== true) {
    return {
      category: 'RANKING_FAILURE',
      detail: `${matchingIds.length} matching atom(s) were candidates but the final ${selectedIds.length} did not include them`,
    }
  }

  if (valueInBlock !== true) {
    return {
      category: 'DELIVERY_FAILURE',
      detail: 'a matching atom was selected but none of its values appear in the rendered block',
    }
  }

  // The values reached the prompt. Anything still wrong is the model's use of them.
  return {
    category: 'REASONING_FAILURE',
    detail: verdict === 'PARTIAL'
      ? 'the values reached the context and the answer used some of them but not all'
      : 'the values reached the context and the answer was still wrong',
  }
}

const main = async () => {
  const key = apiKey()
  mkdirSync(OUT, { recursive: true })
  const allRows = []

  for (const projectId of projects) {
    const sessions = loadSessions(projectId)
    const material = loadProjectMaterial(projectId)
    material.sessionMap = material.sessions
    const chosen = sample(material.questions, questionCount)

    console.log(`\n### ${projectId}: ${chosen.length} questions, ${sessions.length} sessions`)

    // --- One-time build cost, measured per call so it can be separated from query cost.
    const transcript = flatten(sessions)
    let buildInput = 0
    let buildOutput = 0
    let buildLatency = 0

    const compactStarted = Date.now()
    const compacted = await compact(key, transcript, SUMMARY_BUDGET)
    buildLatency += Date.now() - compactStarted

    const atomsStarted = Date.now()
    const atoms = await buildAtoms(projectId, sessions, key)
    buildLatency += Date.now() - atomsStarted

    const storeRoot = path.join(BENCH, 'plugin-root', projectId)
    const seeded = await seedStore(storeRoot, atoms.map((atom) => ({ kind: atom.kind, text: atom.text, tags: atom.tags })))
    const storedAtoms = await (async () => {
      const { readAtoms } = await import('../../core/memory.js')
      const read = readAtoms(storeRoot)
      return read.ok === true ? read.live : []
    })()
    console.log(`store: live ${seeded.result.live} | summary ~${estimateTokens(compacted.summary)} tok`)

    // --- Per question.
    for (const [index, question] of chosen.entries()) {
      const values = referenceValues(question)
      const reference = question.answer_short ?? question.answer

      const recall = await recallFor(storeRoot, question.question)
      const recalled = recall.recall
      const selectedIds = recalled.ok === true ? (recalled.ids ?? []) : []

      // The text the model is actually given. This must be the assembled context, not just
      // the recall block: Phase 2 originally measured delivery against `recalled.block`
      // alone while handing the model the summary *plus* that block, which produced 13
      // false DELIVERY_FAILURE labels. A fact delivered by the summary counted as missing.
      const context = recalled.ok === true
        ? `=== PROJECT NOTES (compacted) ===\n${compacted.summary}\n\n${recalled.block}`
        : `=== PROJECT NOTES (compacted) ===\n${compacted.summary}`
      const deliveredText = context.toLowerCase()
      const recallBlockText = (recalled.ok === true ? recalled.block : '').toLowerCase()

      // Candidate set: what the gate considered before the final cut.
      const candidateIds = recalled.ok === true && recalled.gating !== undefined
        ? [...recalled.gating.selected, ...recalled.gating.excluded].map((entry) => entry.atom.id)
        : []

      const matchingAtoms = values.length === 0
        ? []
        : storedAtoms.filter((atom) => values.some((value) => atom.text.toLowerCase().includes(value)))

      const oracle = buildOracleContext(material, question)
      const oracleHasValue = oracle.ok === true
        ? stronglyCovered(oracle.text.toLowerCase(), values)
        : false

      const answered = await answer(key, context, question.question)
      const graded = await judge(key, question.question, reference, answered.answer)

      const attribution = attribute({
        verdict: graded.verdict,
        values,
        matchingAtoms,
        candidateIds,
        selectedIds,
        deliveredText,
        oracleOk: oracle.ok === true,
        oracleHasValue,
      })

      // A delivered id is one whose own text is present in the recall block. Note the
      // distinction from `deliveredText`: an atom is "rendered" by the recall block, while
      // a fact is "delivered to the model" if it appears anywhere in the assembled context,
      // including the summary. Conflating those two questions is what made the delivery
      // count wrong.
      const deliveredIds = selectedIds.filter((id) => {
        const atom = storedAtoms.find((entry) => entry.id === id)
        if (atom === undefined) return false
        // Compare a distinctive slice, not the whole sentence: the renderer may wrap it.
        const probe = atom.text.toLowerCase().slice(0, 60)
        return probe.length > 0 && recallBlockText.includes(probe)
      })

      // --- Oracle arm: same model, temperature, judge, question. Evidence only.
      let oracleRow = null
      if (oracle.ok === true) {
        const oracleAnswer = await answer(key, oracle.text, question.question)
        const oracleGraded = await judge(key, question.question, reference, oracleAnswer.answer)
        oracleRow = {
          verdict: oracleGraded.verdict,
          answer: oracleAnswer.answer.slice(0, 800),
          reason: oracleGraded.reason,
          contextTokens: oracle.tokens,
          inputTokens: oracleAnswer.usage.input,
          outputTokens: oracleAnswer.usage.output,
          latencyMs: oracleAnswer.latencyMs,
          judgeLatencyMs: oracleGraded.latencyMs,
          judgeInputTokens: oracleGraded.usage.input,
          judgeOutputTokens: oracleGraded.usage.output,
          usedTurns: oracle.usedTurns,
        }
      } else {
        oracleRow = { verdict: 'UNRESOLVED', reason: oracle.reason }
      }

      allRows.push({
        question_id: question.id,
        project_id: projectId,
        category: question.category,
        ground_truth: reference,
        predicted_answer: answered.answer.slice(0, 800),
        verdict: graded.verdict,
        judge_reason: graded.reason,
        required_source_ids: (question.evidence ?? []).map((entry) => `${entry.session_id}#${entry.turn_index}`),
        required_values: values,
        extracted_memory_ids: matchingAtoms.map((atom) => atom.id),
        retrieved_memory_ids: selectedIds,
        candidate_memory_ids: candidateIds,
        delivered_memory_ids: deliveredIds,
        actual_context_tokens: estimateTokens(context),
        input_tokens: answered.usage.input,
        output_tokens: answered.usage.output,
        latency_ms: answered.latencyMs,
        judge_input_tokens: graded.usage.input,
        judge_output_tokens: graded.usage.output,
        judge_latency_ms: graded.latencyMs,
        failure_category: attribution.category,
        failure_detail: attribution.detail,
        oracle: oracleRow,
      })

      console.log(`[${index + 1}/${chosen.length}] ${question.id} C:${graded.verdict} D:${oracleRow.verdict} -> ${attribution.category}`)
    }

    // Build cost is per project, not per question: record it once alongside the rows.
    allRows.push({
      kind: 'build-cost',
      project_id: projectId,
      atoms: storedAtoms.length,
      summaryTokens: estimateTokens(compacted.summary),
      transcriptTokens: estimateTokens(transcript),
      buildLatencyMs: buildLatency,
      note: 'extraction and compaction are one-time costs; per-question cost is on the answer rows',
    })
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(OUT, `phase2-${stamp}.jsonl`)
  writeFileSync(file, allRows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  console.log(`\nwritten: ${file}`)
}

// Run only when invoked directly. The attribution test imports `attribute`, and without
// this guard the import would start a full model run — which it did, once.
const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)

if (invokedDirectly) {
  main().catch((error) => {
    console.error('PHASE2 FAILED:', error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}
