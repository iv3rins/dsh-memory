/**
 * Aggregate the arm results into the numbers a reader can act on.
 *
 * Reports raw accuracy, a partial-credit score, the paired difference between arms
 * with a 95% confidence interval (McNemar-style on discordant pairs, plus a normal
 * approximation on the paired difference), and the average context cost. A bare
 * accuracy difference without an interval invites reading noise as an effect: at n=40
 * a few points either way is nothing.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

// Results live next to the checkout, never at an absolute path: the harness must run
// from any clone.
const OUT = path.join(import.meta.dirname, '..', '..', '_bench', 'codememo', 'results')

/** Pick the newest run per project, by the timestamp embedded in the filename. */
function latestRuns() {
  const files = readdirSync(OUT).filter((name) => name.endsWith('.json'))
  const byProject = new Map()
  for (const file of files) {
    // `project_NN_name-2026-11-06T05-28-06-026Z.json` — the project id can contain no
    // unambiguous separator, so split on the ISO stamp instead of counting dashes.
    const match = /^(.*)-(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.json$/.exec(file)
    if (match === null) continue
    const [, project, stamp] = match
    // The stamp uses `-` where ISO uses `:`, and `T` sorts before `:`, so comparing the
    // strings is monotonic only if both sides are formatted identically — they are.
    const existing = byProject.get(project)
    if (existing === undefined || stamp > existing.stamp) byProject.set(project, { file, stamp })
  }
  return [...byProject.values()]
    .sort((left, right) => (left.file < right.file ? -1 : 1))
    .map((entry) => JSON.parse(readFileSync(path.join(OUT, entry.file), 'utf8')))
}

/** Wilson interval for a single proportion. */
function wilson(successes, n, z = 1.96) {
  if (n === 0) return [0, 0]
  const p = successes / n
  const denominator = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denominator
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)]
}

/** Paired difference with a 95% interval from the discordant counts. */
function pairedDifference(rows, armA, armB) {
  let onlyA = 0
  let onlyB = 0
  let both = 0
  for (const row of rows) {
    const a = row.arms[armA]?.verdict === 'CORRECT'
    const b = row.arms[armB]?.verdict === 'CORRECT'
    if (a && b) both += 1
    else if (a) onlyA += 1
    else if (b) onlyB += 1
  }
  const n = rows.length
  const diff = (onlyA - onlyB) / n
  // McNemar: the discordant pairs carry the evidence.
  const discordant = onlyA + onlyB
  const se = discordant === 0 ? 0 : Math.sqrt(discordant) / n
  return { onlyA, onlyB, both, diff, low: diff - 1.96 * se, high: diff + 1.96 * se }
}

const runs = latestRuns()
const overall = { A: { c: 0, p: 0, n: 0, tok: 0 }, B: { c: 0, p: 0, n: 0, tok: 0 }, C: { c: 0, p: 0, n: 0, tok: 0 } }

console.log('=== per project (newest run each) ===\n')
for (const run of runs) {
  console.log(`${run.projectId}  sessions ${run.sessions}  transcript ~${run.transcriptTokens} tok  summary ~${run.summaryTokens} tok  atoms ${run.atoms}`)
  const parts = []
  for (const arm of ['A', 'B', 'C']) {
    const t = run.arms[arm]
    if (t === undefined) continue
    parts.push(`${arm}: ${t.correct}/${t.n} (${(t.accuracy * 100).toFixed(1)}%)`)
    overall[arm].c += t.correct
    overall[arm].p += t.partial
    overall[arm].n += t.n
    overall[arm].tok += t.avgContextTokens * t.n
  }
  console.log('  ' + parts.join('   '))
  for (const pair of [['C', 'A'], ['C', 'B'], ['B', 'A']]) {
    const d = pairedDifference(run.rows, pair[0], pair[1])
    console.log(`  ${pair[0]}-${pair[1]}: ${(d.diff * 100).toFixed(1)} pp  95% CI [${(d.low * 100).toFixed(1)}, ${(d.high * 100).toFixed(1)}]  (only ${pair[0]}: ${d.onlyA}, only ${pair[1]}: ${d.onlyB})`)
  }
  console.log('')
}

console.log('=== pooled ===')
for (const arm of ['A', 'B', 'C']) {
  const t = overall[arm]
  if (t.n === 0) continue
  const [low, high] = wilson(t.c, t.n)
  const partialScore = (t.c + t.p * 0.5) / t.n
  console.log(`${arm}: correct ${t.c}/${t.n} = ${((t.c / t.n) * 100).toFixed(1)}%  95% CI [${(low * 100).toFixed(1)}, ${(high * 100).toFixed(1)}]  partial-credit ${(partialScore * 100).toFixed(1)}%  avg ctx ~${Math.round(t.tok / t.n)} tok`)
}

const pooledRows = runs.flatMap((run) => run.rows)
console.log('')
for (const pair of [['C', 'A'], ['C', 'B'], ['B', 'A']]) {
  const d = pairedDifference(pooledRows, pair[0], pair[1])
  console.log(`pooled ${pair[0]}-${pair[1]}: ${(d.diff * 100).toFixed(1)} pp  95% CI [${(d.low * 100).toFixed(1)}, ${(d.high * 100).toFixed(1)}]`)
}
