import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { clusterCandidates } from '../../core/clusters.js'
import { ATOMS_FILE, forgetAtoms, normalizeAtom, readAtoms, recordAtoms } from '../../core/memory.js'
import { describeProject } from '../../core/projects.js'

test('legacy memory migrates atomically with stable topic memberships and sticky tombstones', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-memory-clusters-'))
  try {
    const payment = normalizeAtom({
      kind: 'decision', text: '支付回调先验签', files: ['src/payment/webhook.ts'], seen: 5,
      category_id: ['mod:docs'], source: { sessionId: 'old-session', compactionId: 'old-compaction', seq: 8 },
    })
    const forgotten = normalizeAtom({ kind: 'fact', text: 'Expired settlement protocol', forgotten: true })
    // The same legacy category never forces unrelated atoms into one cluster.
    const dashboard = normalizeAtom({
      kind: 'fact', text: 'Dashboard trend legends render sparklines', files: ['src/widgets/chart.ts'], category_id: ['mod:docs'],
    })
    const atomPath = path.join(root, ATOMS_FILE)
    mkdirSync(path.dirname(atomPath), { recursive: true })
    const legacy = `${[payment, forgotten, dashboard].map((atom) => JSON.stringify(atom)).join('\n')}\n`
    writeFileSync(atomPath, legacy)

    const before = readAtoms(root)
    const paymentCluster = before.clusterIds.get(payment.id)
    const dashboardCluster = before.clusterIds.get(dashboard.id)
    assert.notEqual(paymentCluster, dashboardCluster)
    assert.equal(readFileSync(atomPath, 'utf8'), legacy, 'readers leave legacy files untouched')

    const retry = normalizeAtom({ kind: 'pitfall', text: '重复的支付回调需要幂等处理', files: ['src/payment/webhook.ts'] })
    const cache = normalizeAtom({ kind: 'fact', text: 'LRU eviction respects tenant quotas', files: ['src/cache/lru.ts'] })
    const writes = await Promise.all([
      recordAtoms({ root, atoms: [retry, forgotten] }),
      recordAtoms({ root, atoms: [cache] }),
    ])
    assert.ok(writes.every((result) => result.ok))
    const after = readAtoms(root)
    assert.deepEqual(after.atoms.find((atom) => atom.id === payment.id), payment)
    assert.equal(after.clusterIds.get(retry.id), paymentCluster, 'new observations join a topic across categories and kinds')
    assert.notEqual(after.clusterIds.get(cache.id), paymentCluster, 'source-root and extension matches do not group unrelated atoms')
    assert.equal(after.clusterIds.get(dashboard.id), dashboardCluster)
    assert.equal(after.live.length, 4, 'concurrent writers preserve all live atoms and a re-observed tombstone stays forgotten')
    assert.equal(describeProject(root).atoms, after.live.length, 'project picker counts atoms inside cluster records')

    const rows = readFileSync(atomPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const grouped = rows.find((row) => row.id === paymentCluster)
    assert.equal(grouped.type, 'cluster')
    assert.deepEqual(grouped.atoms.map((atom) => atom.id), [payment.id, retry.id])
    assert.equal(rows.find((row) => row.id === forgotten.id).forgotten, true)

    assert.equal((await forgetAtoms({ root, ids: [payment.id] })).forgotten, 1)
    const remaining = readAtoms(root)
    assert.equal(remaining.clusterIds.get(retry.id), paymentCluster, 'a cluster keeps its ID when its founding atom is forgotten')
    assert.equal(remaining.clusterIds.has(payment.id), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cluster lookup reaches neighboring memory and narrows by current project evidence', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-memory-cluster-lookup-'))
  try {
    const settlement = normalizeAtom({ kind: 'decision', text: '付款回调事件落盘后确认', tags: ['payments'] })
    const replay = normalizeAtom({ kind: 'pitfall', text: '重复付款回调使用幂等键', tags: ['payments'] })
    const dashboard = normalizeAtom({ kind: 'fact', text: 'Dashboard trend legends render sparklines' })
    const rule = normalizeAtom({ kind: 'constraint', text: 'Keep customer names out of log entries' })
    assert.equal((await recordAtoms({ root, atoms: [settlement, replay, dashboard, rule] })).ok, true)
    const { clusters, clusterIds, live } = readAtoms(root)
    const first = clusterCandidates({ clusters, query: { text: '排查幂等键' }, limit: 5 })
    assert.deepEqual(first.atoms.map((atom) => atom.id), [replay.id, settlement.id], 'direct evidence precedes related memory inside the cluster')
    assert.equal(first.clusterIds.get(replay.id), first.clusterIds.get(settlement.id))
    const bounded = clusterCandidates({ clusters, query: '排查幂等键', limit: 1 })
    assert.deepEqual(bounded.atoms.map((atom) => atom.id), [replay.id], 'a sibling with the exact evidence survives a one-atom shortlist')
    const refined = clusterCandidates({ clusters, query: 'Dashboard sparklines', atoms: live.filter((atom) => atom.id !== replay.id) })
    assert.deepEqual(refined.atoms.map((atom) => atom.id), [dashboard.id])
    const rejectedOnlyMatch = clusterCandidates({ clusters, query: '幂等键', atoms: [settlement] })
    assert.deepEqual(rejectedOnlyMatch.atoms, [], 'excluded memory cannot keep a topic relevant on its own')
    assert.deepEqual(clusterCandidates({ clusters, query: '幂等键', excludeClusterIds: new Set([clusterIds.get(replay.id)]) }).atoms, [])
    assert.deepEqual(clusterCandidates({ clusters, query: 'unrelated invoice' }).atoms, [])
    const withStanding = clusterCandidates({ clusters, query: '排查幂等键', limit: 1, includeStanding: true })
    assert.deepEqual(withStanding.atoms.map((atom) => atom.id), [replay.id, rule.id])
    assert.equal(withStanding.clusterIds.get(rule.id), clusterIds.get(rule.id))
    const withoutStanding = clusterCandidates({ clusters, query: 'unrelated invoice', atoms: [replay], includeStanding: true })
    assert.deepEqual(withoutStanding.atoms, [], 'standing rules are still subject to the caller’s eligibility filter')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
