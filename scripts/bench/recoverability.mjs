/**
 * Measure recoverability without any model in the loop.
 *
 * The question this answers: given a fixed store of atoms and a fixed recall budget,
 * can the plugin bring back the atom a question needs? That is a property of the
 * retrieval path, and it is decidable by string comparison — so it is measured before
 * spending a single call on answer generation. Running the expensive arms first and
 * discovering that nothing was retrievable would have been a waste of budget and a
 * misleading report.
 *
 * Two rates are reported, and the difference matters:
 *
 *   ceiling   the evidence atom exists in the store at all
 *   delivered recall actually returns it within the configured budget
 *
 * A large gap between them is a budget problem; both low is an extraction problem.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { BENCH, estimateTokens, loadSessions } from './lib.mjs'
import { buildAtoms } from './atoms.mjs'
import { apiKey } from './lib.mjs'
import { recallFor, seedStore } from './memory-arm.mjs'

const projectId = process.argv[2] ?? 'project_02_multi_repo_tool'
const limit = Number(process.argv[3] ?? '40')

/** Distinctive, discriminating strings from a reference answer. */
function probesOf(reference) {
  const text = String(reference)
  const out = new Set()
  for (const match of text.matchAll(/[0-9a-f]{12,}/gi)) out.add(match[0].toLowerCase())
  for (const match of text.matchAll(/\d+\.\d+\.\d+/g)) out.add(match[0].toLowerCase())
  for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{7,}/g)) out.add(match[0].toLowerCase())
  return [...out]
}

const sessions = loadSessions(projectId)
const questions = JSON.parse(readFileSync(path.join(BENCH, `${projectId}-questions.json`), 'utf8'))

// Deterministic sample, identical to the one the run uses.
const { createHash } = await import('node:crypto')
const ranked = questions
  .map((item) => ({ item, key: createHash('sha256').update(`codememo-v1:${item.id}`).digest('hex') }))
  .sort((left, right) => (left.key < right.key ? -1 : 1))
  .slice(0, limit)
  .map((entry) => entry.item)

const key = apiKey()
const atoms = await buildAtoms(projectId, sessions, key)
const root = path.join(BENCH, 'plugin-root', projectId)
const seeded = await seedStore(root, atoms.map((atom) => ({ kind: atom.kind, text: atom.text, tags: atom.tags })))
console.log('store:', JSON.stringify(seeded.result), 'atoms', seeded.written)

let ceiling = 0
let delivered = 0
const misses = []

for (const question of ranked) {
  const probes = probesOf(question.answer_short ?? question.answer).slice(0, 10)
  const hitAtoms = atoms.filter((atom) => probes.some((probe) => atom.text.toLowerCase().includes(probe)))
  if (hitAtoms.length > 0) ceiling += 1

  const { recall } = await recallFor(root, question.question)
  if (recall.ok === true) {
    const block = recall.block.toLowerCase()
    if (probes.some((probe) => block.includes(probe))) delivered += 1
    else misses.push({ id: question.id, atoms: recall.atoms, tokens: recall.tokens })
  } else {
    misses.push({ id: question.id, atoms: 0, tokens: 0, reason: recall.reason })
  }
}

console.log('\n=== recoverability (no model calls) ===')
console.log('questions:', ranked.length)
console.log('ceiling  (evidence atom exists):', ceiling, `(${((ceiling / ranked.length) * 100).toFixed(1)}%)`)
console.log('delivered (recall returns it):', delivered, `(${((delivered / ranked.length) * 100).toFixed(1)}%)`)
console.log('misses:', misses.length)
for (const miss of misses.slice(0, 12)) console.log('  ', miss.id, 'atoms', miss.atoms, 'tokens', miss.tokens, miss.reason ?? '')
