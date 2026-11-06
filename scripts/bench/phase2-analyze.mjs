/**
 * Phase 2 analysis: retrieval ceilings, cost accounting, and paired statistics.
 *
 * Everything here is computed from a stored Phase 2 JSONL run — no model calls — so the
 * numbers can be re-derived from the artefact alone.
 *
 * The sections map onto the questions the report must answer:
 *
 *   retrieval ceilings   how far each stage of the pipeline gets
 *   evidence vs usage    did the model get evidence, and did it use it
 *   cost                 one-time build versus per-query marginal
 *   statistics           paired differences with intervals and a paired test
 *
 * Usage: node scripts/bench/phase2-analyze.mjs [file.jsonl]
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const OUT = path.join(import.meta.dirname, '..', '..', '_bench', 'codememo', 'results')

const file = process.argv[2] ?? (() => {
  const names = readdirSync(OUT).filter((name) => name.startsWith('phase2-') && name.endsWith('.jsonl')).sort()
  if (names.length === 0) throw new Error(`no phase2 runs in ${OUT}`)
  return path.join(OUT, names[names.length - 1])
})()

const raw = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
const rows = raw.filter((row) => row.kind !== 'build-cost')
const builds = raw.filter((row) => row.kind === 'build-cost')

console.log(`file: ${path.basename(file)}`)
console.log(`questions: ${rows.length} | projects: ${[...new Set(rows.map((row) => row.project_id))].join(', ')}\n`)

/** Wilson score interval, the same one the Phase 1 report uses. */
function wilson(successes, n, z = 1.96) {
  if (n === 0) return [0, 0]
  const p = successes / n
  const denominator = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denominator
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)]
}

/** Format a proportion with its interval. */
const pct = (value) => `${(value * 100).toFixed(1)}%`
const ci = ([low, high]) => `[${pct(low)}, ${pct(high)}]`

// ---------------------------------------------------------------- retrieval ceilings
console.log('=== 1. retrieval ceilings (per stage) ===')

for (const projectId of [...new Set(rows.map((row) => row.project_id))]) {
  const subset = rows.filter((row) => row.project_id === projectId)

  // Extraction coverage: did any stored atom carry the evidence at all?
  const withValues = subset.filter((row) => row.required_values.length > 0)
  const extracted = withValues.filter((row) => row.extracted_memory_ids.length > 0)
  // Candidate recall: was the matching atom ever offered to the selector?
  const candidate = withValues.filter((row) => row.extracted_memory_ids.some((id) => row.candidate_memory_ids.includes(id)))
  // Final retrieval: did it survive selection?
  const retrieved = withValues.filter((row) => row.extracted_memory_ids.some((id) => row.retrieved_memory_ids.includes(id)))
  // Delivery: did a selected id actually appear in the rendered block?
  const delivered = withValues.filter((row) => row.delivered_memory_ids.length > 0)

  console.log(`\n${projectId}  (${subset.length} questions, ${withValues.length} with an inspectable value)`)
  console.log(`  extraction coverage      ${extracted.length}/${withValues.length}  ${pct(extracted.length / Math.max(1, withValues.length))}`)
  console.log(`  candidate recall         ${candidate.length}/${withValues.length}  ${pct(candidate.length / Math.max(1, withValues.length))}`)
  console.log(`  final retrieval          ${retrieved.length}/${withValues.length}  ${pct(retrieved.length / Math.max(1, withValues.length))}`)
  console.log(`  delivery success         ${delivered.length}/${withValues.length}  ${pct(delivered.length / Math.max(1, withValues.length))}`)
}

// ---------------------------------------------------- evidence sufficient vs used well
console.log('\n=== 2. was the evidence sufficient, and was it used ===')

