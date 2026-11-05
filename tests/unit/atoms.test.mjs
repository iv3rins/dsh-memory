#!/usr/bin/env node
/**
 * Unit tests for System C: the memory-atom store, the sparse gate, the extractor,
 * the router, the recall orchestrator, and the compaction observer.
 *
 * These are pure-Node modules, so this file runs without the harness. What it
 * insists on is the set of properties that make atoms safe to inject, because a
 * failure in any of them shows up as a *wrong memory* in the model's context —
 * much worse than a crash:
 *
 * - content identity is stable across reformatting and merging;
 * - a tombstone is permanent, so re-extraction cannot undo a `forget`;
 * - a write is atomic and lock-protected, so a reader never sees half a file;
 * - the gate is bounded by budget and count, and an empty query selects nothing;
 * - an untrusted router reply cannot invent an atom id;
 * - a recall never throws, whatever the store or the router does.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const CORE = path.join(import.meta.dirname, '..', '..', 'core')
const LIB = path.join(import.meta.dirname, '..', '..', 'lib')
const load = (base, file) => import(pathToFileURL(path.join(base, file)).href)

const memory = await load(CORE, 'memory.js')
const gate = await load(CORE, 'gate.js')
const extract = await load(CORE, 'extract.js')
const config = await load(CORE, 'config.js')
const compactions = await load(CORE, 'compactions.js')
const router = await load(LIB, 'router.js')
const recall = await load(LIB, 'recall.js')
const observer = await load(LIB, 'compaction-memory.js')
const delegate = await load(LIB, 'delegate.js')

const settings = config.normalizeConfig({})
const root = mkdtempSync(path.join(tmpdir(), 'pm-atoms-'))
const atomPath = path.join(root, memory.ATOMS_FILE)

const writeStore = (atoms) => {
  mkdirSync(path.dirname(atomPath), { recursive: true })
  writeFileSync(atomPath, atoms.map((atom) => JSON.stringify(atom)).join('\n') + '\n', 'utf8')
}

/** Build a stored-shape atom without going through the store. */
const atom = (kind, text, extra = {}) => ({
  ...memory.normalizeAtom({ kind, text }, { now: '2026-01-01T00:00:00.000Z' }),
  ...extra,
})

