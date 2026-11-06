// Does the real semantic candidate route recover the answer-holder? Measured, not assumed.
//
// This covers static colour derivation from the question, not an explicit Main Agent
// category choice. Both sides use a fixed clock; only semanticRouting/taskIntent change.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { BENCH } from './lib.mjs'
import { BENCH_NOW, intentForQuestion, recallFor } from './memory-arm.mjs'

const RESULTS = path.join(BENCH, 'results')
const file = process.argv[2] ?? 'phase2-2026-11-06T08-29-09-897Z.jsonl'

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

const LIMITS = [8, 12]

for (const projectId of [...new Set(rows.map((row) => row.project_id))]) {
  const subset = rows.filter((row) => row.project_id === projectId)
  const questions = JSON.parse(readFileSync(path.join(BENCH, `${projectId}-questions.json`), 'utf8'))
  const root = path.join(BENCH, 'plugin-root', projectId)

  const { readAtoms } = await import('../../core/memory.js')
  const store = readAtoms(root)
  const atoms = store.ok === true ? store.live : []
  if (atoms.length === 0) continue

  console.log(`\n=== ${projectId} (${atoms.length} live atoms) ===`)

  for (const limit of LIMITS) {
    const counts = { off: 0, on: 0, total: 0 }
    for (const row of subset) {
      const question = questions.find((entry) => entry.id === row.question_id)
      const values = distinctiveValues(question.answer_short ?? question.answer)
      if (values.length === 0) continue
      const holders = atoms.filter((atom) => values.some((value) => atom.text.toLowerCase().includes(value))).map((atom) => atom.id)
      if (holders.length === 0) continue
      counts.total += 1

      // Off: the current behaviour.
      const off = await recallFor(root, question.question, { recallLimit: limit, recallBudget: 4000, now: BENCH_NOW })
      if (off.recall.ok === true && holders.some((id) => (off.recall.ids ?? []).includes(id))) counts.off += 1

      // On: the real candidate-routing path, not a score-only category bonus.
      const on = await recallFor(root, question.question, {
        recallLimit: limit,
        recallBudget: 4000,
        semanticRouting: true,
        taskIntentEnabled: true,
        intent: intentForQuestion(question.question),
        now: BENCH_NOW,
      })
      if (on.recall.ok === true && holders.some((id) => (on.recall.ids ?? []).includes(id))) counts.on += 1
    }
    const pct = (value) => `${((value / Math.max(1, counts.total)) * 100).toFixed(1)}%`
    console.log(`  limit ${String(limit).padStart(2)}  semantic off ${counts.off}/${counts.total} (${pct(counts.off)})  on ${counts.on}/${counts.total} (${pct(counts.on)})  delta ${counts.on - counts.off}`)
  }
}
