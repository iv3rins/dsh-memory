/**
 * Phase 3 controlled comparison.
 *
 * Four arms, each changing exactly one thing from the arm before it, on the same 80
 * questions, model, judge and temperature as Phase 2:
 *
 *   A  delivery fix, no semantic term, limit 8           — the shipped behaviour
 *   B  delivery fix, no semantic term, limit 12          — does the slot ceiling matter?
 *   C  delivery fix, semantic term on,  limit 12         — does category help?
 *   D  delivery fix, semantic term + standing-share fix  — does pinning crowd out?
 *
 * The oracle arm from Phase 2 is kept as the ceiling reference and is not re-measured here.
 *
 * Two honest constraints, both enforced rather than mentioned:
 *
 * - **Lifecycle ranking is not tested.** The dataset has no real usage events, and
 *   inventing `seen` counts would fabricate the very signal being measured. The lifecycle
 *   arm is reported as not evaluable.
 * - **Arm D's extra variable is a cap, not a mechanism.** `STANDING_BUDGET_SHARE` limits how
 *   much of the selection pinned rules may take; lowering it is testable without inventing
 *   anything, so it is the one additional knob this phase turns.
 *
 * Usage:
 *   node scripts/bench/phase3.mjs --project project_01_cli_tool --questions 40
 *   node scripts/bench/phase3.mjs --all
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { BENCH, OUT, MODEL, JUDGE_MODEL, apiKey, answer, compact, estimateTokens, flatten, judge, loadSessions, tailWithin } from './lib.mjs'
import { buildAtoms } from './atoms.mjs'
import { recallFor, seedStore } from './memory-arm.mjs'
import { categoryContext } from '../../core/query-category.js'
import { deliveryReport } from '../../core/delivery.js'

const TAIL_BUDGET = 6000
const SUMMARY_BUDGET = 2000

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const projects = args.includes('--all')
  ? ['project_01_cli_tool', 'project_02_multi_repo_tool']
  : [flag('project', 'project_01_cli_tool')]
const questionCount = Number(flag('questions', '40'))

/** The four arms, each a single delta from the previous. */
const ARMS = [
  {
    id: 'A',
    label: 'delivery fix, limit 8, no semantic',
    limit: 8,
    semantic: false,
  },
  {
    id: 'B',
    label: 'delivery fix, limit 12, no semantic',
    limit: 12,
    semantic: false,
  },
  {
    id: 'C',
    label: 'delivery fix, limit 12, semantic on',
    limit: 12,
    semantic: true,
  },
  {
    id: 'D',
    label: 'delivery fix, limit 12, semantic on, standing share 0.25',
    limit: 12,
    semantic: true,
    standingShare: 0.25,
  },
]

function distinctiveValues(reference) {
  const out = new Set()
  for (const match of String(reference).match(/v?\d+\.\d+\.\d+|[0-9a-f]{16,}|[A-Za-z_][A-Za-z0-9_]{8,}|\b\d{3,}\b/g) ?? []) {
    out.add(match.toLowerCase())
  }
  return [...out]
}

function sample(items, count) {
  return items
    .map((item) => ({ item, key: createHash('sha256').update(`codememo-v1:${item.id}`).digest('hex') }))
    .sort((left, right) => (left.key < right.key ? -1 : 1))
    .slice(0, count)
    .map((entry) => entry.item)
}

