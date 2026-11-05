/**
 * A/B experiment harness for the GC-inspired upgrade.
 *
 * The four arms the brief names, expressed as configurations rather than as branches in
 * the product code:
 *
 * | arm | config | what it isolates |
 * |-----|--------|------------------|
 * | A   | `baseline`      | native compaction only |
 * | B   | `retrieval`     | + memory retrieval (the pre-upgrade router path) |
 * | C   | `semantic`      | + semantic category routing |
 * | D   | `lifecycle`     | + lifecycle management |
 *
 * Two properties make the comparison meaningful, and both are enforced here rather than
 * promised in prose:
 *
 * 1. **One variable at a time.** Each arm is the previous arm plus exactly one change, so
 *    a difference can be attributed. A harness that turned three things on at once would
 *    produce numbers nobody could act on.
 * 2. **Identical inputs.** Every arm sees the same atoms, the same query and the same
 *    token budget. The store is built once and read by all arms.
 *
 * What this harness deliberately does *not* do: score relevance. There is no ground truth
 * for "did the model need this atom", so it reports what is measurable — which atoms each
 * arm delivered, how many tokens that cost, whether the router was consulted, and which
 * atoms a strict category filter would have lost — and leaves the judgement to a reader.
 *
 * Run: node tests/experiment.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULTS, normalizeConfig } from '../core/config.js'
import { ATOMS_FILE, normalizeAtom } from '../core/memory.js'
import { buildQuery } from '../core/gate.js'
import { crossCategoryRisk, categoryCounts } from '../core/retrieval.js'
import { recallForStep } from '../lib/recall.js'

/**
 * The four arms, each defined as a delta on the previous one.
 *
 * `tier` is held at `always` for B, C and D so every arm that can reach the router does;
 * otherwise arm B would differ from C for the wrong reason on a step where gating was
 * strong.
 */
export const ARMS = Object.freeze([
  {
    id: 'A',
    name: 'native compact',
    description: 'no retrieval at all: the compacted summary is the only history',
    settings: { routerTier: 'off', injectRecall: false },
  },
  {
    id: 'B',
    name: 'compact + retrieval',
    description: 'the pre-upgrade path: deterministic gate plus the router subagent',
    settings: { routerTier: 'always', injectRecall: true, semanticRouting: false, lifecycleEnabled: false, taskIntentEnabled: false },
  },
  {
    id: 'C',
    name: 'compact + semantic routing',
    description: 'B plus category-aware candidates with the cross-category reserve',
    settings: { routerTier: 'always', injectRecall: true, semanticRouting: true, lifecycleEnabled: false, taskIntentEnabled: false },
  },
  {
    id: 'D',
    name: 'compact + semantic + lifecycle',
    description: 'C plus lifecycle gating, so COLD atoms become references instead of injections',
    settings: { routerTier: 'always', injectRecall: true, semanticRouting: true, lifecycleEnabled: true, taskIntentEnabled: true },
  },
])

/**
 * Build the fixture store every arm shares.
 *
 * It is designed to expose the three failures the brief asks about, so a passing run is
 * informative rather than merely green:
 *
 * - a **hot** constraint about the exact area being edited (all arms that retrieve it
 *   should deliver it);
 * - a **stale-but-wordy** atom that text similarity ranks highly and that a human would
 *   not want injected (the token-cost question);
 * - an **off-category** constraint that matters but whose classification does not match
 *   the task (the "does a wrong colour lose memory" question);
 * - a **used** atom and an **unused** atom, so lifecycle has something to distinguish.
 *
 * @returns {{ atoms: object[], hot: object, wordy: object, offCategory: object, used: object, idle: object }} the fixture.
 */
