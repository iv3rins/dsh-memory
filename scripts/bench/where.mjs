// Where does a question's answer live: in genuine conversation, or only inside a
// compaction summary that a previous context produced?
//
// That distinction is the whole experiment. If a fact appears only in a summary, then
// a memory system that stores atoms can still reach it while a summary-only arm has
// already lost the detail — which is exactly the loss being measured. If it appears in
// raw conversation, both arms can in principle find it and the question measures
// retrieval rather than loss.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { BENCH, loadSessions } from './lib.mjs'

const projectId = process.argv[2] ?? 'project_02_multi_repo_tool'
const sessions = loadSessions(projectId)
const questions = JSON.parse(readFileSync(path.join(BENCH, `${projectId}-questions.json`), 'utf8'))

/** Distinctive strings from a reference answer: numbers, hashes and rare tokens. */
function probesOf(reference) {
  const text = String(reference)
  const out = new Set()
  for (const match of text.matchAll(/[0-9a-f]{16,}/gi)) out.add(match[0])
  for (const match of text.matchAll(/\d+\.\d+\.\d+/g)) out.add(match[0])
  for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{6,}/g)) out.add(match[0])
  return [...out]
}

const summary = { onlyInSummary: 0, inConversation: 0, absent: 0 }
const rows = []

for (const question of questions) {
  const probes = probesOf(question.answer_short ?? question.answer).slice(0, 8)
  if (probes.length === 0) continue
  let inConversation = false
  let inSummary = false
  for (const session of sessions) {
    for (const turn of session.turns) {
      if (!probes.some((probe) => turn.text.includes(probe))) continue
      if (turn.compactSummary === true) inSummary = true
      else inConversation = true
    }
  }
  const where = inConversation ? 'conversation' : inSummary ? 'summary-only' : 'absent'
  if (where === 'conversation') summary.inConversation += 1
  else if (where === 'summary-only') summary.onlyInSummary += 1
  else summary.absent += 1
  rows.push({ id: question.id, category: question.category, where })
}

console.log(`=== ${projectId} ===`)
console.log('questions with usable probes:', rows.length)
console.log(JSON.stringify(summary))
const onlySummary = rows.filter((row) => row.where === 'summary-only')
const absent = rows.filter((row) => row.where === 'absent')
console.log('summary-only ids:', onlySummary.map((row) => row.id).join(', ') || '(none)')
console.log('absent ids:', absent.map((row) => row.id).join(', ') || '(none)')

// Show the distribution by category, because the categories are not equally affected.
const byCategory = {}
for (const row of rows) {
  const key = `cat${row.category}`
  byCategory[key] = byCategory[key] ?? { conversation: 0, 'summary-only': 0, absent: 0 }
  byCategory[key][row.where] += 1
}
console.log(JSON.stringify(byCategory, null, 1))
