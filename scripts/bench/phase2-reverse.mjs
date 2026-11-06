// Reverse-verify the two Phase 2 gates, then confirm both go green again.
//
// Both gates are new, and a gate that has never been observed failing is not evidence of
// anything. Each injected defect corresponds to a mistake actually made while building
// this phase.
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const REPO = path.join(import.meta.dirname, '..', '..')

/// Run one script and say whether it passed.
//
// `execFileSync` inherits this process's environment, and these gates read
// `LLM_BASE_URL`; a missing value must not be confused with a failing assertion. The exit
// code is the only signal used, and stderr is captured so a genuine error can be shown.
function run(script) {
  try {
    execFileSync(process.execPath, [script], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
    return { passed: true, detail: '' }
  } catch (error) {
    const text = String(error.stderr ?? error.message).replace(/\u001b\[[0-9;]*m/g, '')
    const line = text.split('\n').find((entry) => entry.includes('AssertionError') || entry.includes('Error'))
    return { passed: false, detail: (line ?? text.split('\n')[0] ?? '').trim().slice(0, 100) }
  }
}

const results = []

// --- Gate 1: the attribution classifier.
// Inject a classifier that ignores its input, then confirm the test fails.
{
  const file = path.join(REPO, 'scripts', 'bench', 'phase2.mjs')
  const backup = path.join(process.env.TEMP ?? '/tmp', 'phase2.backup.mjs')
  copyFileSync(file, backup)
  const original = readFileSync(file, 'utf8')

  // Break `stronglyCovered` so a bare short number counts as evidence again — the exact
  // defect that inflated REASONING_FAILURE to 41 before it was fixed.
  const broken = original.replace(
    'const identifier = /^v?\\d+\\.\\d+\\.\\d+$|^[0-9a-f]{16,}$|^[a-z_][a-z0-9_]{8,}$/',
    'const identifier = /^.*$/',
  )
  if (broken === original) throw new Error('could not break stronglyCovered; the pattern changed')
  writeFileSync(file, broken, 'utf8')
  results.push(['classifier ignores short-number noise', false, run('scripts/bench/attribution.test.mjs')])

  writeFileSync(file, original, 'utf8')
  results.push(['classifier restored', true, run('scripts/bench/attribution.test.mjs')])
  rmSync(backup, { force: true })
}

// --- Gate 2: the oracle leakage check.
// Make the oracle return the reference answer itself, then confirm the check fails.
{
  const file = path.join(REPO, 'scripts', 'bench', 'oracle.mjs')
  const original = readFileSync(file, 'utf8')
  const broken = original.replace(
    "const text = header + parts.join('\\n')",
    "const text = header + parts.join('\\n') + '\\n' + String(question.answer ?? '')",
  )
  if (broken === original) throw new Error('could not inject the answer; the assembly line changed')
  writeFileSync(file, broken, 'utf8')
  results.push(['oracle leaks the reference answer', false, run('scripts/bench/oracle-check.mjs')])

  writeFileSync(file, original, 'utf8')
  results.push(['oracle restored', true, run('scripts/bench/oracle-check.mjs')])
}

// Each entry knows whether it is supposed to pass or fail, so the report cannot be
// misread: a restored gate that passes is not "not caught", it is "green".
console.log('=== reverse verification (defect must go red, restore must go green) ===')
for (const [name, expectPass, outcome] of results) {
  const ok = expectPass ? outcome.passed : outcome.passed === false
  const state = outcome.passed ? 'GREEN' : 'RED  '
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${state}  ${name.padEnd(42)} ${outcome.detail}`)
}

const defectCaught = results.filter(([, expectPass, outcome]) => expectPass === false && outcome.passed === false).length
const restoreGreen = results.filter(([, expectPass, outcome]) => expectPass === true && outcome.passed === true).length
console.log(`\ndefects caught: ${defectCaught}/2`)
console.log(`restores green: ${restoreGreen}/2`)
process.exitCode = defectCaught === 2 && restoreGreen === 2 ? 0 : 1
