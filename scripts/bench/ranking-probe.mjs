// Phase 3: why does final retrieval collapse to 55% on the long project?
//
// Candidate recall is 92.5% and final retrieval is 55.0%, so the ranking stage drops atoms
// it had already found. This measures the ranking directly, with no model calls, by asking
// for the position of the atom that carries the answer at increasing limits.
//
// If the holder appears at rank 12 but not at rank 8, the limit is the cause and no scoring
// change is needed. If the holder is not selected even at limit 40, the ordering is the
// cause and the limit is irrelevant. Those two answers lead to different fixes, so guessing
// between them would waste the work.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { BENCH } from './lib.mjs'
import { recallFor } from './memory-arm.mjs'

const RESULTS = path.join(BENCH, 'results')
const file = process.argv[2] ?? 'phase2-2026-11-06T08-29-09-897Z.jsonl'

/** Distinctive values, same definition the attribution uses: must not be a common word. */
function distinctiveValues(reference) {
  const text = String(reference)
  const out = new Set()
  for (const match of text.match(/v?\d+\.\d+\.\d+|[0-9a-f]{16,}|[A-Za-z_][A-Za-z0-9_]{8,}|\b\d{3,}\b/g) ?? []) {
    out.add(match.toLowerCase())
  }
  return [...out]
}

const rows = readFileSync(path.join(RESULTS, file), 'utf8').trim().split('\n')
  .map((line) => JSON.parse(line))
  .filter((row) => row.kind !== 'build-cost')

const LIMITS = [8, 12, 16, 24, 40]
const projects = [...new Set(rows.map((row) => row.project_id))]

for (const projectId of projects) {
  const subset = rows.filter((row) => row.project_id === projectId)
  const questions = JSON.parse(readFileSync(path.join(BENCH, `${projectId}-questions.json`), 'utf8'))
  const root = path.join(BENCH, 'plugin-root', projectId)

  // Read the LIVE store, not the extraction cache: the cache holds pre-normalized facts
  // with no id, so matching against it silently found no holders at any limit and made the
  // probe report 0% — a measurement bug that looked exactly like a product failure.
  const { readAtoms } = await import('../../core/memory.js')
  const store = readAtoms(root)
  const atoms = store.ok === true ? store.live : []
  console.log(`\n=== ${projectId} (${subset.length} questions, ${atoms.length} live atoms) ===`)
  if (atoms.length === 0) {
    console.log('  no live store; seeding is required for this project')
    continue
  }

  for (const limit of LIMITS) {
    let recovered = 0
    let inspectable = 0
    for (const row of subset) {
      const question = questions.find((entry) => entry.id === row.question_id)
      const values = distinctiveValues(question.answer_short ?? question.answer)
      if (values.length === 0) continue
      inspectable += 1

      // Which live atoms hold a distinctive value?
      const holders = atoms
        .filter((atom) => values.some((value) => atom.text.toLowerCase().includes(value)))
        .map((atom) => atom.id)
      if (holders.length === 0) continue

      const { recall } = await recallFor(root, question.question, { recallLimit: limit, recallBudget: 4000 })
      const selected = recall.ok === true ? (recall.ids ?? []) : []
      if (holders.some((id) => selected.includes(id))) recovered += 1
    }
    console.log(`  limit ${String(limit).padStart(2)}: holder recovered ${recovered}/${inspectable}  (${((recovered / Math.max(1, inspectable)) * 100).toFixed(1)}%)`)
  }
}
