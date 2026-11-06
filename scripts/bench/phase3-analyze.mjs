// Paired statistics for Phase 3, and a check on whether any observed difference is real.
//
// Rules this file enforces, because a benchmark that ignores them reports noise as progress:
//
// - every comparison is paired on the same question, not on two independent rates;
// - a difference whose interval spans zero is reported as "not established", whatever its
//   sign;
// - the run-to-run variance of the same arm is estimated separately, so a between-arm
//   difference smaller than that variance is called out as indistinguishable.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const OUT = path.join(import.meta.dirname, '..', '..', '_bench', 'codememo', 'results')

function newest(prefix) {
  const names = readdirSync(OUT).filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl')).sort()
  if (names.length === 0) throw new Error(`no runs with prefix ${prefix}`)
  return path.join(OUT, names[names.length - 1])
}

const rows = readFileSync(newest('phase3-'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
const ARMS = ['A', 'B', 'C', 'D']
const LABELS = {
  A: 'delivery fix, limit 8',
  B: 'delivery fix, limit 12',
  C: 'B + semantic category',
  D: 'C + standing share 0.25',
}

/** Wilson interval for one proportion. */
function wilson(successes, n, z = 1.96) {
  if (n === 0) return [0, 0]
  const p = successes / n
  const denominator = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denominator
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)]
}

/** Exact two-sided McNemar test on discordant pairs. */
function mcnemar(onlyFirst, onlySecond) {
  const n = onlyFirst + onlySecond
  if (n === 0) return 1
  const choose = (a, b) => {
    let result = 1
    for (let index = 0; index < b; index += 1) result = (result * (a - index)) / (index + 1)
    return result
  }
  let tail = 0
  for (let index = 0; index <= Math.min(onlyFirst, onlySecond); index += 1) tail += choose(n, index) * Math.pow(0.5, n)
  return Math.min(1, tail * 2)
}

const pct = (value) => `${(value * 100).toFixed(1)}%`

console.log(`=== accuracy per arm (n=${rows.length}) ===\n`)
for (const arm of ARMS) {
  const correct = rows.filter((row) => row.arms[arm].verdict === 'CORRECT').length
  const [low, high] = wilson(correct, rows.length)
  console.log(`${arm}  ${LABELS[arm].padEnd(30)} ${String(correct).padStart(2)}/${rows.length} = ${pct(correct / rows.length).padStart(6)}  95% CI [${pct(low)}, ${pct(high)}]`)
}

console.log('\n=== retrieval of the answer-holder (questions where a holder exists) ===\n')
for (const arm of ARMS) {
  const known = rows.filter((row) => row.arms[arm].holdersKnown === true)
  const retrieved = known.filter((row) => row.arms[arm].retrieved === true).length
  const [low, high] = wilson(retrieved, known.length)
  console.log(`${arm}  ${String(retrieved).padStart(2)}/${known.length} = ${pct(retrieved / known.length).padStart(6)}  95% CI [${pct(low)}, ${pct(high)}]`)
}

console.log('\n=== paired comparisons ===\n')
const PAIRS = [['B', 'A'], ['C', 'B'], ['D', 'C'], ['C', 'A']]
for (const [first, second] of PAIRS) {
  let onlyFirst = 0
  let onlySecond = 0
  for (const row of rows) {
    const a = row.arms[first].verdict === 'CORRECT'
    const b = row.arms[second].verdict === 'CORRECT'
    if (a && b === false) onlyFirst += 1
    if (b && a === false) onlySecond += 1
  }
  const diff = (onlyFirst - onlySecond) / rows.length
  const discordant = onlyFirst + onlySecond
  const se = discordant === 0 ? 0 : Math.sqrt(discordant) / rows.length
  const p = mcnemar(onlyFirst, onlySecond)
  const established = Math.abs(diff) > 0 && (diff - 1.96 * se) * (diff + 1.96 * se) > 0
  console.log(`${first} vs ${second}: ${(diff * 100 >= 0 ? '+' : '')}${(diff * 100).toFixed(1)} pp  95% CI [${((diff - 1.96 * se) * 100).toFixed(1)}, ${((diff + 1.96 * se) * 100).toFixed(1)}]  only ${first} ${onlyFirst} / only ${second} ${onlySecond}  p=${p.toFixed(3)}  ${established ? 'ESTABLISHED' : 'not established'}`)
}

console.log('\n=== the honest reading ===')
console.log('A vs B isolates the slot ceiling: 8 -> 12 atoms. That is the only change with a')
console.log('clear mechanism behind it (more candidates fit), and it is the comparison to look at')
console.log('first. C and D add the semantic term and a standing-share change respectively; see')
console.log('their intervals above before treating either as an improvement.')

// --- run-to-run variance: the same arm measured twice is the noise floor.
const otherRuns = readdirSync(OUT).filter((name) => name.startsWith('phase3-')).sort()
if (otherRuns.length >= 2) {
  const first = readFileSync(path.join(OUT, otherRuns[otherRuns.length - 2]), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const second = readFileSync(path.join(OUT, otherRuns[otherRuns.length - 1]), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  console.log('\n=== run-to-run noise floor ===')
  for (const arm of ARMS) {
    const a = first.filter((row) => row.arms[arm]?.verdict === 'CORRECT').length
    const b = second.filter((row) => row.arms[arm]?.verdict === 'CORRECT').length
    console.log(`${arm}: ${a}/${first.length} in one run, ${b}/${second.length} in the next — spread ${Math.abs(a - b)} question(s)`)
  }
  console.log('Any between-arm difference at or below this spread is indistinguishable from')
  console.log('rerunning the same arm, and must not be reported as an improvement.')
}
