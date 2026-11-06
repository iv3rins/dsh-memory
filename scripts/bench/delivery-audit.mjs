// Task 1: replay the 13 DELIVERY_FAILURE rows and find the actual root cause.
//
// The Phase 2 classifier called these "delivered id, missing value". That label is a
// symptom. This replays each row against the live code path and records, for the same
// atom, five distinct states the brief asks to keep apart:
//
//   selected   the ranking chose it
//   resolved   the store returned a record for that id
//   rendered   the renderer emitted a line for it
//   delivered  its text appears in the final context
//   evidence_verified  its distinctive value appears in that text
//
// A row where delivered is true but evidence_verified is false is the interesting case,
// and it can have two completely different causes: the atom was truncated when stored, or
// the value was never in the atom at all. Distinguishing them decides the fix.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { BENCH, loadSessions } from './lib.mjs'
import { recallFor, seedStore } from './memory-arm.mjs'
import { buildAtoms } from './atoms.mjs'

const RESULTS = path.join(BENCH, 'results')
const OUT = path.join(BENCH, 'delivery-audit')
const MAX_ATOM_CHARS = 480

const file = process.argv[2] ?? 'phase2-2026-11-06T07-39-35-239Z.jsonl'
const rows = readFileSync(path.join(RESULTS, file), 'utf8').trim().split('\n')
  .map((line) => JSON.parse(line))
  .filter((row) => row.kind !== 'build-cost' && row.failure_category === 'DELIVERY_FAILURE')

console.log(`replaying ${rows.length} DELIVERY_FAILURE rows from ${file}\n`)

const { mkdirSync, writeFileSync } = await import('node:fs')
mkdirSync(OUT, { recursive: true })

const audit = []

for (const row of rows) {
  const projectId = row.project_id
  const sessions = loadSessions(projectId)
  const atoms = JSON.parse(readFileSync(path.join(BENCH, 'atoms', `${projectId}.json`), 'utf8')).atoms
  const root = path.join(BENCH, 'plugin-root', projectId)
  await seedStore(root, atoms.map((atom) => ({ kind: atom.kind, text: atom.text, tags: atom.tags })))

  const { readAtoms } = await import('../../core/memory.js')
  const store = readAtoms(root)
  const live = store.ok === true ? store.live : []

  // Re-run recall with the actual question text, taken from the dataset.
  const questions = JSON.parse(readFileSync(path.join(BENCH, `${projectId}-questions.json`), 'utf8'))
  const question = questions.find((entry) => entry.id === row.question_id)
  const recalled = await recallFor(root, question.question)
  const result = recalled.recall

  const selectedIds = result.ok === true ? (result.ids ?? []) : []
  const block = result.ok === true ? result.block : ''

  // The value that was supposed to be delivered.
  const values = row.required_values ?? []

  // For every selected atom, record all five states.
  const perAtom = selectedIds.map((id) => {
    const atom = live.find((entry) => entry.id === id)
    const resolved = atom !== undefined
    const text = resolved ? atom.text : ''
    // "rendered" means a line for this atom exists; the renderer prefixes each with "- ".
    const rendered = text !== '' && block.includes(text)
    const delivered = text !== '' && block.toLowerCase().includes(text.toLowerCase().slice(0, 40))
    const evidenceVerified = values.length > 0 && values.some((value) => block.toLowerCase().includes(value))
    return {
      id,
      resolved,
      rendered,
      delivered,
      evidence_verified: evidenceVerified,
      // Was this atom already truncated when it was stored?
      stored_truncated: resolved && text.length >= MAX_ATOM_CHARS,
      textLength: text.length,
      carriesValue: values.filter((value) => text.toLowerCase().includes(value)),
    }
  })

  // Where do the required values actually live in the store?
  const valueHomes = values.map((value) => {
    const holders = live.filter((atom) => atom.text.toLowerCase().includes(value))
    return {
      value,
      holders: holders.length,
      selectedHolders: holders.filter((atom) => selectedIds.includes(atom.id)).length,
    }
  })

  const entry = {
    question_id: row.question_id,
    project_id: projectId,
    verdict: row.verdict,
    required_values: values,
    selected: selectedIds.length,
    resolved: perAtom.filter((entry) => entry.resolved).length,
    rendered: perAtom.filter((entry) => entry.rendered).length,
    delivered: perAtom.filter((entry) => entry.delivered).length,
    evidence_verified: perAtom.filter((entry) => entry.evidence_verified).length,
    atoms: perAtom,
    valueHomes,
    blockLength: block.length,
  }
  audit.push(entry)

  const badge = entry.evidence_verified > 0 ? 'VERIFIED' : 'MISSING'
  console.log(`${row.question_id} ${badge}  selected ${entry.selected} resolved ${entry.resolved} rendered ${entry.rendered} values ${values.slice(0, 3).join(', ')}`)
  for (const home of valueHomes.slice(0, 3)) {
    console.log(`    "${home.value}" -> ${home.holders} atom(s) hold it, ${home.selectedHolders} selected`)
  }
}

writeFileSync(path.join(OUT, 'delivery-audit.json'), JSON.stringify(audit, null, 1), 'utf8')

// ------------------------------------------------------------------ summarise causes
console.log('\n=== root cause split ===')
const missing = audit.filter((entry) => entry.evidence_verified === 0)
const holdersExistButNotSelected = missing.filter((entry) =>
  entry.valueHomes.some((home) => home.holders > 0 && home.selectedHolders === 0))
const noHolderAtAll = missing.filter((entry) => entry.valueHomes.every((home) => home.holders === 0))
const selectedButValueAbsent = missing.filter((entry) =>
  entry.valueHomes.some((home) => home.holders > 0) && entry.valueHomes.every((home) => home.holders === 0 || home.selectedHolders > 0))
const truncated = audit.filter((entry) => entry.atoms.some((atom) => atom.stored_truncated))

console.log(`rows missing the value in the block: ${missing.length}`)
console.log(`  a holder exists in the store but was not selected: ${holdersExistButNotSelected.length}`)
console.log(`  no atom anywhere holds the value:                  ${noHolderAtAll.length}`)
console.log(`  holder was selected yet the value is absent:       ${selectedButValueAbsent.length}`)
console.log(`rows containing an atom stored at the 480-char cap:  ${truncated.length}`)
console.log(`\nwritten: ${path.join(OUT, 'delivery-audit.json')}`)