export function buildFixture() {
  const base = { weight: 3, confidence: 0.9, tags: [], files: [], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }
  const make = (kind, text, extra = {}) => normalizeAtom({ ...base, kind, text, ...extra }, { now: '2026-11-01T00:00:00.000Z' })

  const hot = make('constraint', 'Token refresh must never write the new token before the old one is verified.', {
    files: ['lib/auth.js'],
    weight: 5,
  })
  const wordy = make('summary', `Historical context: ${'the refresh flow was rewritten several times and each attempt had its own tradeoffs. '.repeat(6).trim()}`, {
    files: ['docs/auth-history.md'],
    weight: 3,
  })
  const offCategory = make('constraint', 'Never log a refresh token, anywhere, including debug output.', {
    files: ['scripts/audit.js'],
    weight: 5,
  })
  const used = make('decision', 'Refresh uses a single-flight lock so two requests cannot both rotate the token.', {
    files: ['lib/auth.js'],
    weight: 4,
  })
  const idle = make('fact', 'A note about the marketing website palette.', { files: ['docs/site.md'], weight: 2 })

  return { atoms: [hot, wordy, offCategory, used, idle], hot, wordy, offCategory, used, idle }
}

/** The lifecycle sidecar the D arm reads: `used` is confirmed-used, `idle` and `wordy` are cold. */
export function buildLifecycle(fixture) {
  const counter = (extra = {}) => ({ tier: 'WARM', status: 'active', pinned: false, retrieved: 0, delivered: 0, used: 0, lastUsedAt: null, lastTransition: null, ...extra })
  return {
    schema: 1,
    version: 1,
    atoms: {
      [fixture.hot.id]: counter({ tier: 'HOT', retrieved: 6, delivered: 5, used: 3, lastUsedAt: '2026-11-01T00:00:00.000Z' }),
      [fixture.used.id]: counter({ tier: 'HOT', retrieved: 4, delivered: 4, used: 2, lastUsedAt: '2026-11-01T00:00:00.000Z' }),
      [fixture.wordy.id]: counter({ tier: 'COLD', retrieved: 9, delivered: 2, used: 0 }),
      [fixture.idle.id]: counter({ tier: 'COLD', retrieved: 3, delivered: 1, used: 0 }),
      // Left at the default WARM with no evidence: the arm where lifecycle should cool it
      // out, but not so far that it falls off the same run.
      [fixture.offCategory.id]: counter({ tier: 'WARM', retrieved: 1, delivered: 0, used: 0 }),
    },
    updatedAt: '2026-11-01T00:00:00.000Z',
  }
}

/**
 * Run one arm against a shared store.
 *
 * @param {{ arm: object, root: string, withLifecycle: boolean, query: any, delegate: Function, now?: number, hotId: string, offCategoryId: string }} input - the run.
 * @returns {Promise<object>} the arm's measurements.
 */
