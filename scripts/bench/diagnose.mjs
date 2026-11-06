// Diagnose why a recall miss happens: is the right atom absent from the top-8, or is
// it present but spelled differently so a string probe cannot see it?
//
// This distinction decides whether the experiment needs a bigger budget or a better
// extractor, and guessing between those two would waste the whole run.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { BENCH, apiKey, loadSessions } from './lib.mjs'
import { buildAtoms } from './atoms.mjs'
import { recallFor, seedStore } from './memory-arm.mjs'

const projectId = process.argv[2] ?? 'project_01_cli_tool'
const limit = Number(process.argv[3] ?? '40')

function probesOf(reference) {
  const text = String(reference)
  const out = new Set()
  for (const match of text.matchAll(/[0-9a-f]{12,}/gi)) out.add(match[0].toLowerCase())
  for (const match of text.matchAll(/\d+\.\d+\.\d+/g)) out.add(match[0].toLowerCase())
  for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{7,}/g)) out.add(match[0].toLowerCase())
  return [...out]
}

const { createHash } = await import('node:crypto')
const sessions = loadSessions(projectId)
const questions = JSON.parse(readFileSync(path.join(BENCH, `${projectId}-questions.json`), 'utf8'))
const ranked = questions
  .map((item) => ({ item, key: createHash('sha256').update(`codememo-v1:${item.id}`).digest('hex') }))
  .sort((left, right) => (left.key < right.key ? -1 : 1))
  .slice(0, limit)
  .map((entry) => entry.item)

const key = apiKey()
const atoms = await buildAtoms(projectId, sessions, key)
const root = path.join(BENCH, 'plugin-root', projectId)
await seedStore(root, atoms.map((atom) => ({ kind: atom.kind, text: atom.text, tags: atom.tags })))

// Try several budgets so the report states what the setting costs, not what it is.
const budgets = [400, 800, 1200, 2000]
const results = []

for (const budget of budgets) {
  let delivered = 0
  let present = 0
  for (const question of ranked) {
    const probes = probesOf(question.answer_short ?? question.answer).slice(0, 10)
    if (probes.some((probe) => atoms.some((atom) => atom.text.toLowerCase().includes(probe)))) present += 1
    const { recall } = await recallFor(root, question.question, { recallBudget: budget, recallLimit: 12 })
    if (recall.ok === true) {
      const block = recall.block.toLowerCase()
      if (probes.some((probe) => block.includes(probe))) delivered += 1
    }
  }
  results.push({ budget, present, delivered })
  console.log(`budget ${String(budget).padStart(4)}  present ${present}/${ranked.length}  delivered ${delivered}/${ranked.length} (${((delivered / ranked.length) * 100).toFixed(1)}%)`)
}

// For one representative miss, show what WAS returned so the cause is visible.
const missQuestion = ranked.find((question) => {
  const probes = probesOf(question.answer_short ?? question.answer).slice(0, 10)
  return probes.length > 0
})
const { recall } = await recallFor(root, missQuestion.question)
console.log('\n=== example question ===')
console.log('Q:', missQuestion.question.slice(0, 160))
console.log('A:', String(missQuestion.answer_short ?? missQuestion.answer).slice(0, 160))
console.log('recalled block:')
console.log(recall.ok === true ? recall.block.slice(0, 900) : recall.reason)
