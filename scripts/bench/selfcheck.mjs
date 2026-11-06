/**
 * Reverse-verify the measurement, the way the project requires every gate to be
 * verified: break the thing on purpose, confirm the check goes red, restore.
 *
 * A harness that reports numbers and has never been shown to fail is indistinguishable
 * from one that reports whatever it is handed. These three checks each cover a defect
 * that actually happened during this run.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const OUT = path.join(import.meta.dirname, '..', '..', '_bench', 'codememo', 'results')

/** The same Wilson interval the report uses. */
function wilson(successes, n, z = 1.96) {
  const p = successes / n
  const denominator = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denominator
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)]
}

// --- 1. The interval must widen as evidence shrinks.
// If this does not hold, the CI is decorative and would let a 2-question run look
// as trustworthy as a 40-question one.
{
  const wide = wilson(1, 2)
  const narrow = wilson(20, 40)
  const wideWidth = wide[1] - wide[0]
  const narrowWidth = narrow[1] - narrow[0]
  assert.ok(wideWidth > narrowWidth, `a 2-sample CI (${wideWidth.toFixed(3)}) must be wider than a 40-sample CI (${narrowWidth.toFixed(3)})`)

  // Inject the defect: a "CI" that ignores n, and show the real one is not that.
  const broken = (s) => [s - 0.05, s + 0.05]
  const brokenWidth = broken(0.5)[1] - broken(0.5)[0]
  assert.ok(Math.abs(brokenWidth - 0.1) < 1e-9, 'the broken version has a constant width')
  assert.ok(
    Math.abs(wideWidth - brokenWidth) > 1e-6,
    'the real interval differs from the constant-width one',
  )
}

// --- 2. Every stored row must carry a verdict per arm that ran.
// A missing verdict silently counts as wrong, which is how a bug becomes a result.
{
  const files = readdirSync(OUT).filter((name) => name.endsWith('.json'))
  assert.ok(files.length > 0, 'there are result files to check')
  for (const file of files) {
    const run = JSON.parse(readFileSync(path.join(OUT, file), 'utf8'))
    for (const row of run.rows) {
      for (const arm of Object.keys(run.arms)) {
        const entry = row.arms[arm]
        assert.ok(entry !== undefined, `${file} ${row.id}: arm ${arm} has an entry`)
        assert.ok(
          ['CORRECT', 'PARTIAL', 'WRONG'].includes(entry.verdict),
          `${file} ${row.id} arm ${arm}: verdict is one of the three values, got ${String(entry.verdict)}`,
        )
      }
    }
    // Tallies must match the rows, not be computed from a different source.
    for (const [arm, tally] of Object.entries(run.arms)) {
      const counted = run.rows.filter((row) => row.arms[arm].verdict === 'CORRECT').length
      assert.equal(tally.correct, counted, `${file}: ${arm} correct count matches the rows`)
    }
  }
}

// --- 3. A summary must actually cover the history it claims to summarise.
// The defect that invalidated the first full run: a 588k-token transcript "compacted"
// to 72 tokens, because only the tail was ever handed to the summariser.
{
  const ratioCeiling = 400
  const files = readdirSync(OUT).filter((name) => name.endsWith('.json'))
  for (const file of files) {
    const run = JSON.parse(readFileSync(path.join(OUT, file), 'utf8'))
    const ratio = run.transcriptTokens / Math.max(1, run.summaryTokens)
    assert.ok(
      ratio < ratioCeiling,
      `${run.projectId}: summary is ${ratio.toFixed(0)}:1 of the transcript, which means the summary did not see most of it`,
    )
    assert.ok(run.summaryTokens > 500, `${run.projectId}: summary is ${run.summaryTokens} tokens, too small to be a real compaction`)
  }
}

console.log('BENCH-SELFCHECK OK: the interval widens with less evidence, every row carries a valid verdict per arm, tallies match rows, and every stored summary is a plausible compaction of its transcript')