const main = async () => {
  const key = apiKey()
  mkdirSync(OUT, { recursive: true })
  const rows = []

  for (const projectId of projects) {
    const sessions = loadSessions(projectId)
    const questions = JSON.parse(readFileSync(path.join(BENCH, `${projectId}-questions.json`), 'utf8'))
    const chosen = sample(questions, questionCount)

    console.log(`\n### ${projectId}: ${chosen.length} questions`)

    const transcript = flatten(sessions)
    const compacted = await compact(key, transcript, SUMMARY_BUDGET)
    const atoms = await buildAtoms(projectId, sessions, key)
    const root = path.join(BENCH, 'plugin-root', `${projectId}-p3`)
    const seeded = await seedStore(root, atoms.map((atom) => ({ kind: atom.kind, text: atom.text, tags: atom.tags })))

    const { readAtoms } = await import('../../core/memory.js')
    const store = readAtoms(root)
    const live = store.ok === true ? store.live : []
    console.log(`store: ${seeded.result.live} atoms, summary ~${estimateTokens(compacted.summary)} tok`)

    for (const [index, question] of chosen.entries()) {
      const values = distinctiveValues(question.answer_short ?? question.answer)
      const reference = question.answer_short ?? question.answer
      const row = { project_id: projectId, question_id: question.id, category: question.category, arms: {} }

      for (const arm of ARMS) {
        const categories = arm.semantic === true ? categoryContext({ text: question.question }) : undefined
        const recall = await recallFor(root, question.question, {
          recallLimit: arm.limit,
          recallBudget: 4000,
          ...(categories === undefined ? {} : { categories }),
          ...(arm.standingShare === undefined ? {} : { standingBudgetShare: arm.standingShare }),
        })
        const recalled = recall.recall
        const selectedIds = recalled.ok === true ? (recalled.ids ?? []) : []
        const block = recalled.ok === true ? recalled.block : ''

        const context = recalled.ok === true
          ? `=== PROJECT NOTES (compacted) ===\n${compacted.summary}\n\n${block}`
          : `=== PROJECT NOTES (compacted) ===\n${compacted.summary}`

        // Delivery integrity through the real checker, not an id count.
        //
        // `requiredValuesByAtom` is what makes the check meaningful: without it every atom
        // is reported `partial` (no value to verify), which reads as a defect rate when it
        // is only a missing expectation. The values are the question's own distinctive
        // tokens, applied to whichever atoms the store says carry them — never to ids chosen
        // to make the number look good.
        const valuesByAtom = new Map()
        for (const id of selectedIds) {
          const atom = live.find((entry) => entry.id === id)
          if (atom === undefined) continue
          const carried = values.filter((value) => atom.text.toLowerCase().includes(value))
          if (carried.length > 0) valuesByAtom.set(id, carried)
        }
        const report = deliveryReport({
          selectedIds,
          liveAtoms: live,
          recallBlock: block,
          finalContext: context,
          requiredValuesByAtom: valuesByAtom,
        })

        // Did the atom that carries the answer reach the selection?
        const holders = values.length === 0
          ? []
          : live.filter((atom) => values.some((value) => atom.text.toLowerCase().includes(value))).map((atom) => atom.id)
        const retrieved = holders.length === 0 ? null : holders.some((id) => selectedIds.includes(id))

        const answered = await answer(key, context, question.question)
        const graded = await judge(key, question.question, reference, answered.answer)

        row.arms[arm.id] = {
          verdict: graded.verdict,
          retrieved,
          holdersKnown: holders.length > 0,
          atoms: selectedIds.length,
          contextTokens: estimateTokens(context),
          delivery: report.delivery_status,
          verified: report.counts.verified,
          missing: report.counts.missing,
          partial: report.counts.partial,
          inputTokens: answered.usage.input,
          outputTokens: answered.usage.output,
          latencyMs: answered.latencyMs,
        }
      }

      rows.push(row)
      const line = ARMS.map((arm) => `${arm.id}:${row.arms[arm.id].verdict[0]}/${row.arms[arm.id].delivery[0]}`).join(' ')
      console.log(`[${index + 1}/${chosen.length}] ${question.id} ${line}`)
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(OUT, `phase3-${stamp}.jsonl`)
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')

  // --- summary
  console.log('\n=== summary ===')
  const header = ['arm', 'correct', 'retrieved', 'delivery-verified', 'avg ctx tok']
  console.log(header.join('\t'))
  for (const arm of ARMS) {
    const cells = rows.map((row) => row.arms[arm.id])
    const correct = cells.filter((cell) => cell.verdict === 'CORRECT').length
    const known = cells.filter((cell) => cell.holdersKnown === true)
    const retrieved = known.filter((cell) => cell.retrieved === true).length
    const verified = cells.reduce((total, cell) => total + cell.verified, 0)
    const avgTokens = Math.round(cells.reduce((total, cell) => total + cell.contextTokens, 0) / cells.length)
    console.log([arm.id, `${correct}/${rows.length}`, `${retrieved}/${known.length}`, verified, avgTokens].join('\t'))
  }
  console.log(`\nwritten: ${file}`)
  console.log('\nLIFECYCLE ARM: not evaluated. The dataset has no real usage events, and')
  console.log('fabricating `seen` counts would manufacture the signal under test.')
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)

if (invokedDirectly) {
  main().catch((error) => {
    console.error('PHASE3 FAILED:', error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}
