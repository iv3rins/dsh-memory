/**
 * Live diagnosis of the delivery chain, using the real store on disk.
 *
 * Not a test: it prints what each node actually returns, so a break can be named
 * instead of guessed. Run: node scripts/diag-delivery.mjs
 */

import { readOverrides } from '../core/projects.js'
import { DEFAULTS, normalizeConfig } from '../core/config.js'
import { readAtoms } from '../core/memory.js'
import { gateAtoms, buildQuery, decideRoute } from '../core/gate.js'
import { listProviders, routerReadiness } from '../lib/delegate.js'
import { recallForStep } from '../lib/recall.js'

const root = 'D:/iverins_workspace/dsh-memory'
const line = (label, value) => console.log(`${label.padEnd(34)} ${value}`)

console.log('=== 1. settings ===')
const overrides = readOverrides(root)
line('project override file', JSON.stringify(overrides))
const settings = normalizeConfig({ ...DEFAULTS, ...(overrides.values ?? {}) })
line('routerTier', settings.routerTier)
line('routerProvider', JSON.stringify(settings.routerProvider))
line('routerModel', JSON.stringify(settings.routerModel))
line('injectRecall', settings.injectRecall)
line('recallBudget / recallLimit', `${settings.recallBudget} / ${settings.recallLimit}`)
line('routerDigestBudget', settings.routerDigestBudget)

console.log('\n=== 2. store ===')
const store = readAtoms(root)
line('store ok', store.ok)
line('live atoms', store.ok ? store.live.length : store.reason)
line('standing atoms', store.ok ? store.live.filter((a) => a.standing === true).length : '-')

console.log('\n=== 3. gate (deterministic) ===')
const query = buildQuery([
  '主模型没有收到记忆，副模型是否真的被调用了？',
  'fix the memory delivery chain: hot memory must reach the request',
  'lib/index.js lib/recall.js lib/router.js',
])
const gating = gateAtoms({
  atoms: store.live,
  query,
  budget: settings.recallBudget,
  limit: settings.recallLimit,
})
line('gating confidence', gating.confidence)
line('gating selected', gating.selected.length)
line('gating tokens', gating.tokens)

const decision = decideRoute({
  tier: settings.routerTier,
  gating,
  storedAtoms: store.live.length,
  routerAvailable: true,
})
line('decideRoute.route', decision.route)
line('decideRoute.reason', decision.reason)

console.log('\n=== 4. subagents registry (the可疑断点) ===')
const fakeService = {
  list: () => [{ name: 'spawn' }],
  startActivation: async () => ({}),
}
line('providers mounted', JSON.stringify(listProviders(fakeService)))
line('routerReadiness(provider=airelay)', JSON.stringify(routerReadiness({
  ctx: { get: () => fakeService },
  tier: settings.routerTier,
  provider: settings.routerProvider,
  model: settings.routerModel,
})))

console.log('\n=== 5. recallForStep with a REAL-looking delegate ===')
let delegateCalls = 0
const recall = await recallForStep({
  root,
  settings,
  query,
  delegate: async (request) => {
    delegateCalls += 1
    line('  delegate called, prompt chars', request.prompt.length)
    // Answer with the first ids the digest offered, as a competent router would.
    const ids = [...request.prompt.matchAll(/^(mem_[a-f0-9]+|\S{6,})\s+\[/gm)].slice(0, 3).map((m) => m[1])
    return JSON.stringify({ ids, reason: 'diagnostic selection' })
  },
  routerAvailable: true,
})
line('delegate call count', delegateCalls)
line('recall.ok', recall.ok)
line('recall.route', recall.ok ? recall.route : recall.reason)
line('recall.atoms', recall.ok ? recall.atoms : '-')
line('recall.router', recall.ok ? JSON.stringify(recall.router) : '-')
if (recall.ok === true) {
  console.log('\n--- injected block (first 700 chars) ---')
  console.log(recall.block.slice(0, 700))
}
