// Reverse-verify the truncation-disclosure gate: silence the disclosure and confirm the
// gate goes red. A disclosure that is never checked is indistinguishable from one that is
// missing.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const REPO = path.join(import.meta.dirname, '..', '..')
const TARGET = path.join(REPO, 'core', 'gate.js')
const original = readFileSync(TARGET, 'utf8')

function gate() {
  try {
    execFileSync(process.execPath, ['tests/truncation.mjs'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}

const DEFECTS = [
  {
    name: 'no per-atom provenance tag',
    from: "      mayBeTruncated ? `possibly truncated at ${MAX_ATOM_CHARS} chars` : null,",
    to: '      null,',
  },
  {
    name: 'no block-level disclosure line',
    from: '  if (truncated > 0) {',
    to: '  if (false) {',
  },
]

const outcomes = []
for (const defect of DEFECTS) {
  if (original.includes(defect.from) === false) {
    outcomes.push({ name: defect.name, applied: false, caught: null })
    continue
  }
  writeFileSync(TARGET, original.replace(defect.from, defect.to), 'utf8')
  outcomes.push({ name: defect.name, applied: true, caught: gate() === false })
  writeFileSync(TARGET, original, 'utf8')
}

const restored = gate()

console.log('=== injected truncation-disclosure defects ===')
for (const outcome of outcomes) {
  if (outcome.applied === false) {
    console.log(`SKIP  ${outcome.name}`)
    continue
  }
  console.log(`${outcome.caught ? 'ok  ' : 'FAIL'}  RED  ${outcome.name}`)
}
console.log(`\nrestored gate green: ${restored}`)
const allCaught = outcomes.every((outcome) => outcome.applied === false || outcome.caught === true)
process.exitCode = allCaught && restored ? 0 : 1
