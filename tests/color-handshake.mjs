#!/usr/bin/env node
/** Main Agent -> Memory Agent colour handshake, with a recording stub. No LLM calls. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../core/config.js'
import { ATOMS_FILE, normalizeAtom } from '../core/memory.js'
import { intentCategories, normalizeTaskIntent } from '../core/intent.js'
import { buildTools } from '../lib/tools.js'
import { recallForStep } from '../lib/recall.js'
import { buildQuery } from '../core/gate.js'

const root = mkdtempSync(join(tmpdir(), 'pm-color-'))
const inactiveRoot = mkdtempSync(join(tmpdir(), 'pm-color-inactive-'))
const makeAtom = (kind, text, files) => normalizeAtom({
  kind, text, files, weight: 3, confidence: 0.9,
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
}, { now: '2026-11-01T00:00:00.000Z' })
const relevant = makeAtom('decision', 'The router selects memory ids but never writes atoms.', ['lib/router.js'])
const other = makeAtom('fact', 'The unrelated website uses a dark visual theme.', ['client.js'])
mkdirSync(join(root, '.dsh-memory', 'memory'), { recursive: true })
writeFileSync(join(root, ATOMS_FILE), [relevant, other].map((atom) => JSON.stringify(atom)).join('\n') + '\n', 'utf8')

const settings = normalizeConfig({
  routerTier: 'always', routerProvider: 'stub', routerModel: 'stub',
  semanticRouting: false, lifecycleEnabled: false, metricsEnabled: false,
})
const requests = []
let reply = JSON.stringify({ hot_memory_ids: [relevant.id], cold_memory_ids: [] })
const tools = buildTools({
  settings,
  resolveContext: async () => ({ ok: true, root, project: { projectId: 'test' } }),
  resolveSettings: () => settings,
  sessionIdOf: () => 'test',
  createDelegate: (exec, actual) => {
    assert.equal(exec.agent.id, 'main-agent', 'the live main agent reaches the delegate factory')
    assert.equal(actual.routerTier, 'always')
    assert.equal(actual.semanticRouting, true, 'an explicit intent enables colour retrieval for this call')
    assert.equal(actual.lifecycleEnabled, false, 'colour retrieval never enables lifecycle cleanup')
    return async (request) => {
      requests.push(request.prompt)
      return reply
    }
  },
})
const tool = tools.find((entry) => entry.name === 'memory_intent')
const args = {
  task_summary: 'Check the memory router boundary',
  affected_modules: ['lib/router.js'],
  operation: 'review',
  memory_needs: ['architecture_decisions'],
  categories: ['mod:lib', 'dom:memory-routing'],
}
const call = () => tool.execute(args, { agent: { id: 'main-agent' }, signal: new AbortController().signal })

try {
  const intent = normalizeTaskIntent(args).intent
  assert.ok(intentCategories(intent).includes('mod:lib'), 'a file path maps to its module root')

  const first = await call()
  assert.equal(first.ok, true, first.error)
  assert.equal(first.data.route, 'subagent')
  assert.equal(first.data.router.ok, true)
  assert.deepEqual(first.data.selected.map((entry) => entry.id), [relevant.id])
  assert.equal(first.summary.includes(other.text), false, 'an unselected atom is not delivered')
  assert.match(requests[0], /REQUESTED MEMORY COLORS: mod:lib \(indigo\), dom:memory-routing \(sky\)/)
  assert.match(requests[0], /TASK INTENT:/)
  assert.match(requests[0], new RegExp(`colors=.*mod:lib`))
  assert.equal(first.data.enabled, true)
  const selectedScore = first.data.selected.length
  assert.equal(selectedScore, 1, 'the router response, not a local candidate count, determines returned atoms')

  const firstPrompt = requests[0]

  clearRequests()
  reply = JSON.stringify({ hot_memory_ids: [other.id], cold_memory_ids: [] })
  const outsideGate = await call()
  assert.deepEqual(outsideGate.data.selected.map((entry) => entry.id), [other.id], 'a valid router choice is not limited to the gate selection')
  assert.match(outsideGate.summary, /unrelated website uses a dark visual theme/, 'the final router-selected text is returned even when the gate omitted it')

  reply = JSON.stringify({ hot_memory_ids: [relevant.id], cold_memory_ids: [] })
  clearRequests()
  const second = await call()
  assert.equal(requests[0], firstPrompt, 'the same frozen store and intent produce the same router prompt')
  assert.deepEqual(second.data.selected, first.data.selected)

  clearRequests()
  reply = JSON.stringify({ hot_memory_ids: [], cold_memory_ids: [], abstained: true })
  const empty = await call()
  assert.equal(empty.data.atoms, 0)
  assert.equal(empty.data.route, 'subagent')
  assert.equal(empty.data.router.ok, true)
  assert.match(empty.summary, /selected no relevant atoms/)

  clearRequests()
  reply = JSON.stringify({ hot_memory_ids: [], cold_memory_ids: [relevant.id] })
  const cold = await call()
  assert.equal(cold.data.atoms, 0, 'a cold reference is not delivered atom text')
  assert.equal(cold.summary.includes(relevant.text), false)
  assert.match(cold.summary, /Cold references/)
  assert.match(cold.summary, new RegExp(relevant.id))

  clearRequests()
  reply = 'not JSON'
  const degraded = await call()
  assert.equal(degraded.data.route, 'deterministic')
  assert.equal(degraded.data.router.ok, false)
  assert.equal(degraded.data.enabled, true, 'a failed model call does not hide the colour plan')
  assert.ok(degraded.data.selected.length > 0, 'a failed model call keeps deterministic memory')

  const manyFacts = Array.from({ length: 4 }, (_, index) => makeAtom('fact', `Unrelated background note ${index} for the module.`, ['lib/facts.js']))
  const summaries = Array.from({ length: 2 }, (_, index) => makeAtom('summary', `Unrelated background exploration ${index} for the module.`, ['lib/summaries.js']))
  const tasks = Array.from({ length: 2 }, (_, index) => makeAtom('task', `Unrelated background task ${index} for the module.`, ['lib/tasks.js']))
  const inactiveDecision = makeAtom('decision', 'An inactive expert still contains a valid routing decision.', ['lib/inactive.js'], { standing: false })
  mkdirSync(join(inactiveRoot, '.dsh-memory', 'memory'), { recursive: true })
  writeFileSync(join(inactiveRoot, ATOMS_FILE), [...manyFacts, ...summaries, ...tasks, inactiveDecision].map((atom) => JSON.stringify(atom)).join('\n') + '\n', 'utf8')
  const outsideGateRecall = await recallForStep({
    root: inactiveRoot,
    settings: { ...settings, routerDigestBudget: 2000 },
    query: buildQuery(['unrelated background notes']),
    projectId: 'test',
    delegate: async () => JSON.stringify({ hot_memory_ids: [inactiveDecision.id], cold_memory_ids: [] }),
    routerAvailable: true,
  })
  const covered = [...outsideGateRecall.gating.selected, ...outsideGateRecall.gating.excluded]
  assert.equal(covered.some((entry) => entry.atom.id === inactiveDecision.id), false, 'fixture reaches a Router candidate outside both gate lists')
  const inactiveTools = buildTools({
    settings: { ...settings, routerDigestBudget: 2000 },
    resolveContext: async () => ({ ok: true, root: inactiveRoot, project: { projectId: 'test' } }),
    sessionIdOf: () => 'test',
    createDelegate: () => async () => JSON.stringify({ hot_memory_ids: [inactiveDecision.id], cold_memory_ids: [] }),
  })
  const inactiveResult = await inactiveTools.find((entry) => entry.name === 'memory_intent').execute({ task_summary: 'unrelated background notes' }, {})
  assert.deepEqual(inactiveResult.data.selected.map((entry) => entry.id), [inactiveDecision.id])
  assert.match(inactiveResult.summary, /inactive expert still contains a valid routing decision/)

  console.log('COLOR-HANDSHAKE OK: real memory_intent uses the shared recall/router path; colours reach the prompt; ids, empty/cold replies, deterministic prompts and degradation are enforced (stub only)')
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(inactiveRoot, { recursive: true, force: true })
}

function clearRequests() {
  requests.length = 0
}
