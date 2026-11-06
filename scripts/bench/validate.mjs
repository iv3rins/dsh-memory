// Validate the benchmark before spending model calls on it.
//
// Three things must hold or the numbers are meaningless:
//   1. the evidence session for a question exists in the downloaded corpus;
//   2. the reference answer's distinctive strings actually appear in that evidence;
//   3. the transcript fits whatever budget the experiment gives it.
//
// This is the check an earlier version skipped, which is how a run scored 0/6 on
// questions whose answers were sitting in the history all along.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { BENCH, estimateTokens, flatten, loadSessions } from './lib.mjs'

const projects = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const targets = projects.length > 0 ? projects : ['project_01_cli_tool', 'project_02_multi_repo_tool', 'project_03_memory_system']

for (const projectId of targets) {
  const sessions = loadSessions(projectId)
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const questions = JSON.parse(readFileSync(path.join(BENCH, `${projectId}-questions.json`), 'utf8'))
  const transcript = flatten(sessions)

  let missingSession = 0
  let overlapping = 0
  const checked = []

  for (const question of questions) {
    const evidenceIds = [...new Set(question.evidence.map((entry) => entry.session_id))]
    const absent = evidenceIds.filter((id) => !byId.has(id))
    if (absent.length > 0) {
      missingSession += 1
      continue
    }
    // Concatenate the evidence sessions plus any session the question cites.
    const evidenceText = evidenceIds
      .map((id) => byId.get(id).turns.map((turn) => turn.text).join('\n'))
      .join('\n')
      .toLowerCase()

    // Distinctive tokens from the reference answer: numbers and rare words. A question
    // whose reference barely appears in its own evidence is not answerable.
    const reference = String(question.answer_short ?? question.answer)
    const tokens = [...new Set(reference.toLowerCase().match(/[a-z0-9][a-z0-9._-]{3,}/g) ?? [])]
    const hits = tokens.filter((token) => evidenceText.includes(token))
    const ratio = tokens.length === 0 ? 0 : hits.length / tokens.length
    if (ratio >= 0.3) overlapping += 1
    checked.push({ id: question.id, ratio, evidence: evidenceIds.length })
  }

  const sorted = [...checked].sort((a, b) => a.ratio - b.ratio)
  console.log(`=== ${projectId} ===`)
  console.log('sessions', sessions.length, 'questions', questions.length, 'transcript ~tokens', estimateTokens(transcript))
  console.log('missing evidence session:', missingSession, '| reference overlaps evidence >=30%:', overlapping, '/', checked.length)
  console.log('weakest 5:')
  for (const row of sorted.slice(0, 5)) console.log(`   ${row.id} overlap ${(row.ratio * 100).toFixed(0)}% (${row.evidence} evidence sessions)`)
}
