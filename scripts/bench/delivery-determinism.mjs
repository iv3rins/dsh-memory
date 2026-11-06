// Why did Phase 2 label 13 rows DELIVERY_FAILURE when a replay of the same rows finds the
// value present?
//
// Two possibilities, and they have opposite implications:
//
//   (a) the block is not deterministic — the same store and question can render different
//       atoms, so the label describes that moment rather than the code;
//   (b) the Phase 2 check looked at the wrong variable.
//
// This measures the block directly: run recall N times for the same question and compare
// the rendered text, then apply both the Phase 2 predicate and the strict predicate to the
// same block.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { BENCH } from './lib.mjs'
import { recallFor } from './memory-arm.mjs'

const RESULTS = path.join(BENCH, 'results')
const file = 'phase2-2026-11-06T07-39-35-239Z.jsonl'
const rows = readFileSync(path.join(RESULTS, file), 'utf8').trim().split('\n')
  .map((line) => JSON.parse(line))
  .filter((row) => row.kind !== 'build-cost' && row.failure_category === 'DELIVERY_FAILURE')

const REPEATS = 3

console.log(`determinism of the rendered block, ${REPEATS} repeats per question\n`)

let unstable = 0
let phase2PredicateSaysMissing = 0
let strictPredicateSaysMissing = 0

for (const row of rows) {
  const projectId = row.project_id
  const questions = JSON.parse(readFileSync(path.join(BENCH, `${projectId}-questions.json`), 'utf8'))
  const question = questions.find((entry) => entry.id === row.question_id)
  const root = path.join(BENCH, 'plugin-root', projectId)

  const blocks = []
  for (let attempt = 0; attempt < REPEATS; attempt += 1) {
    const { recall } = await recallFor(root, question.question)
    blocks.push(recall.ok === true ? recall.block : '')
  }

  const distinct = new Set(blocks)
  const stable = distinct.size === 1
  if (!stable) unstable += 1

  // Phase 2's predicate, reproduced exactly: did ANY required value appear as a substring?
  const values = (row.required_values ?? []).map((value) => value.toLowerCase())
  const block = blocks[0].toLowerCase()
  const anyValue = values.some((value) => block.includes(value))

  // The stricter reading: did a value appear that is not a common English word?
  const STRICT = /\d|_|\./
  const distinctive = values.filter((value) => STRICT.test(value))
  const anyDistinctive = distinctive.some((value) => block.includes(value))

  if (!anyValue) phase2PredicateSaysMissing += 1
  if (distinctive.length > 0 && !anyDistinctive) strictPredicateSaysMissing += 1

  console.log(`${row.question_id}  stable=${stable ? 'yes' : 'NO '}  distinct blocks=${distinct.size}  anyValue=${anyValue}  anyDistinctive=${anyDistinctive}`)
  if (!stable) {
    for (const [index, candidate] of [...distinct].entries()) {
      console.log(`    variant ${index + 1}: ${candidate.length} chars, starts "${candidate.slice(0, 70).replace(/\n/g, ' ')}"`)
    }
  }
}

console.log('\n=== summary ===')
console.log(`rows with an unstable block across ${REPEATS} repeats: ${unstable}/${rows.length}`)
console.log(`rows where Phase 2's predicate still says the value is missing: ${phase2PredicateSaysMissing}/${rows.length}`)
console.log(`rows where a distinctive value (digit or identifier) is missing: ${strictPredicateSaysMissing}/${rows.length}`)
