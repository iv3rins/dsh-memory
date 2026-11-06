/**
 * Guard the oracle arm against answer leakage.
 *
 * The oracle is supposed to provide evidence, not the answer. If the assembled context
 * already contains the reference answer verbatim, every oracle run measures copying
 * rather than reasoning, and the "answer accuracy given evidence" ceiling becomes a
 * tautology.
 *
 * Two distinct measurements, because they mean different things:
 *
 * - `exactAnswerPresent` — the reference string appears verbatim. Must be zero.
 * - `keyValuePresent`    — the distinctive values (versions, hashes, paths) appear,
 *                          which is *expected*: those values are the evidence. A question
 *                          whose distinctive values are absent from its own evidence is a
 *                          dataset problem and is reported as such.
 */
import { loadProjectMaterial } from './oracle.mjs'
import { buildOracleContext } from './oracle.mjs'

const projects = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const targets = projects.length > 0 ? projects : ['project_01_cli_tool', 'project_02_multi_repo_tool']

let exitCode = 0

for (const projectId of targets) {
  const material = loadProjectMaterial(projectId)
  material.sessionMap = material.sessions

  let exact = 0
  let valuePresent = 0
  let noValue = 0
  const leaks = []
  const valueMisses = []

  for (const question of material.questions) {
    const context = buildOracleContext(material, question)
    if (context.ok !== true) continue
    const haystack = context.text.toLowerCase()
    const reference = String(question.answer ?? '')
    const short = String(question.answer_short ?? '')

    // Verbatim answer leakage: compare on a normalised form so whitespace cannot hide it.
    const norm = (text) => text.toLowerCase().replace(/\s+/g, ' ').trim()
    for (const candidate of [reference, short]) {
      const needle = norm(candidate)
      if (needle.length < 24) continue
      if (haystack.includes(needle)) {
        exact += 1
        leaks.push({ id: question.id, which: candidate === reference ? 'answer' : 'answer_short' })
        break
      }
    }

    // Distinctive values: these SHOULD be present, since they are the evidence.
    const values = [...new Set(String(short || reference).match(/\b\d+\.\d+\.\d+\b|[0-9a-f]{16,}|[A-Za-z_][A-Za-z0-9_]{8,}/g) ?? [])]
    if (values.length === 0) {
      noValue += 1
      continue
    }
    const hits = values.filter((value) => haystack.includes(value.toLowerCase()))
    if (hits.length > 0) valuePresent += 1
    else valueMisses.push({ id: question.id, values: values.slice(0, 3) })
  }

  const total = material.questions.length
  console.log(`=== ${projectId} (${total} questions) ===`)
  console.log('verbatim answer leakage:', exact, '| questions whose evidence carries a distinctive value:', valuePresent, '| no distinctive value in reference:', noValue)
  if (leaks.length > 0) {
    console.log('  LEAKS:', leaks.map((entry) => `${entry.id}(${entry.which})`).join(', '))
    exitCode = 1
  }
  // A reference with distinctive values that appear nowhere in its own evidence cannot be
  // answered from that evidence; that is a data defect worth naming, not a model failure.
  const unresolved = valueMisses.filter((entry) => entry.values.length > 0)
  if (unresolved.length > 0) {
    console.log('  evidence does not contain the reference values for:', unresolved.length, 'question(s)')
    for (const entry of unresolved.slice(0, 5)) console.log(`    ${entry.id}: ${entry.values.join(', ')}`)
  }
}

console.log(exitCode === 0
  ? '\nORACLE-CHECK OK: no question\'s reference answer appears verbatim in its oracle context'
  : '\nORACLE-CHECK FAILED: an oracle context contains its own reference answer')
process.exitCode = exitCode