const cTally = { CORRECT: 0, PARTIAL: 0, WRONG: 0 }
for (const row of rows) cTally[row.verdict] = (cTally[row.verdict] ?? 0) + 1
const dTally = { CORRECT: 0, PARTIAL: 0, WRONG: 0, UNRESOLVED: 0 }
for (const row of rows) {
  const verdict = row.oracle?.verdict ?? 'UNRESOLVED'
  dTally[verdict] = (dTally[verdict] ?? 0) + 1
}
console.log('arm C (summary + recall):', JSON.stringify(cTally))
console.log('arm D (oracle evidence) :', JSON.stringify(dTally))

const oracleCorrect = rows.filter((row) => row.oracle?.verdict === 'CORRECT')
const cCorrect = rows.filter((row) => row.verdict === 'CORRECT')
const bothCorrect = rows.filter((row) => row.verdict === 'CORRECT' && row.oracle?.verdict === 'CORRECT')
const oracleOnly = rows.filter((row) => row.verdict !== 'CORRECT' && row.oracle?.verdict === 'CORRECT')
const cOnly = rows.filter((row) => row.verdict === 'CORRECT' && row.oracle?.verdict !== 'CORRECT')

console.log(`\n  D correct: ${oracleCorrect.length}/${rows.length}  ${pct(oracleCorrect.length / rows.length)} ${ci(wilson(oracleCorrect.length, rows.length))}`)
console.log(`  C correct: ${cCorrect.length}/${rows.length}  ${pct(cCorrect.length / rows.length)} ${ci(wilson(cCorrect.length, rows.length))}`)
console.log(`  both: ${bothCorrect.length} | only D: ${oracleOnly.length} | only C: ${cOnly.length}`)
console.log('  -> "only D" counts questions where the pipeline failed but the model could answer given evidence')
console.log(`     that is the recoverable headroom: ${oracleOnly.length} questions (${pct(oracleOnly.length / rows.length)})`)

// --------------------------------------------------------------- failure attribution
console.log('\n=== 3. failure attribution ===')
const categories = [...new Set(rows.map((row) => row.failure_category))]
for (const category of categories.sort()) {
  const subset = rows.filter((row) => row.failure_category === category)
  console.log(`  ${category.padEnd(22)} ${String(subset.length).padStart(3)}`)
}
const unknown = rows.filter((row) => row.failure_category === 'UNKNOWN')
if (unknown.length > 0) {
  console.log('  UNKNOWN ids:', unknown.map((row) => row.question_id).join(', '))
}

// -------------------------------------------------------------------------- cost
console.log('\n=== 4. cost ===')

const sum = (list, pick) => list.reduce((total, row) => total + (pick(row) ?? 0), 0)

console.log('one-time build (per project):')
for (const build of builds) {
  console.log(`  ${build.project_id}: ${build.atoms} atoms, summary ~${build.summaryTokens} tok of ~${build.transcriptTokens} tok, build ${(build.buildLatencyMs / 1000).toFixed(1)}s`)
}

const cInput = sum(rows, (row) => row.input_tokens)
const cOutput = sum(rows, (row) => row.output_tokens)
const cJudgeInput = sum(rows, (row) => row.judge_input_tokens)
const cJudgeOutput = sum(rows, (row) => row.judge_output_tokens)
const dInput = sum(rows, (row) => row.oracle?.inputTokens)
const dOutput = sum(rows, (row) => row.oracle?.outputTokens)
const dJudgeInput = sum(rows, (row) => row.oracle?.judgeInputTokens)
const dJudgeOutput = sum(rows, (row) => row.oracle?.judgeOutputTokens)
const cLatency = sum(rows, (row) => row.latency_ms)
const dLatency = sum(rows, (row) => row.oracle?.latencyMs)
const n = Math.max(1, rows.length)

console.log('\nmarginal cost per query (answer call):')
console.log(`  arm C  input ${(cInput / n).toFixed(0)} tok, output ${(cOutput / n).toFixed(0)} tok, latency ${(cLatency / n).toFixed(0)} ms`)
console.log(`  arm D  input ${(dInput / n).toFixed(0)} tok, output ${(dOutput / n).toFixed(0)} tok, latency ${(dLatency / n).toFixed(0)} ms`)

