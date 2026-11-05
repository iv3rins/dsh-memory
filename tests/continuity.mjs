#!/usr/bin/env node
/**
 * The end-to-end behaviour this plugin exists for: does memory actually survive?
 *
 * Every other test checks one mechanism. This one checks the promise: a second
 * session, with a fresh process and no shared state except the project directory,
 * must be able to pick up where the first one stopped — and must be told when what it
 * remembers has gone stale relative to git.
 *
 * The two "sessions" are simulated by discarding every in-memory object between
 * phases and re-reading from disk, which is exactly what a restart does. A real git
 * repository is created so the staleness verdict is exercised against real facts
 * rather than a stub.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let libs
try {
  libs = { ...(await import('../lib/tools.js')), ...(await import('../lib/inject.js')) }
} catch (error) {
  if (error.code === 'ERR_MODULE_NOT_FOUND') {
    console.log('SKIP: plugin modules unavailable (run `npm run link:harness`); continuity not tested')
    process.exit(0)
  }
  throw error
}
const { buildTools, buildSnapshot } = libs
const { normalizeConfig } = await import('../core/config.js')
const { loadProject } = await import('../core/project.js')
const { readState, staleness } = await import('../core/state.js')
const { ensureIndex } = await import('../core/indexer.js')
const { composePayload } = await import('../lib/inject.js')

const settings = normalizeConfig({})
const root = mkdtempSync(path.join(tmpdir(), 'pm-e2e-'))

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** Rebuild the context from disk, exactly as a new session would. */
const resolveContext = async () => {
  const loaded = await loadProject({ cwd: root, timeoutMs: settings.gitTimeoutMs })
  if (!loaded.ok) return { ok: false, reason: loaded.reason }
  if (loaded.initialized === false) {
    return { ok: true, root: loaded.root, project: null, git: loaded.git, state: { rev: 0, task: null, blockers: [], next: [], decisions: [], invariants: [], touched: [], openQuestions: [], progress: null, git: {} }, staleness: { status: 'unknown', detail: 'not initialized' }, index: null }
  }
  const state = readState(loaded.root, { projectId: loaded.project.projectId })
  const indexed = ensureIndex({ root: loaded.root, settings })
  return {
    ok: true,
    root: loaded.root,
    project: loaded.project,
    git: loaded.git,
    state: state.state,
    staleness: staleness(state.state.git, loaded.git),
    index: indexed.ok ? indexed.index : null,
  }
}

const session = () => {
  const tools = buildTools({ settings, resolveContext, sessionIdOf: () => `session-${Math.random().toString(16).slice(2, 8)}` })
  const run = async (name, args = {}) => {
    const tool = tools.find((entry) => entry.name === name)
    assert.ok(tool !== undefined, `tool ${name} exists`)
    return tool.execute(args, { agent: { session: { header: { id: 'e2e', cwd: root } } } })
  }
  return { tools, run }
}

