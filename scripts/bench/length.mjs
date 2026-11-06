/**
 * Length-control experiment: how do the arms behave as the history grows?
 *
 * The question Phase 1 left open: on a 17 k-token project the summary matched raw recent
 * text exactly, and on a 588 k-token one everything collapsed. Is that a threshold, a
 * slope, or two accidents? One project cannot answer it — but a single project can be
 * *truncated* to several sizes, which holds the questions fixed and varies only the
 * amount of history the summariser and the store have to work with.
 *
 * Design, and its honest limit:
 *
 * - History is truncated at session boundaries to the nearest point under the target, so
 *   no session is half-included.
 * - Questions are restricted to those whose evidence survives the truncation. Otherwise a
 *   smaller history would look worse purely because it never contained the answer, which
 *   would be a data artefact reported as a memory effect.
 * - The same questions are used at every size, so the comparison is paired.
 *
 * Usage:
 *   node scripts/bench/length.mjs --project project_02_multi_repo_tool --questions 25
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { BENCH, OUT, apiKey, answer, compact, estimateTokens, flatten, judge, loadSessions, tailWithin } from './lib.mjs'
import { recallFor, seedStore } from './memory-arm.mjs'
import { buildAtoms } from './atoms.mjs'

/**
 * Target history sizes, in tokens.
 *
 * These are the sizes that can actually be paired on this corpus. The nominal request was
 * 20 k / 50 k / 100 k / 300 k / 600 k, but `common` below showed that only **one**
 * question in this project has all of its evidence inside the 20 k and 50 k prefixes, so a
 * five-point paired curve is not available: comparing different questions at different
 * sizes would confound "smaller history" with "different question".
 *
 * 100 k / 300 k / 600 k share 10 questions, which supports a paired three-point curve.
 * `--sizes` overrides this; the report states which sizes were usable and why.
 */
const SIZES = process.env.LENGTH_SIZES !== undefined
  ? process.env.LENGTH_SIZES.split(',').map((value) => Number(value.trim())).filter((value) => Number.isFinite(value))
  : [100000, 300000, 600000]
const TAIL_BUDGET = 6000
const SUMMARY_BUDGET = 2000

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const projectId = flag('project', 'project_02_multi_repo_tool')
const questionLimit = Number(flag('questions', '25'))

/**
 * Keep whole sessions until the token target is reached.
 *
 * @param {object[]} sessions - all sessions, oldest first.
 * @param {number} targetTokens - budget.
 * @returns {{ kept: object[], tokens: number }} the prefix that fits.
 */
function truncateToTokens(sessions, targetTokens) {
  const kept = []
  let tokens = 0
  for (const session of sessions) {
    const cost = estimateTokens(session.turns.map((turn) => turn.text).join('\n'))
    if (tokens + cost > targetTokens) break
    kept.push(session)
    tokens += cost
  }
  return { kept, tokens }
}

