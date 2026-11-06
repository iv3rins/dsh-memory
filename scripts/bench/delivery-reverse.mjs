// Reverse-verify the delivery gate: break `verifyDelivery` in the ways this defect class
// actually occurs, and confirm `tests/delivery.mjs` goes red for each.
//
// The three breakages map to real mistakes:
//   1. treating "the id was selected" as "the content arrived"
//   2. treating "no distinctive value" as success instead of unknown
//   3. rounding partial delivery up to verified
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const REPO = path.join(import.meta.dirname, '..', '..')
const TARGET = path.join(REPO, 'core', 'delivery.js')
const original = readFileSync(TARGET, 'utf8')

/** Run the gate; true when it passes. */
function gate() {
  try {
    execFileSync(process.execPath, ['tests/delivery.mjs'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}

const DEFECTS = [
  {
    name: 'id selected counts as delivered content',
    from: 'const rendered = resolved && probe.length > 0 && input.recallBlock.toLowerCase().includes(probe)',
    to: 'const rendered = selected',
  },
  {
    name: 'no checkable value reported as verified',
    from: `    evidenceVerified = null
    integrity = delivered ? 'partial' : 'missing'`,
    to: `    evidenceVerified = true
    integrity = 'verified'`,
  },
  {
    name: 'partial delivery rounded up to verified',
    from: `    integrity = missing.length < expected.length ? 'partial' : 'missing'`,
    to: `    evidenceVerified = true
    integrity = 'verified'`,
  },
]

const outcomes = []
for (const defect of DEFECTS) {
  if (original.includes(defect.from) === false) {
    outcomes.push({ name: defect.name, applied: false, caught: null })
    continue
  }
  writeFileSync(TARGET, original.replace(defect.from, defect.to), 'utf8')
  const passed = gate()
  outcomes.push({ name: defect.name, applied: true, caught: passed === false })
  writeFileSync(TARGET, original, 'utf8')
}

const restored = gate()

console.log('=== injected delivery defects (each must turn the gate red) ===')
for (const outcome of outcomes) {
  if (outcome.applied === false) {
    console.log(`SKIP  ${outcome.name}  (pattern not found; the implementation changed)`)
    continue
  }
  console.log(`${outcome.caught ? 'ok  ' : 'FAIL'}  RED  ${outcome.name}`)
}
console.log(`\nrestored gate green: ${restored}`)

const allCaught = outcomes.every((outcome) => outcome.applied === false || outcome.caught === true)
const applied = outcomes.filter((outcome) => outcome.applied === true).length
console.log(`defects caught: ${outcomes.filter((outcome) => outcome.caught === true).length}/${applied}`)
process.exitCode = allCaught && restored && applied > 0 ? 0 : 1
