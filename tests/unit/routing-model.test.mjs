import assert from 'node:assert/strict'
import { test } from 'node:test'

import { estimateTokens } from '../../core/context.js'
import { createRouterDelegate, isRoutingModelAgent } from '../../lib/delegate.js'
import { applyRouterSelection, runRouter } from '../../lib/router.js'

const rule = { id: 'standing', kind: 'constraint', standing: true, text: 'Keep the original deployment target.' }
const decision = { id: 'decision', kind: 'decision', text: 'Use the workspace lock to reconcile deployment saves.' }
const request = {
  strict: true,
  context: `Original deployment task ${'background '.repeat(100)} Refined workspace lock evidence`,
  atoms: [decision, rule],
  limit: 1,
  budget: 200,
  timeoutMs: 1000,
  clusterIds: new Map([[rule.id, 'deploy'], [decision.id, 'deploy']]),
}

test('routing model proposes only an offered memory ID from the coarse digest', async () => {
  let prompt
  const routed = await runRouter({
    ...request,
    delegate: async (input) => {
      prompt = input.prompt
      return '{"action":"accept","hot_memory_ids":["decision"],"reason":"do not deliver raw model text"}'
    },
  })
  assert.match(prompt, /Original deployment task/)
  assert.match(prompt, /Refined workspace lock evidence/)
  assert.match(prompt, /decision .*cluster=deploy/)
  assert.ok(estimateTokens(prompt) <= request.budget)
  assert.equal(routed.ok, true, routed.reason)
  assert.deepEqual(routed.ids, ['decision'])
  assert.equal(routed.reason, null)
  const applied = applyRouterSelection({ ...request, ids: routed.ids, keepStanding: false })
  assert.deepEqual(applied.selected.map((entry) => entry.atom.id), ['decision'])
})

test('routing model abstention produces no proposal, including with a standing rule present', async () => {
  for (const reply of ['{"action":"none"}', '{"hot_memory_ids":[]}', '{"abstained":true,"ids":["standing"]}']) {
    const routed = await runRouter({ ...request, delegate: async () => reply })
    assert.equal(routed.ok, true)
    assert.equal(routed.empty, true)
    assert.deepEqual(routed.ids, [])
  }
})

test('routing model rejects invalid replies and any unoffered ID', async () => {
  for (const reply of [
    '{}',
    'Incomplete {"ids":["decision"]}',
    '{"ids":["decision","unknown"]}',
    '{"ids":["decision"],"max_memory_tokens":9999}',
  ]) {
    const routed = await runRouter({ ...request, delegate: async () => reply })
    assert.equal(routed.ok, false)
  }
})

test('an interrupted host activation cannot propose a partially returned selection', async () => {
  let disposed = false
  let childAgent
  const delegate = createRouterDelegate({
    ctx: {
      subagents: {
        startActivation: async ({ childId }) => {
          childAgent = { session: { header: { id: childId } } }
          assert.equal(isRoutingModelAgent(childAgent), true)
          return {
            result: Promise.resolve({ stopReason: 'cancelled', output: [{ type: 'text', text: '{"ids":["decision"]}' }] }),
            dispose: async () => { disposed = true },
          }
        },
      },
    },
    settings: { routerTier: 'always', routerProvider: 'fixture', routerModel: 'fixture' },
    logger: { info() {}, warn() {} },
    agent: {},
  })
  const routed = await runRouter({ ...request, delegate })
  assert.equal(routed.ok, false)
  assert.equal(disposed, true)
  assert.equal(isRoutingModelAgent(childAgent), false)
})