const main = async () => {
  const key = apiKey()
  mkdirSync(OUT, { recursive: true })

  const allSessions = loadSessions(projectId)
  const totalTokens = estimateTokens(flatten(allSessions))
  console.log(`project ${projectId}: ${allSessions.length} sessions, ~${totalTokens} tokens total`)

  const questions = JSON.parse(
    (await import('node:fs')).readFileSync(path.join(BENCH, `${projectId}-questions.json`), 'utf8'),
  )

  // For each size, work out which sessions are in and which questions are answerable.
  const points = []
  for (const size of SIZES) {
    const { kept, tokens } = truncateToTokens(allSessions, size)
    if (kept.length === 0) {
      console.log(`skip ${size}: no session fits`)
      continue
    }
    const keptIds = new Set(kept.map((session) => session.id))

    // A question is eligible when every evidence session is inside the retained prefix.
    // Requiring *all* of them, not just one, keeps the difficulty constant across sizes.
    const eligible = questions.filter((question) => {
      const evidence = question.evidence ?? []
      return evidence.length > 0 && evidence.every((entry) => keptIds.has(entry.session_id))
    })

    points.push({ size, kept, tokens, keptIds, eligible })
    console.log(`  target ${size}: ${kept.length} sessions, ~${tokens} tokens, ${eligible.length} eligible questions`)
  }

  // Use the questions eligible at EVERY size, so the comparison is paired by construction.
  const common = points.reduce((shared, point) => {
    const ids = new Set(point.eligible.map((question) => question.id))
    return shared === null ? ids : new Set([...shared].filter((id) => ids.has(id)))
  }, null)
  const chosen = questions
    .filter((question) => common?.has(question.id) === true)
    .map((question) => ({ question, key: createHash('sha256').update(`length-v1:${question.id}`).digest('hex') }))
    .sort((left, right) => (left.key < right.key ? -1 : 1))
    .slice(0, questionLimit)
    .map((entry) => entry.question)

  console.log(`\nquestions eligible at every size: ${common?.size ?? 0}, using ${chosen.length}`)
  if (chosen.length < 8) {
    console.log('NOT ENOUGH COMMON QUESTIONS: the larger sizes cannot be compared fairly.')
    console.log('Report this rather than running an unpaired comparison.')
    return
  }

  const rows = []
  for (const point of points) {
    const transcript = flatten(point.kept)
    console.log(`\n--- ${point.size} target (~${point.tokens} tokens, ${point.kept.length} sessions) ---`)

    const compacted = await compact(key, transcript, SUMMARY_BUDGET)
    const tail = tailWithin(transcript, TAIL_BUDGET)

    // Atoms for this prefix only: a smaller history must not borrow a larger one's memory.
    const atoms = await buildAtoms(`${projectId}-${point.size}`, point.kept, key)
    const root = path.join(BENCH, 'plugin-root', `${projectId}-${point.size}`)
    const seeded = await seedStore(root, atoms.map((atom) => ({ kind: atom.kind, text: atom.text, tags: atom.tags })))
    console.log(`summary ~${estimateTokens(compacted.summary)} tok, atoms ${seeded.result.live}`)

    for (const question of chosen) {
      const reference = question.answer_short ?? question.answer
      const recall = await recallFor(root, question.question)
      const recalled = recall.recall

      const contexts = {
        A: `=== PROJECT NOTES (compacted) ===\n${compacted.summary}`,
        B: `=== RECENT CONVERSATION ===\n${tail}`,
        C: recalled.ok === true
          ? `=== PROJECT NOTES (compacted) ===\n${compacted.summary}\n\n${recalled.block}`
          : `=== PROJECT NOTES (compacted) ===\n${compacted.summary}`,
      }

      const row = { project_id: projectId, size: point.size, actualTokens: point.tokens, sessions: point.kept.length, question_id: question.id, arms: {} }
      for (const [arm, context] of Object.entries(contexts)) {
        const answered = await answer(key, context, question.question)
        const graded = await judge(key, question.question, reference, answered.answer)
        row.arms[arm] = {
          verdict: graded.verdict,
          contextTokens: estimateTokens(context),
          inputTokens: answered.usage.input,
          outputTokens: answered.usage.output,
          latencyMs: answered.latencyMs,
        }
      }
      rows.push(row)
      const line = ['A', 'B', 'C'].map((arm) => `${arm}:${row.arms[arm].verdict}`).join(' ')
      console.log(`  ${question.id} ${line}`)
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(OUT, `length-${projectId}-${stamp}.jsonl`)
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')

  // Summarise by size.
  console.log('\n=== by history size ===')
  for (const point of points) {
    const subset = rows.filter((row) => row.size === point.size)
    if (subset.length === 0) continue
    const line = ['A', 'B', 'C'].map((arm) => {
      const correct = subset.filter((row) => row.arms[arm].verdict === 'CORRECT').length
      return `${arm} ${correct}/${subset.length} (${((correct / subset.length) * 100).toFixed(0)}%)`
    }).join('  ')
    console.log(`  ~${String(point.tokens).padStart(6)} tok  ${line}`)
  }
  console.log(`\nwritten: ${file}`)
}

main().catch((error) => {
  console.error('LENGTH FAILED:', error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