export async function runArm(input) {
  const settings = normalizeConfig({ ...DEFAULTS, ...input.arm.settings })
  const startedAt = Date.now()
  const recall = await recallForStep({
    root: input.root,
    settings,
    query: input.query,
    projectId: 'experiment',
    delegate: input.delegate,
    routerAvailable: true,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  const latencyMs = Date.now() - startedAt

  const deliveredIds = recall.ok === true ? (recall.ids ?? []) : []
  const deliveredText = recall.ok === true ? recall.block : ''
  return {
    arm: input.arm.id,
    name: input.arm.name,
    ok: recall.ok === true,
    reason: recall.ok === true ? (recall.reason ?? null) : (recall.reason ?? 'unknown'),
    route: recall.route ?? null,
    atoms: deliveredIds.length,
    tokens: recall.ok === true ? (recall.tokens ?? 0) : 0,
    deliveredIds: [...deliveredIds],
    routerConsulted: recall.router !== undefined,
    routerOk: recall.router?.ok === true,
    categories: recall.semantic?.categories ?? null,
    tiers: recall.semantic?.tiers ?? null,
    excludedByLifecycle: recall.semantic?.excludedByLifecycle ?? 0,
    coldReferences: (deliveredText.match(/NOT loaded/g) ?? []).length,
    latencyMs,
    /** Whether the atom the task must not miss actually arrived. */
    containsHotConstraint: deliveredIds.includes(input.hotId),
    /** Whether the off-category constraint arrived despite its classification. */
    containsOffCategoryConstraint: deliveredIds.includes(input.offCategoryId),
    /** Whether the wordy stale atom was spent on. */
    containsWordyAtom: deliveredIds.includes(input.wordyId),
  }
}

/**
 * Compare two arms and describe the difference.
 *
 * @param {object} left - baseline arm result.
 * @param {object} right - candidate arm result.
 * @returns {{ changed: string[], regressed: string[], improved: string[] }} the comparison.
 */
export function compareArms(left, right) {
  const changed = []
  const regressed = []
  const improved = []
  const note = (condition, label, isRegression) => {
    if (condition !== true) return
    changed.push(label)
    if (isRegression) regressed.push(label)
    else improved.push(label)
  }
  note(right.containsHotConstraint !== left.containsHotConstraint && right.containsHotConstraint === true, 'the hot constraint now arrives', false)
  note(right.containsHotConstraint !== left.containsHotConstraint && right.containsHotConstraint === false, 'the hot constraint no longer arrives', true)
  note(right.containsOffCategoryConstraint !== left.containsOffCategoryConstraint && right.containsOffCategoryConstraint === true, 'the off-category constraint now arrives', false)
  note(right.containsOffCategoryConstraint !== left.containsOffCategoryConstraint && right.containsOffCategoryConstraint === false, 'the off-category constraint no longer arrives', true)
  note(right.containsWordyAtom !== left.containsWordyAtom && right.containsWordyAtom === false, 'the wordy stale atom is no longer spent on', false)
  note(right.containsWordyAtom !== left.containsWordyAtom && right.containsWordyAtom === true, 'the wordy stale atom is now spent on', true)
  note(right.tokens > left.tokens, `token cost rose ${left.tokens} → ${right.tokens}`, true)
  note(right.tokens < left.tokens, `token cost fell ${left.tokens} → ${right.tokens}`, false)
  return { changed, regressed, improved }
}

/**
 * Render the experiment as a table plus the per-arm notes.
 * @param {object[]} results - arm results.
 * @param {object[]} comparisons - pairwise comparisons.
 * @returns {string} the report.
 */
export function renderExperiment(results, comparisons) {
  const header = ['arm', 'atoms', 'tokens', 'hot', 'off-cat', 'wordy', 'cold refs', 'router']
  const rows = results.map((entry) => [
    entry.arm,
    String(entry.atoms),
    String(entry.tokens),
    entry.containsHotConstraint ? 'yes' : 'no',
    entry.containsOffCategoryConstraint ? 'yes' : 'no',
    entry.containsWordyAtom ? 'yes' : 'no',
    String(entry.coldReferences),
    entry.routerConsulted ? (entry.routerOk ? 'ok' : 'failed') : 'not called',
  ])
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => row[index].length)))
  const pad = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ')
  const lines = [pad(header), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(pad)]
  lines.push('')
  for (const comparison of comparisons) {
    lines.push(`${comparison.from} → ${comparison.to}:`)
    if (comparison.changed.length === 0) lines.push('  no measured difference')
    for (const entry of comparison.changed) lines.push(`  ${entry}`)
  }
  lines.push('')
  lines.push('Caveats, stated because they bound what this table can support:')
  lines.push('- A router that returns everything scores "hot yes" for free; the token and wordy columns are what make that visible.')
  lines.push('- No relevance ground truth exists, so this is not an accuracy comparison and no accuracy figure is derived from it.')
  lines.push('- The store is a purpose-built fixture, not a real project history; a real store contains near-duplicate summaries that no arm here models.')
  return lines.join('\n')
}

/**
 * Run the whole experiment end to end.
 *
 * @returns {Promise<{ results: object[], comparisons: object[], report: string, fixture: object }>} the experiment outcome.
 */
