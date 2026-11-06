/**
 * Long-horizon memory experiment against CodeMemo.
 *
 * The question: after a long development history is compacted, how much of it can
 * still be recovered — with only the summary, with nothing, and with this plugin?
 *
 * Arms, identical question and judge, only the history differs:
 *
 *   A  compacted summary only      — what native compaction preserves
 *   B  raw transcript tail only    — no memory, just a small context window
 *   C  compacted summary + recall  — summary plus the plugin's atom store
 *
 * Scope, stated up front because it decides how the numbers may be read: the corpus is
 * 17k–588k tokens per project and every answer exists in raw conversation somewhere,
 * so what this measures is **retrievability under a budget**, not "how much text
 * compaction permanently destroys". A summary is lossy by construction here; the
 * interesting number is how much of that loss recall can buy back.
 *
 * Usage:
 *   node scripts/bench/codememo.mjs --project project_01_cli_tool --questions 40
 *   node scripts/bench/codememo.mjs --project project_02_multi_repo_tool --questions 40 --arms AC
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { BENCH, OUT, MODEL, JUDGE_MODEL, apiKey, answer, compact, estimateTokens, flatten, judge, loadSessions, tailWithin } from './lib.mjs'
import { buildAtoms } from './atoms.mjs'
import { armCContext, recallFor, seedStore } from './memory-arm.mjs'

/** Context budget for the "no memory" arm, in tokens. */
const TAIL_BUDGET = 6000
/** Target size of the compacted summary, in tokens. A realistic compaction ratio. */
const SUMMARY_BUDGET = 2000

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const projectId = flag('project', 'project_02_multi_repo_tool')
const questionCount = Number(flag('questions', '40'))
const arms = flag('arms', 'ABC').split('')
const dryRun = args.includes('--dry')

/** Deterministic sample so a rerun scores the same questions. */
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

  const sessions = loadSessions(projectId)
  const questions = JSON.parse(readFileSync(path.join(BENCH, `${projectId}-questions.json`), 'utf8'))
  const chosen = sample(questions, questionCount)

  console.log(`project ${projectId}: ${sessions.length} sessions, ${questions.length} questions, using ${chosen.length}`)
  console.log(`model ${MODEL}, judge ${JUDGE_MODEL}, arms ${arms.join('')}`)

  if (dryRun) {
    console.log('DRY: sample ids:', chosen.slice(0, 8).map((q) => q.id).join(', '))
    return
  }

  const transcript = flatten(sessions)
  console.log(`transcript ${transcript.length} chars (~${estimateTokens(transcript)} tokens)`)

  const compacted = await compact(key, transcript, SUMMARY_BUDGET)
  console.log(`summary ${compacted.summary.length} chars (~${estimateTokens(compacted.summary)} tokens)`)
  const tail = tailWithin(transcript, TAIL_BUDGET)

  let storeRoot = null
  let atomCount = null
  if (arms.includes('C')) {
    const atoms = await buildAtoms(projectId, sessions, key)
    storeRoot = path.join(BENCH, 'plugin-root', projectId)
    const seeded = await seedStore(storeRoot, atoms.map((atom) => ({ kind: atom.kind, text: atom.text, tags: atom.tags })))
    atomCount = seeded.result.live
    console.log(`store: live atoms ${seeded.result.live} (added ${seeded.result.added})`)
  }

  const rows = []
  const startedAt = Date.now()

  for (let index = 0; index < chosen.length; index += 1) {
    const question = chosen[index]
    const reference = question.answer_short ?? question.answer
    const row = { id: question.id, category: question.category, arms: {} }

    for (const arm of arms) {
      let context
      if (arm === 'A') {
        context = `=== PROJECT NOTES (compacted) ===\n${compacted.summary}`
      } else if (arm === 'B') {
        context = `=== RECENT CONVERSATION ===\n${tail}`
      } else {
        const { recall } = await recallFor(storeRoot, question.question)
        context = armCContext(compacted.summary, recall)
        row.arms.recall = recall.ok === true
          ? { atoms: recall.atoms, tokens: recall.tokens, route: recall.route }
          : { ok: false, reason: recall.reason }
      }

      const answered = await answer(key, context, question.question)
      const graded = await judge(key, question.question, reference, answered.answer)
      row.arms[arm] = {
        verdict: graded.verdict,
        answer: answered.answer.slice(0, 600),
        reason: graded.reason,
        contextTokens: estimateTokens(context),
      }
    }

    rows.push(row)
    console.log(`[${index + 1}/${chosen.length}] ${question.id} ${arms.map((arm) => `${arm}:${row.arms[arm].verdict}`).join(' ')}`)
  }

  const tally = {}
  for (const arm of arms) {
    let correct = 0
    let partial = 0
    let wrong = 0
    let contextTokens = 0
    for (const row of rows) {
      const entry = row.arms[arm]
      if (entry.verdict === 'CORRECT') correct += 1
      else if (entry.verdict === 'PARTIAL') partial += 1
      else wrong += 1
      contextTokens += entry.contextTokens ?? 0
    }
    tally[arm] = {
      correct,
      partial,
      wrong,
      n: rows.length,
      accuracy: correct / rows.length,
      accuracyPartial: (correct + partial * 0.5) / rows.length,
      avgContextTokens: Math.round(contextTokens / rows.length),
    }
  }

  const result = {
    projectId,
    model: MODEL,
    judgeModel: JUDGE_MODEL,
    questions: rows.length,
    sessions: sessions.length,
    transcriptTokens: estimateTokens(transcript),
    summaryTokens: estimateTokens(compacted.summary),
    tailTokens: estimateTokens(tail),
    atoms: atomCount,
    arms: tally,
    durationMs: Date.now() - startedAt,
    rows,
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(OUT, `${projectId}-${stamp}.json`)
  writeFileSync(file, JSON.stringify(result, null, 1), 'utf8')

  console.log('\n=== result ===')
  for (const arm of arms) {
    const t = tally[arm]
    console.log(`${arm}: correct ${t.correct}/${t.n} (${(t.accuracy * 100).toFixed(1)}%), partial ${t.partial}, wrong ${t.wrong}, avg ctx ~${t.avgContextTokens} tok`)
  }
  console.log(`written: ${file}`)
}

main().catch((error) => {
  console.error('BENCH FAILED:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