try {
  mkdirSync(path.join(root, 'docs', 'knowledge'), { recursive: true })
  writeFileSync(path.join(root, 'docs', 'knowledge', 'combat.md'), '---\ntitle: Combat\nstatus: current\n---\n\n# Combat\n\nDamage uses integer math.\n', 'utf8')
  writeFileSync(path.join(root, 'docs', 'knowledge', 'skills.md'), '---\ntitle: Skills\nstatus: current\n---\n\n# Skills\n\nCooldowns are per-skill.\n', 'utf8')

  if (hasGit) {
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('add', '-A')
    git('commit', '-qm', 'initial')
  }

  // ================= Session 1: do some work, then hand off =================
  {
    const { run } = session()

    const init = await run('project_init')
    assert.equal(init.ok, true, 'the project initializes')

    const updated = await run('state_update', {
      task: { title: 'implement damage formula', status: 'in_progress' },
      decisions: [{ text: 'integer-only damage, to keep replay deterministic', rationale: 'replay safety' }],
      next: [{ step: 'write unit tests for the formula' }],
      blockers: [{ text: 'waiting on the balance spreadsheet' }],
      invariants: ['damage math must stay deterministic'],
    })
    assert.equal(updated.ok, true, 'the state write succeeds')

    const handoff = await run('state_handoff', {
      summary: 'Damage formula is half implemented; tests are the next step.',
      next: [{ step: 'write unit tests for the formula' }],
      gotchas: ['do not introduce floats into damage'],
    })
    assert.equal(handoff.ok, true, 'the handoff note is written')
  }

  // ================= Session 2: a brand new process =================
  {
    const { run } = session()

    const status = await run('memory_status', {})
    assert.equal(status.ok, true, 'a new session can read the memory')
    assert.match(status.summary, /rev [1-9]/, 'it sees the recorded revision, not an empty state')

    const state = await run('state_get')
    assert.equal(state.data?.task?.title, 'implement damage formula', 'the task survived the restart')
    assert.equal(state.data?.task?.status, 'in_progress', 'including its status')
    assert.ok((state.data?.next ?? []).some((e) => /unit tests/.test(e.step ?? '')), 'the next step survived')
    assert.ok((state.data?.blockers ?? []).some((e) => /balance spreadsheet/.test(e.text ?? '')), 'the blocker survived')
    assert.ok((state.data?.decisions ?? []).some((e) => /deterministic|integer/i.test(e.text ?? '')), 'the decision survived')
    assert.ok((state.data?.invariants ?? []).some((e) => /deterministic/.test(String(e))), 'the invariant survived')

    // The baseline a new session receives must carry that state, not just the docs.
    const snapshot = await buildSnapshot({ settings, cwd: root })
    const baseline = composePayload({ snapshot, settings, form: 'baseline' })
    assert.notEqual(baseline, null, 'a baseline is composed for the new session')
    assert.match(baseline.content, /implement damage formula/, 'the injected baseline carries the surviving task')
    assert.match(baseline.content, /balance spreadsheet/, 'and the blocker that would otherwise be lost')

    // Knowledge search still works in a cold session — the index is a cache on disk,
    // not conversation state. The query uses the document's title because search is
    // lexical: a query that shares no token with the document legitimately misses.
    const found = await run('memory_search', { query: 'combat' })
    assert.equal(found.ok, true, 'search works in a cold session')
    assert.match(found.summary, /combat\.md/, 'the document is found by title')
    assert.equal(found.data?.indexed, 2, 'both documents were indexed without a prior in-memory pass')

    // And prove the limitation rather than hiding it: a body word the index does not
    // tokenize as a title/tag match does not find the document.
    const bodyWord = await run('memory_search', { query: 'cooldowns' })
    assert.equal(bodyWord.data?.total, 0, 'lexical search misses body-only wording, which is a known limitation')
  }

  // ================= Staleness: memory must admit when it is behind =================
  if (hasGit) {
    {
      const { run } = session()
      // Record the current HEAD as the state's git facts.
      await run('state_update', { task: { title: 'implement damage formula', status: 'in_progress' } })

      const fresh = await run('state_get')
      assert.match(String(fresh.summary), /fresh|unchanged/i, 'immediately after a write the memory is fresh')
    }

    // Someone else commits while the memory stays untouched.
    writeFileSync(path.join(root, 'docs', 'knowledge', 'combat.md'), '---\ntitle: Combat\nstatus: current\n---\n\n# Combat\n\nDamage uses float math.\n', 'utf8')
    git('add', '-A')
    git('commit', '-qm', 'change damage to float')

    {
      const { run } = session()
      const status = await run('memory_status', {})
      assert.match(String(status.summary), /advanced|stale|behind/i, 'a moved HEAD makes the memory visibly stale')
      assert.doesNotMatch(String(status.summary), /^staleness: fresh/m, 'it does not claim to be fresh')

      // The stale memory must still be readable: staleness is a warning, not a lock.
      const state = await run('state_get')
      assert.equal(state.ok, true, 'stale memory is still served, with the warning attached')
      assert.equal(state.data?.task?.title, 'implement damage formula', 'and its content is intact')
    }
  }

  console.log(`CONTINUITY OK: state, decisions, blockers, and documents survived a simulated restart${hasGit ? ', and staleness tracked a real moving HEAD' : ' (git unavailable, staleness not exercised)'}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