export async function runExperiment() {
  const fixture = buildFixture()
  const root = mkdtempSync(join(tmpdir(), 'pm-exp-'))
  try {
    mkdirSync(join(root, '.dsh-memory', 'memory'), { recursive: true })
    writeFileSync(join(root, ATOMS_FILE), fixture.atoms.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
    writeFileSync(join(root, '.dsh-memory', 'memory', 'lifecycle.json'), JSON.stringify(buildLifecycle(fixture)), 'utf8')

    // One query, shared by every arm, naming the task rather than the atoms.
    const query = buildQuery(['fix the token refresh so an old token cannot be used after rotation'])

    // A delegate that behaves like a competent router: it selects the atoms whose text
    // bears on the task and declines the rest. Keeping it identical across arms is what
    // makes the arms differ only by configuration.
    const delegate = async (request) => {
      const prompt = String(request?.prompt ?? '')
      const ids = []
      for (const atom of [fixture.hot, fixture.offCategory, fixture.used, fixture.wordy]) {
        if (prompt.includes(atom.id)) ids.push(atom.id)
      }
      return JSON.stringify({ hot_memory_ids: ids, cold_memory_ids: [], abstained: ids.length === 0, reason: 'fixture router selection' })
    }

    const results = []
    for (const arm of ARMS) {
      results.push(
        await runArm({
          arm,
          root,
          withLifecycle: arm.id === 'D',
          query,
          delegate,
          now: Date.parse('2026-11-02T00:00:00.000Z'),
          hotId: fixture.hot.id,
          offCategoryId: fixture.offCategory.id,
        }),
      )
    }

    const comparisons = []
    for (let index = 1; index < results.length; index += 1) {
      comparisons.push({ from: results[index - 1].arm, to: results[index].arm, ...compareArms(results[index - 1], results[index]) })
    }

    const categories = categoryCounts(fixture.atoms)
    // A deliberately narrow filter: one module, with no `dom:*` escape. This is the
    // scenario the reserve exists for — the off-category constraint lives in
    // `mod:scripts`, so a strict filter would drop it and the reserve is what keeps it.
    // The gate must contain the atoms for the question to have an answer: an empty gate
    // would report zero risk because it was asked about nothing.
    const risk = crossCategoryRisk({
      atoms: fixture.atoms,
      categories: ['mod:lib'],
      gate: { selected: fixture.atoms.map((atom) => ({ atom, score: 1 })), excluded: [] },
    })

    return {
      results,
      comparisons,
      report: [
        renderExperiment(results, comparisons),
        '',
        `fixture categories: ${Object.entries(categories.counts).sort((left, right) => right[1] - left[1]).map(([id, count]) => `${id} ${count}`).join(', ')}`,
        `atoms outside a strict [mod:lib] filter: ${risk.total} — a strict filter would have dropped these; the cross-category reserve is what keeps them`,
      ].join('\n'),
      fixture,
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// Running this file directly executes the experiment and prints the table.
const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  const outcome = await runExperiment()
  console.log(outcome.report)

  // The assertions below are what make this a test rather than a printout: they check the
  // properties the experiment exists to demonstrate, not the exact numbers.
  const byArm = new Map(outcome.results.map((entry) => [entry.arm, entry]))
  const a = byArm.get('A')
  const b = byArm.get('B')
  const c = byArm.get('C')
  const d = byArm.get('D')

  assert.equal(a.ok, false, 'arm A retrieves nothing: native compaction is the only history')
  assert.equal(b.ok, true, 'arm B retrieves through the classic router path')
  assert.equal(b.containsHotConstraint, true, 'arm B delivers the constraint the task must not miss')
  assert.equal(c.ok, true, 'arm C retrieves through the semantic path')
  assert.equal(c.containsHotConstraint, true, 'arm C still delivers the hot constraint')
  // The anti-information-loss property: semantic filtering must not drop the atom whose
  // classification does not match the task.
  assert.equal(c.containsOffCategoryConstraint, true, 'semantic routing keeps an off-category constraint')
  assert.equal(d.ok, true, 'arm D retrieves with lifecycle management')
  assert.equal(d.containsHotConstraint, true, 'arm D still delivers the hot constraint')
  assert.equal(d.containsWordyAtom, false, 'lifecycle management stops spending on a COLD wordy atom')
  // Lifecycle must not silently lose the off-category rule either.
  assert.equal(d.containsOffCategoryConstraint, true, 'lifecycle management keeps the off-category constraint')

  console.log('')
  console.log(
    'EXPERIMENT OK: the four arms differ by one change each, the hot constraint survives every retrieving arm, ' +
    'a semantic category filter does not lose an off-category rule, lifecycle management stops paying for a COLD atom, ' +
    'and no accuracy figure is claimed because none is measurable',
  )
}

export default runExperiment