console.log('\njudge cost per arm (paid once per question, both arms):')
console.log(`  after C: input ${(cJudgeInput / n).toFixed(0)} tok, output ${(cJudgeOutput / n).toFixed(0)} tok`)
console.log(`  after D: input ${(dJudgeInput / n).toFixed(0)} tok, output ${(dJudgeOutput / n).toFixed(0)} tok`)

const cTotal = cInput + cOutput + cJudgeInput + cJudgeOutput
const dTotal = dInput + dOutput + dJudgeInput + dJudgeOutput
console.log(`\ntotals for ${rows.length} questions: C ${cTotal} tok, D ${dTotal} tok`)

// The judge is a real cost too. It is now itemised above because it is paid per question
// on both arms, so omitting it would understate the total a reader actually spends.
console.log('\nnote: prices per token are not published for this endpoint, so no currency')
console.log('      figure is given. Tokens are the observable unit; inventing a price would not be.')

// -------------------------------------------------------------------- statistics
console.log('\n=== 5. paired statistics ===')

/** McNemar-style exact test on the discordant pairs, two-sided. */
function mcnemarExact(onlyFirst, onlySecond) {
  const n = onlyFirst + onlySecond
  if (n === 0) return 1
  // Two-sided binomial tail: sum over the smaller side, doubled.
  const choose = (a, b) => {
    let result = 1
    for (let index = 0; index < b; index += 1) result = (result * (a - index)) / (index + 1)
    return result
  }
  let tail = 0
  const k = Math.min(onlyFirst, onlySecond)
  for (let index = 0; index <= k; index += 1) tail += choose(n, index) * Math.pow(0.5, n)
  return Math.min(1, tail * 2)
}

const isCorrect = (row, arm) => (arm === 'C' ? row.verdict === 'CORRECT' : row.oracle?.verdict === 'CORRECT')

for (const [armA, armB] of [['D', 'C']]) {
  const onlyA = rows.filter((row) => isCorrect(row, armA) && isCorrect(row, armB) === false).length
  const onlyB = rows.filter((row) => isCorrect(row, armB) && isCorrect(row, armA) === false).length
  const n = rows.length
  const diff = (onlyA - onlyB) / n
  const discordant = onlyA + onlyB
  const se = discordant === 0 ? 0 : Math.sqrt(discordant) / n
  const p = mcnemarExact(onlyA, onlyB)
  console.log(`${armA} - ${armB}: ${(diff * 100).toFixed(1)} pp  95% CI [${((diff - 1.96 * se) * 100).toFixed(1)}, ${((diff + 1.96 * se) * 100).toFixed(1)}]`)
  console.log(`  discordant: only ${armA} ${onlyA}, only ${armB} ${onlyB} | exact McNemar p = ${p.toFixed(4)}`)

  // Per project, because pooling two projects hides a split that large.
  for (const projectId of [...new Set(rows.map((row) => row.project_id))]) {
    const subset = rows.filter((row) => row.project_id === projectId)
    const a = subset.filter((row) => isCorrect(row, armA) && isCorrect(row, armB) === false).length
    const b = subset.filter((row) => isCorrect(row, armB) && isCorrect(row, armA) === false).length
    const projectDiff = (a - b) / subset.length
    const projectSe = (a + b) === 0 ? 0 : Math.sqrt(a + b) / subset.length
    console.log(`  ${projectId}: ${(projectDiff * 100).toFixed(1)} pp  CI [${((projectDiff - 1.96 * projectSe) * 100).toFixed(1)}, ${((projectDiff + 1.96 * projectSe) * 100).toFixed(1)}]  (only D ${a}, only C ${b}, n=${subset.length})`)
  }
}

console.log('\nLIMITATION: two projects. Project-level estimates are reported separately rather')
console.log('than pooled into a "typical project" figure, because n=2 cannot support one.')
