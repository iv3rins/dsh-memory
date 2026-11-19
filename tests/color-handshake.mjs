#!/usr/bin/env node
/** Verify that only the execution model's approval delivers a routed memory. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from '../core/config.js'
import { forgetAtoms, normalizeAtom, recordAtoms } from '../core/memory.js'
import { buildTools } from '../lib/tools.js'

const root = mkdtempSync(join(tmpdir(), 'pm-review-'))
const wrong = normalizeAtom({ kind: 'fact', text: 'Cache landing page uses the violet theme.', files: ['ui/cache.js'] })
const wrongAgain = normalizeAtom({ kind: 'fact', text: 'Cache export is bundled with the legacy dashboard.', files: ['ui/export.js'] })
const right = normalizeAtom({ kind: 'decision', text: 'Transaction invalidation only follows a successful commit.', files: ['core/transactions.js'] })
const standing = normalizeAtom({ kind: 'constraint', text: 'Never erase backups from the workspace.', weight: 5 })
const args = { task_summary: 'Review the cache', affected_modules: ['ui/cache.js'] }
const requests = []
let reply
const agent = {}
const tools = buildTools({
  settings: normalizeConfig({ routerTier: 'always', routerProvider: 'fixture', routerModel: 'test' }),
  resolveContext: async () => ({ ok: true, root, project: { projectId: 'review' } }),
  createDelegate: () => async ({ prompt }) => {
    requests.push(prompt)
    return JSON.stringify(reply)
  },
})
const tool = tools.find((tool) => tool.name === 'memory_intent')
const call = (input, owner = agent) => tool.execute(input, { agent: owner })
const select = (...ids) => { reply = { action: 'accept', hot_memory_ids: ids } }

try {
  assert.equal((await recordAtoms({ root, atoms: [wrong, wrongAgain, right, standing] })).ok, true)
  select(wrong.id)
  const first = await call(args)
  assert.equal(first.data?.status, 'proposal', first.error ?? first.summary)
  assert.match(requests[0], /cluster=cluster-/)
  assert.deepEqual(first.data.offered, [{ id: wrong.id, cluster_id: first.data.offered[0].cluster_id, kind: 'fact', files: ['ui/cache.js'] }])
  assert.ok(!JSON.stringify(first).includes(wrong.text))

  select(wrongAgain.id)
  const second = await call({ proposal_id: first.data.proposal_id, feedback: 'The dashboard export path may be relevant.' })
  assert.equal(second.data?.status, 'proposal', second.error ?? second.summary)
  assert.ok(!requests.at(-1).includes(wrong.id + ' [fact]'))
  assert.ok(!JSON.stringify(second).includes(wrongAgain.text))

  select(right.id)
  const third = await call({ proposal_id: second.data.proposal_id, feedback: 'The current implementation uses transaction invalidation after commit in core/transactions.js.' })
  assert.equal(third.data?.status, 'proposal', third.error ?? third.summary)
  assert.ok(!requests.at(-1).includes(wrong.id + ' [fact]'))
  assert.ok(!requests.at(-1).includes(wrongAgain.id + ' [fact]'))
  assert.ok(!JSON.stringify(third).includes(right.text))

  const approval = { proposal_id: third.data.proposal_id, accept_memory_ids: [right.id] }
  assert.equal((await call(approval, {})).ok, false, 'another agent cannot approve this proposal')
  assert.equal((await call({ ...approval, accept_memory_ids: [standing.id] })).ok, false, 'approval cannot load an unoffered ID')
  const delivered = await call(approval)
  assert.equal(delivered.data.status, 'delivered')
  assert.deepEqual(delivered.data.selected.map(({ id }) => id), [right.id])
  assert.ok(delivered.summary.includes(right.text))
  assert.ok(!delivered.summary.includes(standing.text))
  assert.equal((await call(approval)).ok, false, 'approval is single use')

  select(wrong.id)
  const declined = await call(args)
  const rejected = await call({ proposal_id: declined.data.proposal_id, accept_memory_ids: [] })
  assert.equal(rejected.data.status, 'rejected')
  assert.ok(!JSON.stringify(rejected).includes(wrong.text))
  assert.equal((await call({ proposal_id: declined.data.proposal_id, accept_memory_ids: [wrong.id] })).ok, false)

  reply = { action: 'none' }
  const empty = await call(args)
  assert.equal(empty.data.status, 'none')
  assert.equal(empty.data.router.ok, true)
  assert.ok(!JSON.stringify(empty).includes(standing.text))

  select('unoffered-id')
  const invalid = await call(args)
  assert.equal(invalid.data.status, 'none')
  assert.equal(invalid.data.router.ok, false)
  assert.ok(!JSON.stringify(invalid).includes(standing.text))

  select(wrong.id)
  const stale = await call(args)
  assert.equal((await forgetAtoms({ root, ids: [wrong.id] })).ok, true)
  const unavailable = await call({ proposal_id: stale.data.proposal_id, accept_memory_ids: [wrong.id] })
  assert.equal(unavailable.data.status, 'none', 'approval rechecks the live store')
  assert.ok(!JSON.stringify(unavailable).includes(wrong.text))

  console.log('MEMORY REVIEW OK: two refinements, scoped approval, explicit rejection, abstention, and forgotten offers')
} finally {
  rmSync(root, { recursive: true, force: true })
}
