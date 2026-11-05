#!/usr/bin/env node
/**
 * Validate the plugin's tool declarations against the *real* harness schema
 * validator, then exercise every tool through the registry's own argument and
 * output checks.
 *
 * This file exists because of a concrete bug it catches: `ctx.tools.register()`
 * accepts only raw JSON Schema in the harness's enforced subset. The author-facing
 * DSL (a `required: true` inside a property, `type: 'json'`) is compiled by
 * `defineTool` and is *rejected* by `register`. A definition written in the sugar
 * therefore looks right in review and throws `JsonSchemaError` at runtime, taking
 * the whole plugin down at load time.
 *
 * The harness packages are resolved from `_research/asar-nm`, an extraction of the
 * installed Desktop payload. When they are unavailable the test prints SKIP and
 * exits 0 so `node --test` still works on a machine without a DSH install. A SKIP
 * is reported as a SKIP and never as a pass.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HARNESS_TOOLS = path.join(import.meta.dirname, '..', '_research', 'asar-nm', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')

let harness = null
try {
  harness = await import(pathToFileURL(HARNESS_TOOLS).href)
} catch (error) {
  console.log(`SKIP: harness packages unavailable (${error.code ?? error.message}); schema validation not run`)
  process.exit(0)
}
const { assertSupportedJsonSchema, validateJsonSchemaValue } = harness
for (const fn of ['assertSupportedJsonSchema', 'validateJsonSchemaValue']) {
  assert.equal(typeof harness[fn], 'function', `harness must export ${fn}`)
}

/**
 * Prove the validator actually rejects a schema outside the subset. Without this,
 * a validator that silently accepted everything would make the rest of the file
 * meaningless.
 */
{
  const sugarSchema = { type: 'object', properties: { a: { type: 'string', required: true } }, additionalProperties: true }
  assert.throws(() => assertSupportedJsonSchema(sugarSchema), /required|not a supported keyword/i, 'the author DSL must be rejected by assertSupportedJsonSchema')
  const jsonType = { type: 'json' }
  assert.throws(() => assertSupportedJsonSchema(jsonType), /type must be one of/i, "the author-only `json` type must be rejected")
}

const { normalizeConfig } = await import('../core/config.js')
const { ensureProjectFile, loadProject } = await import('../core/project.js')
const { readState, staleness } = await import('../core/state.js')
const { ensureIndex } = await import('../core/indexer.js')

// The plugin modules import `@deepseek-ai/dsh-llm` statically, so they can only
// load once `npm run link:harness` has linked the host packages. Loading them here
// — instead of at the top of the file — is what lets the SKIP above stay honest on
// a machine without a harness instead of dying in the import graph.
let pluginModules
try {
  pluginModules = {
    ...(await import('../lib/tools.js')),
    ...(await import('../lib/inject.js')),
  }
} catch (error) {
  if (error.code === 'ERR_MODULE_NOT_FOUND') {
    console.log('SKIP: plugin modules unavailable (run `npm run link:harness`); tool execution not exercised')
    process.exit(0)
  }
  throw error
}
const { buildTools, buildSnapshot } = pluginModules
if (typeof buildTools !== 'function' || typeof buildSnapshot !== 'function') {
  console.error(`tools.mjs: lib/tools.js and lib/inject.js did not export what this test needs (buildTools=${typeof buildTools}, buildSnapshot=${typeof buildSnapshot})`)
  process.exit(1)
}

const settings = normalizeConfig({})
const root = mkdtempSync(path.join(tmpdir(), 'pm-tools-'))

