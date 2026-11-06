/**
 * Run the arm comparison for one project.
 *
 * Arm C is the load-bearing one: it is the only arm that uses this plugin's real
 * code. Facts are written through `recordAtoms` into a throwaway project root under
 * `_bench/`, then recalled with `recallForStep` using the same settings a live profile
 * uses. An experiment that hand-picked its own context and called it "memory" would
 * measure the author's intent, not the code.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { DEFAULTS, normalizeConfig } from '../../core/config.js'
import { ATOMS_FILE, normalizeAtom, recordAtoms } from '../../core/memory.js'
import { buildQuery } from '../../core/gate.js'
import { recallForStep } from '../../lib/recall.js'

/** A fact extracted from the history, in the shape the plugin stores. */
export function toAtom(fact) {
  return normalizeAtom({
    kind: fact.kind,
    text: fact.text,
    weight: fact.weight ?? 3,
    confidence: fact.confidence ?? 0.9,
    tags: fact.tags ?? [],
    files: fact.files ?? [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }, { now: '2026-01-01T00:00:00.000Z' })
}

/**
 * Write facts into a fresh project root and return it.
 *
 * `recordAtoms` is asynchronous — it serialises writers behind a lock file — so this
 * must be awaited. Calling it without awaiting returns before anything is on disk,
 * which silently turns every later recall into "no atoms are stored". That is exactly
 * how an earlier version of this harness reported a plausible-looking 0%.
 */
export async function seedStore(root, facts) {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(path.dirname(path.join(root, ATOMS_FILE)), { recursive: true })
  const atoms = []
  for (const fact of facts) {
    const atom = toAtom(fact)
    if (atom !== null) atoms.push(atom)
  }
  const result = await recordAtoms({ root, atoms, by: { source: 'bench' } })
  if (result.ok !== true) throw new Error(`seedStore failed: ${result.reason}`)
  return { root, written: atoms.length, result }
}

/**
 * Recall memory for one question through the plugin's real path.
 *
 * `routerTier: 'off'` is deliberate: the router subagent is not part of this question
 * (the user asked about compaction loss, not routing quality), and turning it on would
 * make the run depend on a second model call whose effect would be unmeasured.
 */
export async function recallFor(root, question, settingsOverrides = {}) {
  const settings = normalizeConfig({
    ...DEFAULTS,
    routerTier: 'off',
    injectRecall: true,
    ...settingsOverrides,
  })
  const recall = await recallForStep({
    root,
    settings,
    query: buildQuery([question]),
    projectId: 'bench',
    routerAvailable: false,
  })
  return { recall, settings }
}

/** The context an answer call receives for arm C. */
export function armCContext(summary, recall) {
  if (recall.ok !== true) return `=== PROJECT NOTES (compacted) ===\n${summary}`
  return `=== PROJECT NOTES (compacted) ===\n${summary}\n\n${recall.block}`
}

export { ATOMS_FILE, writeFileSync }
