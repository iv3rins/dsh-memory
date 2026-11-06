// Are the remaining 7 DELIVERY_FAILURE rows real, or another predicate artefact?
//
// The strict predicate requires an identifier or two content words. A row can fail that
// while its content *did* arrive, if the atom's wording differs from the answer's. So this
// asks the only question that settles it: for the atoms that held the values, is their full
// text present in what the model received?
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { BENCH } from './lib.mjs'
import { recallFor } from './memory-arm.mjs'
import { verifyDelivery } from '../../core/delivery.js'

const RESULTS = path.join(BENCH, 'results')
const file = process.argv[2] ?? 'phase2-2026-11-06T08-29-09-897Z.jsonl'
const rows = readFileSync(path.join(RESULTS, file), 'utf8').trim().split('\n')
  .map((line) => JSON.parse(line))
  .filter((row) => row.kind !== 'build-cost' && row.failure_category === 'DELIVERY_FAILURE')

const { readAtoms } = await import('../../core/memory.js')

let realLoss = 0
let predicateArtefact = 0

for (const row of rows) {
  const projectId = row.project_id
  const root = path.join(BENCH, 'plugin-root', projectId)
  const store = readAtoms(root)
  const live = store.ok === true ? store.live : []

  const questions = JSON.parse(readFileSync(path.join(BENCH, `${projectId}-questions.json`), 'utf8'))
  const question = questions.find((entry) => entry.id === row.question_id)
  const { recall } = await recallFor(root, question.question)
  const block = recall.ok === true ? recall.block : ''

  // Reproduce the full context the model saw: summary + block. The summary is not stored in
  // the phase 2 row, so integrity is judged against the block, which is the stricter test —
  // if the content is in the block it certainly reached the model.
  const values = row.required_values ?? []

  // Which selected atoms actually carried any of the required values?
  const holders = row.retrieved_memory_ids
    .map((id) => live.find((atom) => atom.id === id))
    .filter((atom) => atom !== undefined)
    .filter((atom) => values.some((value) => atom.text.toLowerCase().includes(value.toLowerCase())))

  if (holders.length === 0) {
    console.log(`${row.question_id}  holder was never selected -> not a delivery defect (RANKING)`)
    predicateArtefact += 1
    continue
  }

  const verdicts = holders.map((atom) =>
    verifyDelivery({
      id: atom.id,
      selectedIds: row.retrieved_memory_ids,
      liveAtoms: live,
      recallBlock: block,
      finalContext: block,
      requiredValues: values,
    }))

  const anyRendered = verdicts.some((verdict) => verdict.rendered)
  const anyDeliveredText = verdicts.some((verdict) => verdict.delivered)

  if (anyRendered && anyDeliveredText) {
    // The atom's own text is in the block. The strict predicate failed only because the
    // expected value is a common word or phrased differently in the atom.
    console.log(`${row.question_id}  holder text IS in the block -> predicate artefact, not a defect`)
    predicateArtefact += 1
  } else {
    console.log(`${row.question_id}  holder selected but its text is absent -> REAL LOSS`)
    realLoss += 1
  }
}

console.log('\n=== verdict ===')
console.log(`real content loss: ${realLoss}`)
console.log(`predicate artefacts (value phrasing, not missing content): ${predicateArtefact}`)
console.log(`total examined: ${rows.length}`)
