// Is semantic category routing worth keeping? Measured against the alternative of deleting
// it, across every question in both projects.
//
// The honest question is not "does it help a little" but "does the mechanism ever fire, and
// when it fires does it fire correctly". A term that almost never fires is not a feature;
// it is dead weight that makes the score harder to reason about.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { BENCH } from './lib.mjs'
import { categoryAgreement, categoryContext } from '../../core/query-category.js'

const RESULTS = path.join(BENCH, 'results')
const file = process.argv[2] ?? 'phase2-2026-11-06T08-29-09-897Z.jsonl'

function distinctiveValues(reference) {
  const out = new Set()
  for (const match of String(reference).match(/v?\d+\.\d+\.\d+|[0-9a-f]{16,}|[A-Za-z_][A-Za-z0-9_]{8,}|\b\d{3,}\b/g) ?? []) {
    out.add(match.toLowerCase())
  }
  return [...out]
}

const { readAtoms } = await import('../../core/memory.js')

for (const projectId of ['project_01_cli_tool', 'project_02_multi_repo_tool']) {
  const root = path.join(BENCH, 'plugin-root', projectId)
  const store = readAtoms(root)
  const atoms = store.ok === true ? store.live : []
  if (atoms.length === 0) continue
  const questions = JSON.parse(readFileSync(path.join(BENCH, `${projectId}-questions.json`), 'utf8'))

  let questionsWithCategory = 0
  let questionsWhereHolderShares = 0
  let questionsWhereAnyAtomShares = 0

  for (const question of questions) {
    const context = categoryContext({ text: question.question })
    if (context.explicit.length + context.inferred.length > 0) questionsWithCategory += 1

    const values = distinctiveValues(question.answer_short ?? question.answer)
    const holders = values.length === 0
      ? []
      : atoms.filter((atom) => values.some((value) => atom.text.toLowerCase().includes(value)))
    if (holders.length === 0) continue

    // Does the correct atom share a category with the request?
    const holderShares = holders.some((holder) => categoryAgreement(context.atomCategories(holder), context).shared.length > 0)
    if (holderShares) questionsWhereHolderShares += 1

    // How many atoms in the whole store would match on category alone? If this is large, the
    // term cannot discriminate and adding it only reshuffles noise.
    const anyShares = atoms.filter((atom) => categoryAgreement(context.atomCategories(atom), context).shared.length > 0).length
    if (anyShares > 0) questionsWhereAnyAtomShares += 1
  }

  console.log(`\n=== ${projectId} (${questions.length} questions, ${atoms.length} atoms) ===`)
  console.log(`  request carries a voting category:        ${questionsWithCategory}/${questions.length}`)
  console.log(`  the answer-holder shares it:              ${questionsWhereHolderShares}`)
  console.log(`  any atom shares it (candidate fan-out):   ${questionsWhereAnyAtomShares}`)
}
