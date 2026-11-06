// Task 6: reconcile the numbers reported across Phase 1 and Phase 2.
//
// The brief lists four suspicious figures: Phase 1 C = 20/80, Phase 2 C = 14/80,
// Phase 2 NONE = 16, and an attribution total of 82. This script answers each from the
// stored artefacts rather than from memory, and reports where the runs genuinely differ.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const RESULTS = path.join(import.meta.dirname, '..', '..', '_bench', 'codememo', 'results')

const read = (name) => readFileSync(path.join(RESULTS, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line))

/** Newest run of a prefix. */
function newest(prefix) {
  const names = readdirSync(RESULTS).filter((name) => name.startsWith(prefix) && name.endsWith('.json') || name.endsWith('.jsonl') && name.startsWith(prefix))
  const sorted = names.sort()
  return sorted[sorted.length - 1]
}

const phase1Files = ['project_01_cli_tool-2026-11-06T05-36-31-142Z.json', 'project_02_multi_repo_tool-2026-11-06T05-28-06-026Z.json']
const phase2File = 'phase2-2026-11-06T07-39-35-239Z.jsonl'

console.log('=== claim 1 & 2: Phase 1 C = 20/80 vs Phase 2 C = 14/80 ===\n')

const phase1 = []
for (const name of phase1Files) {
  const run = JSON.parse(readFileSync(path.join(RESULTS, name), 'utf8'))
  for (const row of run.rows) {
    phase1.push({ id: row.id, project: run.projectId, verdict: row.arms.C.verdict })
  }
}
const phase1Correct = phase1.filter((row) => row.verdict === 'CORRECT').length
console.log(`Phase 1 C: ${phase1Correct}/${phase1.length}`)

const phase2Raw = read(phase2File)
const phase2 = phase2Raw.filter((row) => row.kind !== 'build-cost')
const phase2Correct = phase2.filter((row) => row.verdict === 'CORRECT').length
console.log(`Phase 2 C: ${phase2Correct}/${phase2.length}`)

// Are they the same questions?
const p1Ids = new Set(phase1.map((row) => row.id))
const p2Ids = new Set(phase2.map((row) => row.question_id))
const shared = [...p1Ids].filter((id) => p2Ids.has(id))
console.log(`question sets identical: ${p1Ids.size === p2Ids.size && shared.length === p1Ids.size} (shared ${shared.length})`)

// Per-question agreement: this is the number that matters. If the same arm on the same
// questions flips on many rows, the arm is not reproducible and any single number from it
// is a sample, not a measurement.
const byId = new Map(phase2.map((row) => [row.question_id, row.verdict]))
let agree = 0
let p1Only = 0
let p2Only = 0
for (const row of phase1) {
  const other = byId.get(row.id)
  if (other === row.verdict) {
    agree += 1
    continue
  }
  if (row.verdict === 'CORRECT' && other !== 'CORRECT') p1Only += 1
  if (other === 'CORRECT' && row.verdict !== 'CORRECT') p2Only += 1
}
console.log(`per-question verdict agreement: ${agree}/${phase1.length} (${((agree / phase1.length) * 100).toFixed(1)}%)`)
console.log(`correct in Phase 1 only: ${p1Only} | correct in Phase 2 only: ${p2Only}`)
console.log('\nInterpretation: the two runs share the same questions and the same arm, so a')
console.log('difference of this size can only come from the run itself — the summary is a fresh')
console.log('model call every time, and the judge is a model call too. C is therefore a sample,')
console.log('not a fixed value, and a single run of it must not be quoted as a measurement.')

console.log('\n=== claim 3: Phase 2 NONE = 16 ===\n')
const none = phase2.filter((row) => row.failure_category === 'NONE').length
const correctRows = phase2.filter((row) => row.verdict === 'CORRECT').length
console.log(`NONE rows in the final run: ${none}`)
console.log(`CORRECT rows in the final run: ${correctRows}`)
console.log(`consistent: ${none === correctRows}`)
console.log('\nThe 16 came from an EARLIER phase2 run (07-24-24), before the value regex was')
console.log('widened to accept `v0.12.0`. Runs after that fix report 14, matching CORRECT.')

// Show it from the stored runs so the claim is auditable.
for (const name of readdirSync(RESULTS).filter((entry) => entry.startsWith('phase2-')).sort()) {
  const rows = read(name).filter((row) => row.kind !== 'build-cost')
  const noneCount = rows.filter((row) => row.failure_category === 'NONE').length
  const correctCount = rows.filter((row) => row.verdict === 'CORRECT').length
  console.log(`  ${name}  NONE ${noneCount}  CORRECT ${correctCount}  ${noneCount === correctCount ? 'consistent' : 'MISMATCH'}`)
}

console.log('\n=== claim 4: attribution total = 82 ===\n')
const lines = phase2Raw.length
const buildRows = phase2Raw.filter((row) => row.kind === 'build-cost').length
console.log(`JSONL lines: ${lines}`)
console.log(`  question rows: ${phase2.length}`)
console.log(`  build-cost rows: ${buildRows}`)
console.log(`attribution total: ${Object.values(phase2.reduce((acc, row) => {
  acc[row.failure_category] = (acc[row.failure_category] ?? 0) + 1
  return acc
}, {})).reduce((a, b) => a + b, 0)}`)
console.log('\n82 is the line count, not the attribution count: two of those lines are the')
console.log('per-project build-cost records. Attributions sum to 80, one per question.')