try {
  mkdirSync(path.join(root, 'docs', 'knowledge'), { recursive: true })
  writeFileSync(path.join(root, 'docs', 'knowledge', 'combat.md'), '---\ntitle: Combat\nstatus: current\n---\n\n# Combat\n\nDamage uses integers.\n', 'utf8')
  mkdirSync(path.join(root, '.dsh-memory'), { recursive: true })
  writeFileSync(path.join(root, '.dsh-memory', 'arch.json'), JSON.stringify({
    rules: [{ id: 'no-ui-in-domain', kind: 'forbid-import', from: ['src/domain/'], to: ['src/ui/'], reason: 'domain must not depend on presentation' }],
  }), 'utf8')
  mkdirSync(path.join(root, 'src', 'domain'), { recursive: true })
  mkdirSync(path.join(root, 'src', 'ui'), { recursive: true })
  writeFileSync(path.join(root, 'src', 'domain', 'bad.js'), "import { Button } from '../ui/button.js'\n", 'utf8')
  writeFileSync(path.join(root, 'src', 'domain', 'good.js'), "import { damage } from './damage.js'\n", 'utf8')

  const git = { kind: 'absent', branch: null, head: null, dirty: null, remote: null, toplevel: root, detached: false, reason: null }
  const ensured = ensureProjectFile({ root, git })
  assert.equal(ensured.ok, true, 'project file created')

  /** The resolver shape lib/index.js builds. */
  const resolveContext = async () => {
    const loaded = await loadProject({ configuredRoot: root })
    if (loaded.ok !== true) return { ok: false, reason: loaded.reason }
    if (loaded.initialized === false) {
      return {
        ok: true,
        root: loaded.root,
        project: null,
        git: loaded.git,
        state: { rev: 0, task: null, blockers: [], next: [], decisions: [], invariants: [], touched: [], openQuestions: [], progress: null },
        staleness: { status: 'unknown', detail: 'not initialized' },
        index: null,
      }
    }
    const state = readState(loaded.root, { projectId: loaded.project.projectId })
    if (state.ok !== true) return { ok: false, reason: state.reason }
    const indexed = ensureIndex({ root: loaded.root, settings })
    return {
      ok: true,
      root: loaded.root,
      project: loaded.project,
      git: loaded.git,
      state: state.state,
      staleness: staleness(state.state.git, loaded.git),
      index: indexed.ok === true ? indexed.index : null,
    }
  }

  const tools = buildTools({ settings, resolveContext, sessionIdOf: () => 'test-session' })
  assert.equal(tools.length, 15, `expected 15 tools, got ${tools.length}`)

  const seen = new Set()
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string', 'tool name is a string')
    assert.equal(typeof tool.description, 'string', `${tool.name}: description is a string`)
    assert.equal(typeof tool.execute, 'function', `${tool.name}: execute is a function`)
    assert.equal(typeof tool.output?.render, 'function', `${tool.name}: output.render is a function`)
    assert.equal(seen.has(tool.name), false, `${tool.name}: name is unique`)
    seen.add(tool.name)

    // The gate that matters: both roots must be raw JSON Schema in the subset.
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.parameters), `${tool.name}: parameters rejected by the harness`)
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema), `${tool.name}: output schema rejected by the harness`)
    assert.equal(tool.parameters.type, 'object', `${tool.name}: parameters are object-rooted`)
    assert.equal(tool.output.schema.type, 'object', `${tool.name}: output schema is object-rooted`)
    assert.deepEqual(tool.output.schema.required, ['ok'], `${tool.name}: output requires ok`)
  }

  /**
   * Call a tool through the same validation the registry applies.
   * @param {string} name - tool name.
   * @param {object} args - arguments.
   * @returns {Promise<any>} the canonical value.
   */
  const call = async (name, args) => {
    const tool = tools.find((entry) => entry.name === name)
    assert.ok(tool !== undefined, `${name} is registered`)
    const argViolations = validateJsonSchemaValue(tool.parameters, args, 'arguments')
    assert.deepEqual(argViolations, [], `${name}: arguments rejected: ${argViolations.join('; ')}`)
    const value = await tool.execute(args, { signal: new AbortController().signal })
    const outputViolations = validateJsonSchemaValue(tool.output.schema, value, 'value')
    assert.deepEqual(outputViolations, [], `${name}: output rejected: ${outputViolations.join('; ')}`)
    const rendered = tool.output.render(args, value)
    assert.ok(Array.isArray(rendered) && rendered.length > 0, `${name}: render must produce content`)
    for (const block of rendered) assert.equal(block.type, 'text', `${name}: rendered block must be text`)
    return value
  }

  const inspect = await call('project_inspect', {})
  assert.equal(inspect.ok, true, 'project_inspect succeeds')
  assert.equal(inspect.data.initialized, true, 'project_inspect reports initialization')

  const status = await call('memory_status', { rebuildIndex: true, journalLimit: 5 })
  assert.equal(status.ok, true, 'memory_status succeeds')
  assert.equal(typeof status.data.revision, 'number', 'memory_status reports a numeric state revision')

  const found = await call('memory_search', { query: 'combat' })
  assert.equal(found.ok, true, 'memory_search succeeds')
  assert.ok(found.data.total >= 1, 'memory_search finds the indexed document')

  const missing = await call('memory_search', { query: 'nonexistentxyzzy' })
  assert.equal(missing.data.total, 0, 'memory_search reports zero matches without failing')

  const read = await call('memory_read', { path: 'docs/knowledge/combat.md' })
  assert.equal(read.ok, true, 'memory_read succeeds')
  assert.match(read.summary, /PROJECT REFERENCE DATA/, 'memory_read frames content as untrusted data')

  const escaped = await call('memory_read', { path: '../../../etc/passwd' })
  assert.equal(escaped.ok, false, 'memory_read rejects a path escaping the project')
  assert.match(String(escaped.error), /outside|escape|absolute|invalid/i, 'the rejection explains itself')

  const stateGet = await call('state_get', {})
  const baseRev = stateGet.data.rev

  const updated = await call('state_update', { baseRev, next: [{ step: 'wire the tools', why: 'integration' }] })
  assert.equal(updated.ok, true, 'state_update succeeds')
  assert.equal(updated.data.rev, baseRev + 1, 'state_update advances the revision')

  const retried = await call('state_update', { next: [{ step: 'wire the tools', why: 'integration' }] })
  assert.equal(retried.ok, true, 'an identical retry succeeds')
  assert.equal(retried.data.rev, baseRev + 1, 'an identical retry does not advance the revision')

  const conflicted = await call('state_update', { baseRev, next: [{ step: 'different' }] })
  assert.equal(conflicted.ok, false, 'a stale baseRev is rejected')
  assert.match(String(conflicted.error), /revision conflict/, 'the conflict names itself and the stored revision')

  const empty = await call('state_update', {})
  assert.equal(empty.ok, false, 'an empty update is rejected rather than silently doing nothing')

  const handoff = await call('state_handoff', { done: 'tools wired', verifiedBy: 'test', next: [{ step: 'docs' }] })
  assert.equal(handoff.ok, true, 'state_handoff succeeds')

  const docsCheck = await call('docs_check', {})
  assert.equal(docsCheck.ok, true, 'docs_check succeeds')
  assert.ok(docsCheck.data.documents >= 1, 'docs_check counted documents')

  const preview = await call('docs_sync', { title: 'Combat spec drift', target: 'docs/knowledge/combat.md', summary: 'Damage is now float.' })
  assert.equal(preview.ok, true, 'docs_sync previews')
  assert.equal(preview.data.written, false, 'docs_sync does not write without write:true')

  const written = await call('docs_sync', { title: 'Combat spec drift', target: 'docs/knowledge/combat.md', summary: 'Damage is now float.', write: true })
  assert.equal(written.data.written, true, 'docs_sync writes with write:true')
  assert.match(written.data.path, /^docs\/proposals\//, 'docs_sync writes a proposal, not the target document')

  const arch = await call('architecture_check', {})
  assert.equal(arch.ok, true, 'architecture_check runs')
  assert.equal(arch.data.status, 'violations', 'architecture_check finds the seeded violation')
  assert.equal(arch.data.violations.length, 1, 'exactly one violating import is reported')
  assert.equal(arch.data.violations[0].rule, 'no-ui-in-domain', 'the violation names its rule')
  assert.equal(arch.data.violations[0].file, 'src/domain/bad.js', 'the violation names its file')
  assert.equal(arch.data.violations[0].line, 1, 'the violation names its line')

  // --- Memory atoms: the compaction-survival layer. ---
  const emptyRecall = await call('memory_recall', { query: 'combat damage' })
  assert.equal(emptyRecall.ok, true, 'memory_recall works with an empty store')
  assert.equal(emptyRecall.data.total, 0, 'an empty store recalls nothing')
  assert.match(String(emptyRecall.summary), /no memory atoms/, 'the empty answer explains where atoms come from')

  const remembered = await call('memory_remember', {
    atoms: [
      { text: 'Damage is an integer in the combat domain', kind: 'constraint', files: ['src/domain/damage.js'], weight: 5 },
      { text: 'Never rewrite AGENTS.md from a tool call', kind: 'constraint', weight: 5 },
      { text: 'The writer prefers draft proposals before authoritative edits', kind: 'preference', weight: 3 },
    ],
  })
  assert.equal(remembered.ok, true, 'memory_remember succeeds')
  assert.equal(remembered.data.added, 3, 'three atoms are new')
  assert.equal(remembered.data.live, 3, 'the store reports three live atoms')

  const again = await call('memory_remember', { atoms: [{ text: 'Damage is an integer in the combat domain', kind: 'constraint', files: ['src/domain/damage.js'], weight: 5 }] })
  assert.equal(again.ok, true, 'recording the same atom twice succeeds')
  assert.equal(again.data.added, 0, 'content identity prevents a duplicate')
  assert.equal(again.data.updated + again.data.unchanged, 1, 'the repeat is accounted for as reinforced or unchanged')

  const recalled = await call('memory_recall', { query: 'changing the damage calculation in src/domain/damage.js' })
  assert.equal(recalled.ok, true, 'memory_recall succeeds against a populated store')
  assert.ok(recalled.data.total >= 1, 'recall selects at least the matching atom')
  assert.ok(recalled.data.selected.some((atom) => /integer in the combat domain/.test(atom.text)), 'recall ranks the file-matching atom first')
  assert.equal(typeof recalled.data.confidence, 'string', 'recall reports an honest confidence')
  assert.ok(recalled.data.tokens <= recalled.data.budget, 'recall respects its token budget')

  const byKind = await call('memory_recall', { query: 'anything', kind: 'preference' })
  assert.equal(byKind.ok, true, 'memory_recall filters by kind')
  assert.ok(byKind.data.selected.every((atom) => atom.kind === 'preference'), 'the kind filter is honoured')

  const forgotten = await call('memory_forget', { ids: [recalled.data.selected[0].id] })
  assert.equal(forgotten.ok, true, 'memory_forget succeeds')
  assert.equal(forgotten.data.forgotten, 1, 'one atom is forgotten')

  const afterForget = await call('memory_recall', { query: 'changing the damage calculation in src/domain/damage.js' })
  assert.equal(afterForget.ok, true, 'recall still works after a forget')
  assert.equal(
    afterForget.data.selected.some((atom) => atom.text.includes(recalled.data.selected[0].text)),
    false,
    'a forgotten atom is not recalled again',
  )

  const resurrected = await call('memory_remember', { atoms: [{ text: recalled.data.selected[0].text, kind: recalled.data.selected[0].kind }] })
  assert.equal(resurrected.ok, true, 'recording a forgotten atom does not fail')
  const afterResurrect = await call('memory_recall', { query: 'changing the damage calculation in src/domain/damage.js' })
  assert.equal(
    afterResurrect.data.selected.some((atom) => atom.text.includes(recalled.data.selected[0].text)),
    false,
    'the tombstone survives a re-record, so the atom cannot be resurrected',
  )

  // An uninitialized project must be told how to start, not fail opaquely.
  const projectIdBefore = inspect.data.projectId
  rmSync(path.join(root, '.dsh-memory', 'project.json'))
  const uninitialized = await call('memory_status', {})
  assert.equal(uninitialized.ok, true, 'memory_status works on an uninitialized project')
  assert.ok(String(uninitialized.summary).includes('project_init'), 'it points at project_init')

  const reinit = await call('project_init', {})
  assert.equal(reinit.ok, true, 'project_init succeeds')
  assert.equal(reinit.data.created, true, 'project_init creates the file again')
  assert.notEqual(reinit.data.projectId, projectIdBefore, 'a recreated project gets a fresh identity rather than reusing a deleted one')

  // The context-injection path must see the same world the tools do.
  const snapshot = await buildSnapshot({ settings, cwd: root })
  assert.equal(snapshot.ok, true, 'buildSnapshot succeeds')
  assert.ok(snapshot.baseline.text.length > 0, 'the baseline has content')
  assert.equal(typeof snapshot.identity, 'string', 'the baseline identity is a string')

  console.log(`TOOLS OK: ${tools.length} tools validated against the real harness schema subset`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