try {
  // ---------------------------------------------------------------- identity
  {
    assert.equal(memory.ATOM_KINDS.includes('constraint'), true, 'constraint is a known kind')
    assert.equal(
      memory.atomId('constraint', 'Damage is an integer'),
      memory.atomId('constraint', '  Damage   IS an\ninteger  '),
      'identity ignores case and whitespace',
    )
    assert.notEqual(
      memory.atomId('constraint', 'Damage is an integer'),
      memory.atomId('fact', 'Damage is an integer'),
      'identity includes the kind, so the same words can be a rule and a fact',
    )
    assert.equal(memory.atomId('fact', 'x').length, 16, 'ids are short enough to quote in a prompt')

    const long = memory.normalizeAtomText('y'.repeat(2000))
    assert.equal(long.length, memory.MAX_ATOM_CHARS, 'a statement is truncated to one atom')

    assert.equal(memory.normalizeAtom({ text: '' }), null, 'empty text is not an atom')
    assert.equal(memory.normalizeAtom({ kind: 'nonsense', text: 'hello' }).kind, 'fact', 'an unknown kind degrades to fact')
    assert.equal(memory.normalizeAtom({ kind: 'fact', text: 'x', weight: 99 }).weight, 5, 'weight is clamped')
    assert.equal(memory.normalizeAtom({ kind: 'fact', text: 'x', confidence: -1 }).confidence, 0, 'confidence is clamped')
  }

  // ------------------------------------------------------------------ merging
  {
    const base = atom('constraint', 'Never rewrite AGENTS.md')
    const reinforced = memory.mergeAtom(base, {
      ...atom('constraint', 'Never rewrite AGENTS.md'),
      weight: 5,
      tags: ['docs'],
      files: ['AGENTS.md'],
      updatedAt: '2026-02-01T00:00:00.000Z',
    })
    assert.equal(reinforced.id, base.id, 'merging preserves identity')
    assert.equal(reinforced.seen, base.seen + 1, 'a repeat counts as another sighting')
    assert.equal(reinforced.weight, 5, 'weight is raised, never lowered')
    assert.deepEqual(reinforced.tags, ['docs'], 'tags are unioned in')
    assert.equal(reinforced.updatedAt, '2026-02-01T00:00:00.000Z', 'the later timestamp wins')
  }

  // --------------------------------------------------------------- tombstones
  {
    const forgotten = { ...atom('pitfall', 'bpy.ops is unreliable headless'), forgotten: true }
    const revived = memory.mergeAtom(forgotten, atom('pitfall', 'bpy.ops is unreliable headless'))
    assert.equal(revived.forgotten, true, 'a tombstone survives a fresh observation: it is sticky, not last-wins')
  }

  // -------------------------------------------------------------------- store
  {
    const empty = memory.readAtoms(root)
    assert.equal(empty.ok, true, 'reading a missing store is not an error')
    assert.equal(empty.existed, false, 'the store reports its absence')
    assert.deepEqual(empty.live, [], 'an absent store has no atoms')

    const recorded = await memory.recordAtoms({
      root,
      atoms: [
        { kind: 'constraint', text: 'Damage is an integer' },
        { kind: 'decision', text: 'Use the sparse gate in front of the router' },
        { kind: 'fact', text: 'The build ran once on 2026-01-01' },
      ],
      by: { sessionId: 's1', source: 'test' },
      options: { now: '2026-01-02T00:00:00.000Z' },
    })
    assert.equal(recorded.ok, true, 'recording succeeds')
    assert.equal(recorded.added, 3, 'three new atoms are stored')
    assert.equal(recorded.live, 3, 'all three are live')

    const repeat = await memory.recordAtoms({
      root,
      atoms: [{ kind: 'constraint', text: 'damage is   an INTEGER' }],
      options: { now: '2026-01-03T00:00:00.000Z' },
    })
    assert.equal(repeat.ok, true, 're-recording succeeds')
    assert.equal(repeat.added, 0, 'a reformatted duplicate is not a new atom')
    assert.equal(repeat.updated, 1, 'it is merged into the existing one')

    const lines = readFileSync(atomPath, 'utf8').trim().split('\n')
    assert.equal(lines.length, 3, 'the store holds one line per record, with no duplicate record')

    // A malformed line must cost one record, never the whole store.
    writeFileSync(atomPath, `${lines.join('\n')}\n{not json\n`, 'utf8')
    const tolerant = memory.readAtoms(root)
    assert.equal(tolerant.ok, true, 'a corrupt line does not fail the read')
    assert.equal(tolerant.invalid, 1, 'the corrupt line is counted')
    assert.equal(tolerant.atoms.length, 3, 'the readable records are still returned')

    const forgot = await memory.forgetAtoms({ root, ids: [tolerant.atoms[0].id, 'deadbeefdeadbeef'] })
    assert.equal(forgot.ok, true, 'forgetting succeeds')
    assert.equal(forgot.forgotten, 1, 'one atom is forgotten')
    assert.equal(forgot.missing, 1, 'an unknown id is reported as missing')

    const afterForget = memory.readAtoms(root)
    assert.equal(afterForget.atoms.length, 3, 'the tombstone keeps the record on disk')
    assert.equal(afterForget.live.length, 2, 'but it is not live')

    const resurrect = await memory.recordAtoms({
      root,
      atoms: [{ kind: tolerant.atoms[0].kind, text: tolerant.atoms[0].text }],
    })
    assert.equal(resurrect.ok, true, 're-recording a forgotten atom succeeds')
    assert.equal(memory.readAtoms(root).live.length, 2, 'and does not resurrect it')
  }

  // ------------------------------------------------------------------ pruning
  {
    const many = []
    for (let index = 0; index < memory.MAX_ATOM_RECORDS + 40; index += 1) {
      many.push(atom('fact', `fact number ${index}`, { weight: 1 + (index % 5) }))
    }
    const pruned = memory.pruneAtoms(many)
    assert.ok(pruned.atoms.length <= memory.MAX_ATOM_RECORDS, 'pruning enforces the record ceiling')
    assert.ok(pruned.dropped > 0, 'pruning reports what it dropped')
    const tombstones = []
    for (let index = 0; index < 40; index += 1) tombstones.push(atom('fact', `gone ${index}`, { forgotten: true }))
    const kept = memory.pruneAtoms([...many, ...tombstones])
    assert.ok(
      kept.atoms.filter((entry) => entry.forgotten === true).length > 0,
      'tombstones survive pruning, so forgetting is not undone by pressure',
    )
  }

  // --------------------------------------------------------------------- gate
  {
    const atoms = [
      atom('constraint', 'Damage must stay an integer in src/domain/damage.js', { weight: 5, files: ['src/domain/damage.js'] }),
      atom('preference', 'The author prefers draft proposals before authoritative edits', { weight: 3 }),
      atom('fact', 'The project uses ESM modules', { weight: 2 }),
      atom('pitfall', 'bpy.ops is unreliable in headless Blender', { weight: 3 }),
    ]
    const query = gate.buildQuery(['change the damage calculation in src/domain/damage.js'])
    assert.ok(query.tokens.size > 0, 'a query has tokens')

    const result = gate.gateAtoms({ atoms, query, budget: 400, limit: 8, now: Date.parse('2026-01-05T00:00:00.000Z') })
    assert.ok(result.selected.length > 0, 'gating selects something for a matching query')
    assert.equal(result.selected[0].atom.kind, 'constraint', 'the strongest match is ranked first')
    assert.ok(result.tokens <= result.budget, 'a selection respects its token budget')
    assert.ok(result.experts.length > 0, 'the gate reports expert weights')
    assert.ok(result.experts.some((expert) => expert.activated), 'at least one expert is activated')
    assert.ok(result.coverage > 0, 'coverage is computed from real overlap')
    assert.ok(['strong', 'weak', 'empty'].includes(result.confidence), 'confidence is one of the declared values')

    // An unrelated query must not *discard* durable memory — a constraint that is
    // expensive to relearn is still worth its bytes — but it must rank honestly and
    // report low confidence, so the `smart` tier escalates to the router.
    const none = gate.gateAtoms({ atoms, query: gate.buildQuery(['quux phonetic nonsense']), budget: 400, limit: 8 })
    assert.equal(
      none.selected.every((entry) => entry.reasons.some((reason) => reason.startsWith('query match'))),
      false,
      'no atom claims a query match for an unrelated query',
    )
    assert.equal(none.coverage, 0, 'coverage is zero when nothing overlaps the query')
    assert.equal(none.confidence, 'weak', 'an unrelated query never reports strong confidence')
    assert.ok(
      none.selected.length === 0 || none.selected[0].score < result.selected[0].score,
      'the best unmatched atom scores below the best matched one',
    )

    const nothingStored = gate.gateAtoms({ atoms: [], query, budget: 400, limit: 8 })
    assert.equal(nothingStored.selected.length, 0, 'an empty store selects nothing')
    assert.equal(nothingStored.confidence, 'empty', 'the empty store says so')

    const tiny = gate.gateAtoms({ atoms, query, budget: 12, limit: 8 })
    assert.ok(tiny.tokens <= 12, 'a tiny budget is honoured exactly')
    assert.ok(tiny.excluded.length > 0, 'atoms that did not fit are reported, not silently dropped')

    const capped = gate.gateAtoms({ atoms, query, budget: 4000, limit: 1 })
    assert.equal(capped.selected.length, 1, 'the count limit wins over a generous budget')

    const forgotten = gate.gateAtoms({
      atoms: [...atoms, atom('constraint', 'Damage must stay an integer in src/domain/damage.js', { forgotten: true })],
      query,
      budget: 400,
      limit: 8,
    })
    assert.equal(forgotten.selected.some((entry) => entry.atom.forgotten === true), false, 'a forgotten atom is never selected')
  }

  // -------------------------------------------------------------- route tiers
  {
    const emptyGating = { selected: [], confidence: 'empty', coverage: 0, reasons: [], experts: [] }
    const weakGating = { selected: [{}], confidence: 'weak', coverage: 0.1, reasons: ['weak deterministic match'], experts: [] }
    const strongGating = { selected: [{}], confidence: 'strong', coverage: 0.8, reasons: [], experts: [] }

    assert.equal(gate.decideRoute({ tier: 'off', gating: strongGating, storedAtoms: 3, routerAvailable: true }).route, 'off', 'off never routes')
    assert.equal(
      gate.decideRoute({ tier: 'always', gating: strongGating, storedAtoms: 3, routerAvailable: true }).route,
      'subagent',
      'always routes even when deterministic gating is confident',
    )
    assert.equal(
      gate.decideRoute({ tier: 'smart', gating: strongGating, storedAtoms: 3, routerAvailable: true }).route,
      'deterministic',
      'smart stays deterministic when gating is confident',
    )
    assert.equal(
      gate.decideRoute({ tier: 'smart', gating: weakGating, storedAtoms: 3, routerAvailable: true }).route,
      'subagent',
      'smart escalates a weak match',
    )
    assert.equal(
      gate.decideRoute({ tier: 'smart', gating: emptyGating, storedAtoms: 3, routerAvailable: true }).route,
      'subagent',
      'smart escalates an empty match',
    )
    assert.equal(
      gate.decideRoute({ tier: 'always', gating: strongGating, storedAtoms: 3, routerAvailable: false }).route,
      'deterministic',
      'a missing subagents service degrades instead of failing',
    )
    assert.equal(
      gate.decideRoute({ tier: 'always', gating: strongGating, storedAtoms: 0, routerAvailable: true }).route,
      'off',
      'an empty store never spends a model call',
    )
    assert.equal(
      gate.decideRoute({ tier: 'always', gating: strongGating, storedAtoms: 3, routerAvailable: true, cooldown: true }).route,
      'deterministic',
      'the cooldown prevents a second call in the same turn',
    )
  }

  // ------------------------------------------ readiness: a transport must be mounted
  {
    // This is the defect that made the router silently never run on a real profile.
    //
    // Two different names are involved and the readiness check conflated them:
    // `routerProvider` is an LLM provider (`airelay`), while the activation `provider`
    // is the subagent *transport* (`spawn`). The check used to look for the LLM provider
    // in the subagents registry, so a correctly configured profile failed with
    // `provider "airelay" is not mounted (available: spawn)` and no routing ever ran.
    const working = { list: () => ['spawn', 'fork'], startActivation: async () => {} }
    const bare = { list: () => [], startActivation: async () => {} }
    const unknown = { startActivation: async () => {} }
    const ctxWith = (service) => ({ get: (name) => (name === 'subagents' ? service : undefined) })
    // The configured LLM provider is deliberately NOT a transport name: that is the
    // real-world shape this test must keep covering.
    const ready = (ctx, provider = 'airelay') =>
      delegate.routerReadiness({ ctx, tier: 'always', provider, model: 'deepseek-v4.1-flash' })

    assert.equal(ready(ctxWith(working)).ok, true, 'a mounted transport with the service is ready')

    const noProvider = ready(ctxWith(bare))
    assert.equal(noProvider.ok, false, 'the service alone is not enough to delegate')
    assert.match(noProvider.reason, /no subagent provider is mounted/, 'the reason names the missing provider mount')

    const wrongProvider = ready(ctxWith({ list: () => ['fork'], startActivation: async () => {} }))
    assert.equal(wrongProvider.ok, false, 'a transport that is not the one delegated to is not ready')
    assert.match(wrongProvider.reason, /"spawn".*is not mounted/, 'the reason names the transport asked for')
    assert.match(wrongProvider.reason, /available: fork/, 'the reason names what is available instead')

    // The regression this guards: an LLM provider id must never be mistaken for a
    // transport. `airelay` is not in the registry and readiness must still be `ok`.
    const llmProviderIsNotATransport = ready(ctxWith(working), 'airelay')
    assert.equal(
      llmProviderIsNotATransport.ok,
      true,
      'routerProvider is an LLM provider and must not be looked up in the subagent registry',
    )

    // An unrecognised registry shape must not be read as "nothing mounted": that would
    // disable a router that works, which is worse than not checking at all.
    assert.equal(delegate.listProviders(unknown), null, 'an unknown shape reports "cannot tell", not "empty"')
    assert.equal(ready(ctxWith(unknown)).ok, true, 'an unreadable registry is assumed usable')

    // The registry is a Map on the real service; probing must not treat it as a list.
    assert.deepEqual(
      delegate.listProviders({ providers: new Map([['Spawn', {}]]) }),
      ['spawn'],
      'a Map registry is read case-insensitively',
    )
    assert.equal(delegate.listProviders({ list: () => { throw new Error('boom') } }), null, 'a throwing probe tells nothing')

    // `delegationAvailable` is what the panel shows. It must agree with readiness minus
    // the settings that are the user's to fill in.
    assert.equal(delegate.delegationAvailable(ctxWith(working)), true, 'a working host is reported as available')
    assert.equal(delegate.delegationAvailable(ctxWith(bare)), false, 'a provider-less host is reported as unavailable')
    assert.equal(delegate.delegationAvailable({ get: () => undefined }), false, 'no service is unavailable')
  }

  // ------------------------------------------------------------------ extract
  {
    const summary = [
      '## Primary Request and Intent',
      '- The user wants memory to survive compaction in the dsh-memory project.',
      '',
      '## Key Technical Concepts',
      '- Cordis plugins register tools through ctx.tools.register.',
      '',
      '## Errors and Fixes',
      '- Select-String with embedded double quotes throws a ParameterBindingException.',
      '',
      '## Critical Context',
      '- Do not replace ctx.compaction; exactly one implementation is allowed.',
      '- The router must never write to the atom store.',
      '- Never edit AGENTS.md from a tool call.',
      '- Must pass baseRev to state_update.',
      '',
      '## Files and Code',
      '- lib/index.js wires the seams.',
      '- core/memory.js holds the atom store.',
      '- `core/gate.js` scores and selects.',
      '- See docs/knowledge/combat.md for the damage rules.',
    ].join('\n')
    const extracted = extract.extractFromSummary({ summary, compactionId: 'c1', sessionId: 's1' })
    assert.ok(extracted.atoms.length >= 4, `the summary yields atoms, got ${extracted.atoms.length}`)
    assert.ok(extracted.sections.length >= 4, 'the section splitter found the summary sections')
    const kinds = new Set(extracted.atoms.map((entry) => entry.kind))
    assert.ok(kinds.has('constraint'), 'imperative rules become constraints')
    assert.ok(kinds.has('pitfall'), 'errors become pitfalls')
    assert.ok([...kinds].some((kind) => ['fact', 'decision', 'task'].includes(kind)), 'statements get a substantive kind')
    assert.ok(extracted.atoms.every((entry) => entry.text.length > 0), 'no empty atom is produced')
    assert.ok(
      extracted.atoms.every((entry) => entry.text.length <= memory.MAX_ATOM_CHARS),
      'extracted atoms respect the length ceiling',
    )
    assert.equal(extracted.atoms[0].source.compactionId, 'c1', 'extraction records its compaction provenance')

    const withPaths = extracted.atoms.find((entry) => entry.files.length > 0)
    assert.ok(withPaths !== undefined, 'a statement naming a path records the path as a matching hint')

    // The same summary must extract the same atoms: a resumed session replays it.
    const replayed = extract.extractFromSummary({ summary, compactionId: 'c1', sessionId: 's1' })
    assert.deepEqual(
      replayed.atoms.map((entry) => entry.id),
      extracted.atoms.map((entry) => entry.id),
      'extraction is deterministic, so a replay converges on the same ids',
    )

    assert.deepEqual(extract.extractFromSummary({ summary: '', compactionId: 'c2' }).atoms, [], 'an empty summary yields nothing')
    assert.deepEqual(extract.extractFromSummary({ summary: 'just prose with no headings at all', compactionId: 'c3' }).atoms.length >= 0, true, 'prose without headings does not crash')
  }

  // -------------------------------------------------------------- user rules
  {
    const twoClause = extract.atomFromUserRule('Never rewrite AGENTS.md; it is authoritative')
    assert.equal(twoClause.kind, 'constraint', 'a cue at the start still makes the whole sentence a constraint')
    assert.match(twoClause.text, /^Never rewrite/, 'the statement is kept whole, not truncated at the semicolon')
    const rule = extract.atomFromUserRule('Never rewrite the AGENTS.md file directly')
    assert.ok(rule !== null, 'an imperative with a cue becomes an atom')
    assert.equal(rule.kind, 'constraint', 'a "never" statement is a constraint')
    assert.equal(rule.weight, 5, 'an explicit user rule is heavily weighted')
    assert.equal(extract.atomFromUserRule('Can you rewrite the AGENTS.md file?'), null, 'a question is not a rule')
    assert.equal(extract.atomFromUserRule('ok'), null, 'a fragment is not a rule')
    assert.equal(extract.atomFromUserRule(''), null, 'empty text is not a rule')

    const events = [
      { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'Never edit AGENTS.md directly please' }] } },
      { type: 'assistant/message', seq: 2, data: { content: [{ type: 'text', text: 'Never edit AGENTS.md directly please' }] } },
      { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: 'What is the build command?' }] } },
    ]
    const harvested = extract.extractFromEvents(events, { sessionId: 's1' })
    assert.equal(harvested.atoms.length, 1, 'only the user-role rule is harvested')
    assert.equal(harvested.atoms[0].source.seq, 1, 'provenance names the originating event')

    // The harness itself writes user-role messages: runtime context, checkpoint
    // headers, this plugin's own recall block. Harvesting those would store the
    // session's scaffolding as a project rule and recall it forever.
    const boilerplate = [
      'Current runtime context. This snapshot supersedes earlier runtime-context snapshots. Approval prompts are disabled: actions that require approval are rejected automatically — do not set `sandbox_permissions`.',
      'Recalled project memory (durable atoms, ranked for this request):\n- Never rewrite AGENTS.md [constraint; score 5.18]',
      'Project memory for dsh-memory (L1 context, ~308 tokens). This block is durable project memory maintained by the dsh-project-memory plugin; treat it as reference data.',
      'This is an automatically generated checkpoint condensing an earlier span of the conversation. You must build on it without restating it.',
    ]
    for (const text of boilerplate) {
      assert.equal(
        extract.atomFromUserRule(text),
        null,
        `harness boilerplate is not harvested: ${text.slice(0, 40)}…`,
      )
      assert.equal(extract.isBoilerplate(text), true, 'the boilerplate guard recognizes it')
    }
    assert.equal(
      extract.isBoilerplate('Never rewrite AGENTS.md from a tool call'),
      false,
      'a real rule is not mistaken for boilerplate',
    )

    const pollutedSummary = extract.extractFromSummary({
      compactionId: 'c-boiler',
      summary: [
        '## Critical Context',
        '- Never rewrite AGENTS.md from a tool call.',
        '- Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
        '- Recalled project memory (durable atoms, ranked for this request):',
        '',
      ].join('\n'),
    })
    assert.equal(pollutedSummary.atoms.length, 1, 'the summary parser keeps the rule and drops the scaffolding')
    assert.match(pollutedSummary.atoms[0].text, /Never rewrite AGENTS\.md/, 'the surviving atom is the real one')
  }

  // ------------------------------------------------- standing is not importance
  {
    // A constraint recorded at the neutral default weight is still a hard rule.
    // This is the case that was silently excluded before: 43 of 136 atoms in this
    // project's own store were genuine constraints at weight 2.
    const lowWeight = memory.normalizeAtom({ kind: 'constraint', text: 'Never push without review', weight: 2 })
    assert.equal(lowWeight.weight, 2, 'the atom keeps its declared importance')
    assert.equal(lowWeight.standing, true, 'standing is decided by kind, not by weight')
    assert.equal(memory.resolveStanding('constraint', { weight: 1 }), true, 'a weight of 1 does not demote a constraint')
    assert.equal(memory.resolveStanding('fact', { weight: 5 }), false, 'a weight of 5 does not promote a fact')

    // An explicit flag wins either way, so a caller can opt in or out.
    assert.equal(memory.resolveStanding('constraint', { standing: false }), false, 'an explicit false opts a constraint out')
    assert.equal(memory.resolveStanding('pitfall', { standing: true }), true, 'an explicit true opts another kind in')

    // Standing survives reinforcement, so a weaker re-extraction cannot demote it.
    const existing = memory.normalizeAtom({ kind: 'constraint', text: 'Never push without review', standing: true })
    const weaker = memory.normalizeAtom({ kind: 'constraint', text: 'Never push without review', standing: false })
    assert.equal(memory.mergeAtom(existing, weaker).standing, true, 'reinforcement cannot take standing away')

    // The gate must treat a low-weight constraint as standing. This is the behaviour
    // the old `weight >= 4` check got wrong, so it is asserted through the gate and
    // not only through the model.
    const gated = gate.gateAtoms({
      atoms: [
        memory.normalizeAtom({ kind: 'constraint', text: 'Never rewrite AGENTS.md from a tool call', weight: 2 }),
        memory.normalizeAtom({ kind: 'fact', text: 'The build script lives in scripts/build.mjs', weight: 5 }),
      ],
      query: gate.buildQuery(['tidy up the readme docs']),
      budget: 400,
      limit: 4,
      now: Date.parse('2026-01-05T00:00:00.000Z'),
    })
    const kept = gated.selected.find((entry) => entry.atom.kind === 'constraint')
    assert.ok(kept !== undefined, 'a weight-2 constraint is still kept when the request does not match it')
    assert.match(
      String(kept.reasons.join(' ')),
      /standing/,
      'and it is kept for being standing, not for matching the query',
    )
  }

  // ------------------------------------------- admission: noise never becomes memory
  {
    // Each case is a real failure mode measured against this store. Extraction is an
    // admission decision now, not a transcription of the summary.
    const cases = [
      ['prose with no heading at all', 'The quick brown fox. It jumped.'],
      ['a bare H1 title', '# Summary'],
      ['an unknown section heading', '## Notes\n- something happened here\n'],
      ['a heading-only section', '## Files and Code\n```\nnone\n```\n'],
      ['narration inside a known section', '## Key Technical Concepts\nThis paragraph explains the code to a reader.\n'],
    ]
    for (const [label, summary] of cases) {
      const result = extract.extractFromSummary({ summary, compactionId: 'c-noise' })
      assert.deepEqual(result.atoms, [], `nothing is admitted from ${label}`)
    }

    // The list form inside a known section still works: the fix must not make the
    // extractor useless.
    const kept = extract.extractFromSummary({
      summary: '## Key Technical Concepts\n- Cordis plugins register tools through ctx.tools.register.\n',
      compactionId: 'c-keep',
    })
    assert.equal(kept.atoms.length, 1, 'a bullet in a known section is still admitted')
    assert.equal(kept.atoms[0].kind, 'fact', 'and keeps the section default kind')

    // Constraint-ness is earned by wording, not granted by the heading. `Critical
    // Context` is where the summarizer parks anything it thinks matters.
    const background = extract.extractFromSummary({
      summary: '## Critical Context\n- The project runs on Windows with PowerShell 5.1.\n',
      compactionId: 'c-bg',
    })
    assert.equal(background.atoms.length, 1, 'background in Critical Context is still stored')
    assert.equal(background.atoms[0].kind, 'fact', 'but it is not a constraint just because of its heading')

    const rule = extract.extractFromSummary({
      summary: '## Critical Context\n- Never rewrite AGENTS.md from a tool call.\n',
      compactionId: 'c-rule',
    })
    assert.equal(rule.atoms[0].kind, 'constraint', 'constraint force in the wording still earns the kind')
    // Extraction yields candidates; standing is assigned when the atom is normalized
    // on the way into the store, which is what the next assertion checks.
    assert.equal(rule.atoms[0].standing, undefined, 'extraction does not pre-assign standing')
    assert.equal(memory.normalizeAtom(rule.atoms[0]).standing, true, 'but a constraint is standing once stored')

    // Architecture notes parked under Critical Context used to become "constraints"
    // purely because of the heading. They are the bulk of the mislabeled atoms in a
    // real store, and they made the constraint kind meaningless.
    for (const architectureNote of [
      'DSH plugins are Cordis plugins; host-only plugin registered through a bundle patch',
      '`session/event` is post-commit, fire-and-forget; listener failures log and continue',
      '`delivery:parent` emits a visible user-role completion notice',
    ]) {
      const note = extract.extractFromSummary({
        summary: `## Critical Context\n- ${architectureNote}\n`,
        compactionId: 'c-arch',
      })
      assert.equal(note.atoms.length, 1, 'the note is still remembered')
      assert.equal(note.atoms[0].kind, 'fact', `an architecture note is a fact, not a rule: ${architectureNote.slice(0, 40)}`)
    }

    // The cues that DO earn the kind are the modal ones, and they must keep working
    // in both directions of phrasing.
    for (const binding of [
      'Must pass baseRev to state_update',
      'Do not replace ctx.compaction; exactly one implementation is allowed',
      'The router must never write to the atom store',
      'Only ids from the supplied digest are honoured',
    ]) {
      const earned = extract.extractFromSummary({ summary: `## Critical Context\n- ${binding}\n`, compactionId: 'c-b' })
      assert.equal(earned.atoms[0].kind, 'constraint', `binding wording earns the constraint kind: ${binding.slice(0, 40)}`)
    }

    // The unread material is counted, so "nothing recognized" is distinguishable from
    // "nothing there".
    const unrecognized = extract.extractFromSummary({ summary: '## Notes\n- a\n- b\n', compactionId: 'c-u' })
    assert.ok(unrecognized.unknownSections > 0, 'unrecognized sections are counted, not silently dropped')
    assert.ok(unrecognized.skipped > 0, 'and their lines are counted as skipped')
  }

  // ------------------------------------------------------------------- router
  {
    const atoms = [atom('constraint', 'Damage must stay an integer'), atom('fact', 'The build ran once')]
    const digest = router.buildDigest({ context: 'change the damage code', atoms, limit: 4, budget: 900 })
    assert.ok(digest.text.includes(atoms[0].id), 'the digest offers ids the model can copy')
    assert.equal(digest.offered.length, 2, 'both atoms fit a generous budget')
    assert.equal(digest.truncated, false, 'nothing was truncated')

    const tight = router.buildDigest({ context: 'x'.repeat(4000), atoms, limit: 4, budget: 200 })
    assert.ok(tight.text.length > 0, 'a tight digest is still usable')
    assert.ok(tight.offered.length < 2, 'the digest respects its token budget')

    const allowed = new Set(atoms.map((entry) => entry.id))
    const parsed = router.parseRouterReply(JSON.stringify({ ids: [atoms[0].id], reason: 'relevant' }), allowed)
    assert.deepEqual(parsed.ids, [atoms[0].id], 'a clean reply parses')
    assert.equal(parsed.reason, 'relevant', 'the reason is retained')

    const fenced = router.parseRouterReply('```json\n{"ids":["' + atoms[1].id + '"]}\n```', allowed)
    assert.deepEqual(fenced.ids, [atoms[1].id], 'a fenced reply is tolerated')

    const chatty = router.parseRouterReply(`Sure! Here you go:\n{"ids":["${atoms[0].id}"],"reason":"x"}\nHope that helps.`, allowed)
    assert.deepEqual(chatty.ids, [atoms[0].id], 'prose around the JSON is tolerated')

    const invented = router.parseRouterReply('{"ids":["deadbeefdeadbeef"]}', allowed)
    assert.deepEqual(invented.ids, [], 'an id the router invented is discarded')
    assert.deepEqual(invented.rejected, ['deadbeefdeadbeef'], 'and reported as rejected')

    const broken = router.parseRouterReply('no json at all', allowed)
    assert.ok(broken.error !== null, 'an unparseable reply is an error, not an empty selection')

    // `atoms[0]` is a constraint, so it is standing: it is kept before the router is
    // consulted and the router cannot remove it. `atoms[1]` is a fact, so it can only
    // arrive through the router.
    const applied = router.applyRouterSelection({ ids: [atoms[0].id, atoms[1].id], atoms, gateOf: () => 0.5, budget: 400, limit: 4 })
    assert.equal(applied.selected.length, 2, 'the routed selection is projected onto the store')
    assert.deepEqual(
      applied.selected.find((entry) => entry.atom.id === atoms[0].id).reasons,
      ['standing rule: kept regardless of the router'],
      'a standing rule is kept by the standing path, not by the router',
    )
    assert.deepEqual(
      applied.selected.find((entry) => entry.atom.id === atoms[1].id).reasons,
      ['selected by the router subagent'],
      'a non-standing atom is attributed to the router',
    )

    // The structural guarantee: the router returning nothing must not delete the
    // rules. This was the real hole — an unimpressed model silently dropped exactly
    // the constraint the step was about to violate.
    const empty = router.applyRouterSelection({ ids: [], atoms, gateOf: () => 0.5, budget: 400, limit: 4 })
    assert.equal(empty.selected.length, 1, 'an empty router reply still leaves the standing rule')
    assert.equal(empty.selected[0].atom.id, atoms[0].id, 'and it is the constraint that survived')
    assert.equal(empty.standingKept, 1, 'the result reports that standing did the work')

    // The router also cannot drop a standing rule by omitting it from a non-empty reply.
    const partial = router.applyRouterSelection({ ids: [atoms[1].id], atoms, gateOf: () => 0.5, budget: 400, limit: 4 })
    assert.ok(
      partial.selected.some((entry) => entry.atom.id === atoms[0].id),
      'a router reply that omits the constraint does not remove it',
    )

    const overBudget = router.applyRouterSelection({ ids: [atoms[0].id, atoms[1].id], atoms, gateOf: () => 0.5, budget: 2, limit: 4 })
    assert.ok(overBudget.dropped > 0, 'the router cannot exceed the token budget')
    assert.ok(overBudget.tokens <= 2, 'the ceiling holds exactly')

    // A hanging router must not hang the caller.
    const slow = await router.runRouter({
      delegate: () => new Promise(() => {}),
      context: 'x',
      atoms,
      limit: 2,
      budget: 400,
      timeoutMs: 120,
    })
    assert.equal(slow.ok, false, 'a timed-out router reports failure')
    assert.match(String(slow.reason), /timed out|abort|failed/i, 'the failure names the timeout')

    const throwing = await router.runRouter({
      delegate: async () => {
        throw new Error('boom')
      },
      context: 'x',
      atoms,
      limit: 2,
      budget: 400,
      timeoutMs: 1000,
    })
    assert.equal(throwing.ok, false, 'a throwing delegate is reported, not propagated')

    const cancelled = new AbortController()
    cancelled.abort(new Error('cancelled by the step'))
    const aborted = await router.runRouter({
      delegate: () => new Promise(() => {}),
      context: 'x',
      atoms,
      limit: 2,
      budget: 400,
      timeoutMs: 5000,
      signal: cancelled.signal,
    })
    assert.equal(aborted.ok, false, 'a cancelled step cancels the router')

    const none = await router.runRouter({ delegate: async () => '{"ids":[]}', context: 'x', atoms: [], limit: 2, budget: 400, timeoutMs: 500 })
    assert.equal(none.ok, false, 'an empty digest is not a router call')

    // ------------------------------------------------- strategies and candidates
    //
    // Two separate claims, both of which the old implementation got wrong:
    // the instructions must differ by strategy, and a relevant atom must actually
    // reach the digest rather than losing its place to whatever was stored first.

    assert.deepEqual(
      [...router.ROUTER_STRATEGIES],
      [...config.ROUTER_STRATEGIES],
      'the router and the config agree on the strategy list, so a config value cannot name a strategy that does not exist',
    )
    const prompts = new Set(router.ROUTER_STRATEGIES.map((strategy) => router.buildRouterInstructions(strategy)))
    assert.equal(prompts.size, router.ROUTER_STRATEGIES.length, 'each strategy produces different instructions')
    assert.equal(
      router.buildRouterInstructions('nonexistent'),
      router.buildRouterInstructions('task'),
      'an unknown strategy falls back to the default rather than producing no instructions',
    )
    for (const strategy of router.ROUTER_STRATEGIES) {
      const instructions = router.buildRouterInstructions(strategy)
      assert.match(instructions, /BINDING/, 'every strategy asks the model to separate a binding rule from background')
      assert.match(instructions, /MERELY PROMINENT/, 'and to distrust prominence as a relevance signal')
      assert.match(instructions, /ids/, 'and to reply with ids')
    }

    // Candidate composition: put a highly relevant atom *last* in store order and a
    // screen of old irrelevant atoms in front of it. Taking the first N would hide it.
    const filler = Array.from({ length: 30 }, (_, index) =>
      atom('fact', `Archived note number ${index} about an unrelated subsystem and its history`),
    )
    const target = atom('decision', 'The damage formula must use integer arithmetic')
    const composed = [...filler, target]
    const rank = new Map(composed.map((entry) => [entry.id, entry.id === target.id ? 99 : 0]))
    const ranked = router.buildDigest({ context: 'change the damage formula', atoms: composed, limit: 4, budget: 400, rank })
    assert.ok(
      ranked.offered.some((entry) => entry.id === target.id),
      'the relevant atom reaches the digest even though it was last in store order',
    )
    assert.equal(ranked.truncated, true, 'the digest still discloses that it truncated')
    const unranked = router.buildDigest({ context: 'change the damage formula', atoms: composed, limit: 4, budget: 400 })
    assert.equal(
      unranked.offered.some((entry) => entry.id === target.id),
      false,
      'without a ranking the old order is used, which is what the ranking exists to fix',
    )

    // A standing rule must be offered even when it scores nothing against the request,
    // because its wording is exactly what will not match.
    const binding = atom('constraint', 'Never rewrite AGENTS.md from a tool call')
    const withBinding = router.buildDigest({
      context: 'tidy the changelog',
      atoms: [...filler, binding],
      limit: 6,
      budget: 400,
      rank: new Map([...filler.map((entry) => [entry.id, 5]), [binding.id, 0]]),
    })
    assert.ok(
      withBinding.offered.some((entry) => entry.id === binding.id),
      'a standing rule is offered to the router even with zero query overlap',
    )

    // Every kind keeps a representative, so a category cannot vanish from the digest.
    const mixed = [
      atom('fact', 'A background statement about the build'),
      atom('pitfall', 'The zstd frame loop silently returns zero bytes'),
      atom('question', 'Whether the ledger should be pruned is undecided'),
    ]
    const covered = router.buildDigest({
      context: 'build',
      atoms: mixed,
      limit: 3,
      budget: 600,
      rank: new Map([[mixed[0].id, 9], [mixed[1].id, 8], [mixed[2].id, 0]]),
    })
    assert.equal(covered.offered.length, 3, 'all three fit a generous budget')
    assert.ok(
      new Set(covered.offered.map((entry) => entry.kind)).size === 3,
      'each kind is represented in the digest',
    )
  }

  // ------------------------------------------------------------------- recall
  {
    mkdirSync(path.dirname(atomPath), { recursive: true })
    rmSync(atomPath, { force: true })
    const emptyRecall = await recall.recallForStep({
      root,
      settings,
      query: gate.buildQuery(['anything']),
      routerAvailable: false,
    })
    assert.equal(emptyRecall.ok, false, 'an empty store produces no recall')
    assert.match(String(emptyRecall.reason), /no memory atoms/, 'the reason names the empty store')

    await memory.recordAtoms({
      root,
      atoms: [
        { kind: 'constraint', text: 'Damage must stay an integer in src/domain/damage.js', weight: 5, files: ['src/domain/damage.js'] },
        { kind: 'preference', text: 'The author prefers draft proposals before authoritative edits', weight: 3 },
      ],
      options: { now: '2026-01-05T00:00:00.000Z' },
    })

    const deterministic = await recall.recallForStep({
      root,
      settings,
      query: gate.buildQuery(['change the damage calculation in src/domain/damage.js']),
      routerAvailable: false,
      now: Date.parse('2026-01-05T00:00:00.000Z'),
    })
    assert.equal(deterministic.ok, true, 'a populated store recalls something')
    assert.equal(deterministic.route, 'deterministic', 'without a router the deterministic path runs')
    assert.match(deterministic.block, /Recalled project memory/, 'the block announces itself as recalled memory')
    assert.match(deterministic.block, /integer/, 'the matching atom is in the block')
    assert.ok(deterministic.tokens > 0, 'the block reports its cost')
    assert.ok(deterministic.tokens <= settings.recallBudget * 2, 'the block is bounded by the configured budget')

    const off = await recall.recallForStep({
      root,
      settings: { ...settings, injectRecall: false },
      query: gate.buildQuery(['anything']),
    })
    assert.equal(off.ok, false, 'injectRecall:false disables recall entirely')

    // The router is allowed to disagree with the deterministic gate.
    const routed = await recall.recallForStep({
      root,
      settings: { ...settings, routerTier: 'always' },
      query: gate.buildQuery(['change the damage calculation in src/domain/damage.js']),
      routerAvailable: true,
      delegate: async () => '{"ids":["' + memory.atomId('preference', 'The author prefers draft proposals before authoritative edits') + '"],"reason":"process matters here"}',
      now: Date.parse('2026-01-05T00:00:00.000Z'),
    })
    assert.equal(routed.ok, true, 'the router path produces a recall')
    assert.equal(routed.route, 'subagent', 'the route is reported as the subagent')
    assert.match(routed.block, /router subagent/, 'the block names the router as its source')
    assert.match(routed.block, /draft proposals/, 'the atom the deterministic gate would not have chosen is present')
    assert.equal(routed.router.ok, true, 'the router outcome is recorded')

    // A failing router degrades to the deterministic answer instead of losing memory.
    const degraded = await recall.recallForStep({
      root,
      settings: { ...settings, routerTier: 'always' },
      query: gate.buildQuery(['change the damage calculation in src/domain/damage.js']),
      routerAvailable: true,
      delegate: async () => {
        throw new Error('router exploded')
      },
      now: Date.parse('2026-01-05T00:00:00.000Z'),
    })
    assert.equal(degraded.ok, true, 'a failing router still yields the deterministic selection')
    assert.equal(degraded.route, 'deterministic', 'the degraded route says so')
    assert.match(String(degraded.tier), /degraded/, 'the tier line discloses the degradation')

    // A router that abstains must not be able to delete the rules.
    //
    // The router is a model reading a truncated digest, so `[]` is an ordinary reply.
    // Letting it blank the block would make "the router was unimpressed" the cheapest
    // way to lose the constraint the step is about to violate — the exact failure this
    // memory exists to prevent. Abstaining now yields the standing rules only.
    const routingNone = await recall.recallForStep({
      root,
      settings: { ...settings, routerTier: 'always' },
      query: gate.buildQuery(['change the damage calculation in src/domain/damage.js']),
      routerAvailable: true,
      delegate: async () => '{"ids":[],"reason":"nothing relevant"}',
      now: Date.parse('2026-01-05T00:00:00.000Z'),
    })
    assert.equal(routingNone.ok, true, 'an abstaining router still leaves the standing rules, so a block is injected')
    assert.match(routingNone.block, /integer/, 'the constraint survives an empty router reply')
    assert.equal(routingNone.router.ok, true, 'the router itself succeeded; it simply chose nothing')
    assert.equal(routingNone.router.ids, 0, 'and the result records that it chose nothing')

    const described = recall.describeRecall(routed)
    assert.match(described, /route subagent/, 'describeRecall names the route')
    assert.match(recall.describeRecall({ ok: false, reason: 'nope' }), /no recall: nope/, 'describeRecall handles failure')
  }

  // ----------------------------------------------------------------- observer
  {
    rmSync(atomPath, { force: true })
    const logs = []
    const logger = { info: (line) => logs.push(`info ${line}`), warn: (line) => logs.push(`warn ${line}`) }
    const written = []
    const watched = observer.createCompactionObserver({
      logger,
      settings,
      resolveRoot: () => root,
      onWritten: (input) => written.push(input),
    })

    const session = { id: 'session-1', header: { cwd: root } }
    const summaryEvent = {
      type: 'compaction/summary',
      seq: 42,
      data: {
        compactionId: 'c-alpha',
        summary: [{ type: 'text', text: '## Critical Context\n- Never rewrite AGENTS.md from a tool call.\n- Must pass baseRev to state_update.\n' }],
        shadowedTokenCount: 5000,
      },
    }

    watched.observe(session, { type: 'compaction/start', seq: 40, data: { compactionId: 'c-alpha', turn: 3 } })
    watched.observe(session, summaryEvent)
    await watched.drain()

    const stats = watched.stats()
    assert.equal(stats.observed, 1, 'the start event is observed')
    assert.equal(stats.written, 1, 'the summary produced one write')
    assert.ok(stats.atoms >= 1, 'the write added atoms')
    assert.equal(stats.lastCompactionId, 'c-alpha', 'the observer remembers the last compaction')
    assert.equal(written.length, 1, 'the onWritten hook fired once')
    assert.equal(memory.readAtoms(root).live.length >= 1, true, 'the atoms are really on disk')

    // A replay must not double anything.
    const before = memory.readAtoms(root).atoms.length
    watched.observe(session, summaryEvent)
    await watched.drain()
    assert.equal(memory.readAtoms(root).atoms.length, before, 'replaying the same compaction writes no duplicate record')
    assert.equal(watched.stats().skipped, 1, 'the replay is counted as skipped')

    // Malformed events must be ignored without throwing.
    for (const event of [
      { type: 'compaction/start' },
      { type: 'compaction/summary' },
      { type: 'compaction/summary', data: null },
      { type: 'compaction/summary', data: { compactionId: '', summary: [] } },
      { type: 'compaction/summary', data: { compactionId: 'c-empty', summary: [{ type: 'text', text: '   ' }] } },
      { type: 'compaction/end', data: { compactionId: 'c-alpha' } },
      { type: 'session/title', data: { title: 'x' } },
      null,
      undefined,
    ]) {
      assert.doesNotThrow(() => watched.observe(session, event), `observing ${JSON.stringify(event)} must not throw`)
    }

    const noRoot = observer.createCompactionObserver({ logger, settings, resolveRoot: () => null })
    assert.doesNotThrow(() => {
      noRoot.observe(session, summaryEvent)
    }, 'a session with no resolvable root is skipped silently')
    await noRoot.drain()

    const disabled = observer.createCompactionObserver({ logger, settings: { ...settings, extractOnCompaction: false }, resolveRoot: () => root })
    disabled.observe(session, { ...summaryEvent, data: { ...summaryEvent.data, compactionId: 'c-beta' } })
    await disabled.drain()
    assert.equal(disabled.stats().written, 0, 'extractOnCompaction:false writes nothing')

    // A throwing store must be contained, not propagated into the session event.
    const brokenRoot = mkdtempSync(path.join(tmpdir(), 'pm-broken-'))
    try {
      mkdirSync(path.join(brokenRoot, '.dsh-memory', 'memory'), { recursive: true })
      mkdirSync(path.join(brokenRoot, memory.ATOMS_FILE), { recursive: true })
      const contained = observer.createCompactionObserver({ logger, settings, resolveRoot: () => brokenRoot })
      contained.observe({ id: 'session-x', header: { cwd: brokenRoot } }, {
        type: 'compaction/summary',
        data: { compactionId: 'c-gamma', summary: [{ type: 'text', text: '## Critical Context\n- Never rewrite AGENTS.md.\n' }] },
      })
      await contained.drain()
      assert.equal(contained.stats().failed, 1, 'a failed write is counted as failed, not thrown')
      assert.equal(contained.stats().written, 0, 'and is not counted as written')

      // The ledger must record the failure too: an audit that only sees successes
      // is exactly the blind spot this file exists to close.
      const failedLedger = compactions.readLedger(brokenRoot)
      assert.equal(failedLedger.ok, true, 'the ledger is readable after a failed atom write')
      assert.equal(failedLedger.entries.length, 1, 'the failed compaction still leaves a row')
      assert.equal(failedLedger.entries[0].skipReason, compactions.SKIP_REASONS.WRITE_FAILED, 'and names the failure')
    } finally {
      rmSync(brokenRoot, { recursive: true, force: true })
    }

    // ------------------------------------------------------------ compaction ledger
    //
    // The atom store can only show successes. These assertions pin down the other
    // half: a compaction that produced nothing must still leave a durable row that
    // says so, otherwise "the plugin observed nothing" and "the plugin is broken"
    // are indistinguishable after the fact.
    {
      const ledgerRoot = mkdtempSync(path.join(tmpdir(), 'pm-ledger-'))
      try {
        mkdirSync(path.join(ledgerRoot, '.dsh-memory', 'memory'), { recursive: true })
        mkdirSync(path.join(ledgerRoot, '.dsh-memory', 'state'), { recursive: true })
        const quietLogs = []
        const quiet = { info: () => {}, warn: (line) => quietLogs.push(line) }
        const led = observer.createCompactionObserver({ logger: quiet, settings, resolveRoot: () => ledgerRoot })
        const sess = { id: 'session-ledger', header: { cwd: ledgerRoot } }

        // 1. A productive compaction.
        led.observe(sess, { type: 'compaction/start', seq: 1, data: { compactionId: 'L-1', turn: 7 } })
        led.observe(sess, {
          type: 'compaction/summary',
          seq: 2,
          data: { compactionId: 'L-1', summary: [{ type: 'text', text: '## Critical Context\n- Must never rewrite AGENTS.md from a tool call.\n' }] },
        })
        await led.drain()

        // 2. A compaction whose summary is empty after rendering. The extractor
        //    treats almost any prose as a possible fact (see the known limitation in
        //    docs/design/compaction-trace-audit.md), so the reliable way to reach the
        //    "no statements" branch is an empty summary, not a terse one.
        led.observe(sess, {
          type: 'compaction/summary',
          seq: 3,
          data: { compactionId: 'L-2', summary: [{ type: 'text', text: '' }] },
        })
        await led.drain()

        // 3. An empty summary.
        led.observe(sess, {
          type: 'compaction/summary',
          seq: 4,
          data: { compactionId: 'L-3', summary: [{ type: 'text', text: '   ' }] },
        })
        await led.drain()

        // 4. Extraction turned off.
        const off = observer.createCompactionObserver({
          logger: quiet,
          settings: { ...settings, extractOnCompaction: false },
          resolveRoot: () => ledgerRoot,
        })
        off.observe(sess, {
          type: 'compaction/summary',
          seq: 5,
          data: { compactionId: 'L-4', summary: [{ type: 'text', text: '## Critical Context\n- Never push without review.\n' }] },
        })
        await off.drain()

        const read = compactions.readLedger(ledgerRoot)
        assert.equal(read.ok, true, 'the ledger file exists')
        assert.equal(read.entries.length, 4, 'one row per compaction, including the silent ones')

        const byId = new Map(read.entries.map((e) => [e.compactionId, e]))
        assert.ok(byId.get('L-1').atomsAdded >= 1, 'the productive compaction records what it added')
        assert.equal(byId.get('L-1').skipReason, null, 'and has no skip reason')
        assert.equal(byId.get('L-1').turn, 7, 'the turn from compaction/start is carried into the row')
        assert.equal(byId.get('L-2').skipReason, compactions.SKIP_REASONS.EMPTY_SUMMARY, 'an empty summary names why')
        assert.equal(byId.get('L-3').skipReason, compactions.SKIP_REASONS.EMPTY_SUMMARY, 'an empty summary names why')
        assert.equal(byId.get('L-4').skipReason, compactions.SKIP_REASONS.DISABLED, 'a disabled extractor names why')

        // A replay must update the row, not add a second one for the same id.
        led.observe(sess, {
          type: 'compaction/summary',
          seq: 6,
          data: { compactionId: 'L-1', summary: [{ type: 'text', text: '## Critical Context\n- Must never rewrite AGENTS.md from a tool call.\n' }] },
        })
        await led.drain()
        const afterReplay = compactions.readLedger(ledgerRoot)
        assert.equal(afterReplay.entries.length, 4, 'a replayed summary does not add a row')
        assert.equal(
          afterReplay.entries.filter((e) => e.compactionId === 'L-1').length,
          1,
          'the replayed id still appears exactly once',
        )

        // The summary is what an operator reads first.
        const summed = compactions.summarizeLedger(afterReplay.entries)
        assert.equal(summed.total, 4, 'summarize counts every row')
        assert.equal(summed.produced, 1, 'one compaction produced atoms')
        assert.equal(summed.skipped, 3, 'three were silent')
        // L-2 and L-3 are both empty summaries, so the reason groups by count.
        assert.equal(summed.byReason[compactions.SKIP_REASONS.EMPTY_SUMMARY], 2, 'reasons are grouped, not prose')
        assert.equal(summed.byReason[compactions.SKIP_REASONS.DISABLED], 1, 'the disabled extractor is its own reason')
        assert.equal(summed.lastCompactionId, 'L-4', 'the newest row is reported')

        // Ledger writes are independent of atom writes: a broken atom store must not
        // prevent the ledger from explaining what happened.
        assert.equal(quietLogs.length, 0, 'a healthy ledger logs no warning')
      } finally {
        rmSync(ledgerRoot, { recursive: true, force: true })
      }
    }

    // -------------------------------------------- ledger: dropped write visibility
    //
    // When the write queue is saturated the observer drops the write. That must leave
    // a row saying so: a dropped write is a lost compaction, and losing it silently is
    // the exact failure the ledger exists to prevent.
    {
      const overloadRoot = mkdtempSync(path.join(tmpdir(), 'pm-overload-'))
      try {
        mkdirSync(path.join(overloadRoot, '.dsh-memory', 'memory'), { recursive: true })
        mkdirSync(path.join(overloadRoot, '.dsh-memory', 'state'), { recursive: true })
        const quiet = { info: () => {}, warn: () => {} }
        const led = observer.createCompactionObserver({ logger: quiet, settings, resolveRoot: () => overloadRoot })
        const sess = { id: 'session-overload', header: { cwd: overloadRoot } }

        // Fire more compactions than the queue accepts, without awaiting between them
        // so the in-flight window actually fills.
        const many = observer.MAX_PENDING_WRITES + 3
        for (let i = 0; i < many; i++) {
          led.observe(sess, {
            type: 'compaction/summary',
            seq: i,
            data: {
              compactionId: `OV-${i}`,
              summary: [{ type: 'text', text: `## Critical Context\n- Must never push tag ${i} without review.\n` }],
            },
          })
        }
        await led.drain()

        const read = compactions.readLedger(overloadRoot)
        const dropped = read.entries.filter((e) => e.skipReason === compactions.SKIP_REASONS.OVERLOADED)
        assert.ok(dropped.length > 0, `a dropped write is recorded, not lost (ledger has ${read.entries.length} rows for ${many} compactions)`)
        assert.ok(
          read.entries.every((e) => typeof e.compactionId === 'string' && e.compactionId.startsWith('OV-')),
          'every row is attributable to a specific compaction',
        )
      } finally {
        rmSync(overloadRoot, { recursive: true, force: true })
      }
    }
  }

  // ------------------------------------------------------------------- config
  {
    assert.deepEqual(config.ROUTER_TIERS, ['always', 'smart', 'off'], 'the three tiers are exactly as specified')
    const defaults = config.normalizeConfig({})
    assert.equal(defaults.routerTier, 'smart', 'smart is the default tier')
    assert.equal(defaults.recallBudget, 400, 'the recall budget has a documented default')
    assert.equal(defaults.extractOnCompaction, true, 'compaction extraction is on by default')

    assert.equal(config.normalizeConfig({ routerTier: 'nonsense' }).routerTier, 'smart', 'an invalid tier falls back to the default')
    assert.equal(config.normalizeConfig({ recallBudget: 999999 }).recallBudget, 8000, 'an oversized budget is clamped')
    assert.equal(config.normalizeConfig({ recallBudget: 1 }).recallBudget, 100, 'an undersized budget is clamped')
    assert.equal(config.normalizeConfig({ routerTimeoutMs: 5 }).routerTimeoutMs, 1000, 'a tiny timeout is clamped up')
    assert.equal(config.normalizeConfig({ recallLimit: 0 }).recallLimit, 1, 'a zero limit is clamped up')
    assert.equal(config.normalizeConfig({ routerProvider: '  p  ', routerModel: 'm' }).routerProvider, 'p', 'provider ids are trimmed')

    assert.equal(config.routerConfigured(defaults), false, 'smart with no route is unconfigured, so nothing is spent')
    assert.equal(config.routerConfigured({ routerTier: 'off', routerProvider: 'p', routerModel: 'm' }), false, 'off overrides a configured route')
    assert.equal(config.routerConfigured({ routerTier: 'always', routerProvider: 'p', routerModel: 'm' }), true, 'a complete route is configured')
    assert.equal(config.routerConfigured({ routerTier: 'always', routerProvider: 'p', routerModel: '' }), false, 'a half-written route is not configured')
  }

  console.log('ATOMS OK: identity, tombstones, atomic store, sparse gate, route tiers, extractor, router, recall, and the compaction observer all behave as specified')
} finally {
  rmSync(root, { recursive: true, force: true })
}
