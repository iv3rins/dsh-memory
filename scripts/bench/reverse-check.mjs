// Reverse-verify the self-check: inject each defect it is meant to catch, confirm it
// fails, then restore. A check that has never been seen failing is a check that
// asserts nothing.
import { execFileSync } from 'node:child_process'
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const REPO = path.join(import.meta.dirname, '..', '..')
const RESULTS = path.join(REPO, '_bench', 'codememo', 'results')

/** The newest stored run, which is the one the report draws its numbers from. */
function newestRun() {
  const names = readdirSync(RESULTS).filter((name) => name.endsWith('.json'))
  if (names.length === 0) throw new Error(`no result files in ${RESULTS}`)
  names.sort()
  return path.join(RESULTS, names[names.length - 1])
}

const FILE = newestRun()
const BACKUP = path.join(tmpdir(), 'bench-result-backup.json')

copyFileSync(FILE, BACKUP)
const clean = readFileSync(FILE, 'utf8')

/** Run the self-check and report whether it passed. */
function check() {
  try {
    execFileSync(process.execPath, ['scripts/bench/selfcheck.mjs'], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { passed: true, message: '' }
  } catch (error) {
    const text = String(error.stderr ?? error.message)
    const line = /AssertionError[^\n]*\n([^\n]*)/.exec(text.replace(/\u001b\[[0-9;]*m/g, ''))
    return { passed: false, message: line === null ? text.slice(0, 160) : line[1].slice(0, 160) }
  }
}

const results = []

// --- Defect 1: a verdict outside the closed set.
{
  const run = JSON.parse(clean)
  run.rows[0].arms.A.verdict = 'MAYBE'
  writeFileSync(FILE, JSON.stringify(run, null, 1), 'utf8')
  results.push(['invalid verdict', check()])
}

// --- Defect 2: a tally that does not match its rows.
{
  const run = JSON.parse(clean)
  run.arms.A.correct = 999
  writeFileSync(FILE, JSON.stringify(run, null, 1), 'utf8')
  results.push(['tally mismatch', check()])
}

// --- Defect 3: the summary that never saw the transcript.
{
  const run = JSON.parse(clean)
  run.summaryTokens = 72
  writeFileSync(FILE, JSON.stringify(run, null, 1), 'utf8')
  results.push(['truncated summary', check()])
}

// --- Defect 4: a missing arm entry.
{
  const run = JSON.parse(clean)
  delete run.rows[3].arms.B
  writeFileSync(FILE, JSON.stringify(run, null, 1), 'utf8')
  results.push(['missing arm', check()])
}

// Restore and confirm green again.
writeFileSync(FILE, clean, 'utf8')
const restored = check()

console.log('=== injected defects (each must be caught) ===')
for (const [name, outcome] of results) {
  console.log(`${outcome.passed ? 'NOT CAUGHT' : 'caught    '}  ${name.padEnd(20)} ${outcome.message}`)
}
console.log(`\nrestored: ${restored.passed ? 'green again' : 'STILL RED — ' + restored.message}`)
const allCaught = results.every(([, outcome]) => outcome.passed === false)
console.log(allCaught ? 'REVERSE-VERIFIED: every injected defect was caught' : 'PROBLEM: a defect passed the check')
