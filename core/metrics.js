/**
 * Observability: the counters that let someone check whether this system works.
 *
 * The rule that shapes this file: **a metric must not be able to flatter the system.**
 * "Recall@K" over remembered answers is not accuracy, "delivered" is not "used", and a
 * router that returns everything would score perfectly on hit rate while costing the most
 * tokens. So each metric below states what it can and cannot tell you, and the two
 * ratios that are easiest to misread (`recall@k` and `constraintViolationRate`) carry an
 * explicit `measurable: false` until real ground truth exists.
 *
 * Counters are append-only events in one JSON file, bounded so they cannot grow forever.
 * This is telemetry for one workspace, not a service: no clocks beyond the event's own
 * timestamp, no network, no sampling bias.
 */

import path from 'node:path'
import { readJson, writeJsonAtomic } from './store.js'
import { MEMORY_DIR } from './paths.js'

/** The metrics file. */
export const METRICS_FILE = `${MEMORY_DIR}/memory/metrics.json`

/** Schema version. */
export const METRICS_SCHEMA = 1

/** How many events to retain. Old events are dropped, which is why rates are windowed. */
export const MAX_METRIC_EVENTS = 2000

/** Event kinds. A closed set, so a typo cannot silently create a new metric. */
export const METRIC_EVENTS = Object.freeze([
  'intent',           // a task intent was accepted
  'intent_rejected',  // a task intent failed validation
  'router_call',      // the router subagent was invoked
  'router_ok',        // …and answered
  'router_fail',      // …and did not
  'cache_hit',
  'cache_miss',
  'delivery',         // atoms reached the assembled request
  'retrieval',        // atoms entered stage 1
  'used',             // a confirmation of use
  'promotion',
  'demotion',
  'violation',        // a standing constraint was reported broken
])

/** Empty state. */
function emptyState() {
  return { schema: METRICS_SCHEMA, events: [] }
}

/**
 * Read metrics.
 * @param {string} root - project root.
 * @returns {{ ok: true, state: { schema: number, events: object[] }, existed: boolean, corrupt?: string } | { ok: false, reason: string }} metrics.
 */
export function readMetrics(root) {
  const read = readJson(path.join(root, METRICS_FILE))
  if (read.ok !== true) {
    if (read.reason === 'absent') return { ok: true, state: emptyState(), existed: false }
    // `readJson` quarantines an unparsable file. Telemetry is metadata: losing it must
    // never cost a step, so a corrupt file reads as an empty event list and says so.
    if (read.reason === 'corrupt') {
      return {
        ok: true,
        state: emptyState(),
        existed: true,
        corrupt: read.quarantinedTo === undefined
          ? 'the metrics file was unparsable'
          : `the metrics file was unparsable and moved to ${read.quarantinedTo}`,
      }
    }
    return { ok: false, reason: read.reason }
  }
  const raw = read.value
  if (raw === null || typeof raw !== 'object' || !Array.isArray(/** @type {any} */ (raw).events)) {
    return { ok: true, state: emptyState(), existed: true, corrupt: 'the metrics file did not contain an event list' }
  }
  const events = []
  for (const event of /** @type {any} */ (raw).events) {
    if (event === null || typeof event !== 'object') continue
    if (!METRIC_EVENTS.includes(event.kind)) continue
    events.push(event)
  }
  return { ok: true, state: { schema: METRICS_SCHEMA, events }, existed: true }
}

/**
 * Append events, trimming the oldest.
 *
 * Never throws and never reports failure upward as an exception: a metrics write that
 * fails must not cost a step. The caller gets `{ ok: false }` and moves on.
 *
 * @param {string} root - project root.
 * @param {object[]} events - events to append; each needs a `kind`.
 * @param {{ now?: string }} [options] - clock.
 * @returns {{ ok: true, appended: number, total: number } | { ok: false, reason: string }} the outcome.
 */
export function appendMetrics(root, events, options = {}) {
  if (!Array.isArray(events) || events.length === 0) return { ok: true, appended: 0, total: 0 }
  const read = readMetrics(root)
  if (read.ok !== true) return { ok: false, reason: read.reason }
  const now = options.now ?? new Date().toISOString()
  const appended = []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (!METRIC_EVENTS.includes(event.kind)) continue
    appended.push({ ...event, at: typeof event.at === 'string' ? event.at : now })
  }
  if (appended.length === 0) return { ok: true, appended: 0, total: read.state.events.length }
  const combined = [...read.state.events, ...appended]
  const trimmed = combined.length > MAX_METRIC_EVENTS ? combined.slice(combined.length - MAX_METRIC_EVENTS) : combined
  const written = writeJsonAtomic(path.join(root, METRICS_FILE), { schema: METRICS_SCHEMA, events: trimmed })
  if (written.ok !== true) return { ok: false, reason: written.error?.message ?? String(written.error) }
  return { ok: true, appended: appended.length, total: trimmed.length }
}

/** Average of a numeric list, or null when empty. */
function mean(list) {
  if (list.length === 0) return null
  return Math.round((list.reduce((sum, value) => sum + value, 0) / list.length) * 100) / 100
}

/**
 * Summarize the metrics the brief asks for.
 *
 * Every field is derived from events, and every field that cannot be honestly computed is
 * `null` with a reason in `notes`. Returning a plausible number where none exists is the
 * failure mode this shape prevents.
 *
 * @param {{ events: object[] }} state - metrics state.
 * @param {{ window?: number }} [options] - how many recent events to consider.
 * @returns {object} the metric bundle.
 */
export function summarizeMetrics(state, options = {}) {
  const all = Array.isArray(state?.events) ? state.events : []
  const window = Number.isFinite(options.window) ? Math.max(1, options.window) : all.length
  const events = all.slice(Math.max(0, all.length - window))
  const of = (kind) => events.filter((event) => event.kind === kind)

  const intents = of('intent').length
  const intentRejected = of('intent_rejected').length
  const routerCalls = of('router_call').length
  const routerOk = of('router_ok').length
  const routerFail = of('router_fail').length
  const cacheHits = of('cache_hit').length
  const cacheMisses = of('cache_miss').length
  const latencies = of('router_ok').map((event) => Number(event.latencyMs)).filter((value) => Number.isFinite(value))
  const latenciesAll = [...of('router_ok'), ...of('router_fail')]
    .map((event) => Number(event.latencyMs))
    .filter((value) => Number.isFinite(value))
  const deliveredTokens = of('delivery').map((event) => Number(event.tokens)).filter((value) => Number.isFinite(value))
  const deliveredAtoms = of('delivery').map((event) => Number(event.atoms)).filter((value) => Number.isFinite(value))
  const retrievedAtoms = of('retrieval').map((event) => Number(event.atoms)).filter((value) => Number.isFinite(value))
  const used = of('used').map((event) => Number(event.atoms)).filter((value) => Number.isFinite(value))
  const categoryHits = of('retrieval').map((event) => Number(event.categoryHits)).filter((value) => Number.isFinite(value))
  const categoryOffered = of('retrieval').map((event) => Number(event.candidates)).filter((value) => Number.isFinite(value))
  const violations = of('violation').length
  const deliveries = of('delivery').length

  const totalRecallable = categoryOffered.reduce((sum, value) => sum + value, 0)
  const totalCategoryHits = categoryHits.reduce((sum, value) => sum + value, 0)
  const totalUsed = used.reduce((sum, value) => sum + value, 0)
  const totalDelivered = deliveredAtoms.reduce((sum, value) => sum + value, 0)

  const notes = []
  notes.push('recallAtK is null: no ground-truth relevance labels exist for this store, so any number would be invented.')
  notes.push('constraintViolationRate is null: violations are only known when a caller reports one via memory_report_violation.')
  notes.push('delivered/used are different populations: a high delivered-per-retrieval ratio is a cost problem, not a quality result.')

  return {
    window: { events: events.length, of: all.length },
    taskIntents: intents,
    taskIntentRejections: intentRejected,
    routerCalls,
    routerSuccessRate: routerCalls === 0 ? null : Math.round((routerOk / routerCalls) * 100) / 100,
    routerFailures: routerFail,
    routerLatencyMsMean: mean(latenciesAll),
    routerLatencyMsP50: (() => {
      if (latenciesAll.length === 0) return null
      const sorted = [...latenciesAll].sort((left, right) => left - right)
      return sorted[Math.floor(sorted.length / 2)]
    })(),
    routerLatencyMsSuccessfulMean: mean(latencies),
    categoryHitRate: totalRecallable === 0 ? null : Math.round((totalCategoryHits / totalRecallable) * 100) / 100,
    cacheHitRate: cacheHits + cacheMisses === 0 ? null : Math.round((cacheHits / (cacheHits + cacheMisses)) * 100) / 100,
    retrievals: of('retrieval').length,
    retrievalsAtomsMean: mean(retrievedAtoms),
    deliveries,
    deliveredAtomsMean: mean(deliveredAtoms),
    deliveredTokensMean: mean(deliveredTokens),
    deliveredTokensTotal: deliveredTokens.reduce((sum, value) => sum + value, 0),
    confirmedUsedTotal: totalUsed,
    /** Delivered-but-never-confirmed is the honest measure of waste. */
    deliveredWithoutUseRate: totalDelivered === 0 ? null : Math.round(((totalDelivered - totalUsed) / totalDelivered) * 100) / 100,
    promotions: of('promotion').length,
    demotions: of('demotion').length,
    violations,
    recallAtK: null,
    constraintViolationRate: null,
    measurable: { recallAtK: false, constraintViolationRate: false },
    notes,
  }
}

/**
 * Render a human-readable metrics report.
 * @param {object} summary - from `summarizeMetrics`.
 * @returns {string} a multi-line report.
 */
export function renderMetrics(summary) {
  const line = (label, value) => `${label}: ${value === null ? 'not measurable' : value}`
  return [
    '=== memory metrics ===',
    line('task intents', summary.taskIntents),
    line('intent rejections', summary.taskIntentRejections),
    line('router calls', summary.routerCalls),
    line('router success rate', summary.routerSuccessRate),
    line('router latency mean (ms)', summary.routerLatencyMsMean),
    line('router latency p50 (ms)', summary.routerLatencyMsP50),
    line('category hit rate', summary.categoryHitRate),
    line('cache hit rate', summary.cacheHitRate),
    line('retrievals', summary.retrievals),
    line('deliveries', summary.deliveries),
    line('delivered atoms mean', summary.deliveredAtomsMean),
    line('delivered tokens mean', summary.deliveredTokensMean),
    line('confirmed used total', summary.confirmedUsedTotal),
    line('delivered without use rate', summary.deliveredWithoutUseRate),
    line('promotions / demotions', `${summary.promotions} / ${summary.demotions}`),
    line('recall@k', summary.recallAtK),
    line('constraint violation rate', summary.constraintViolationRate),
    '',
    ...summary.notes.map((note) => `note: ${note}`),
  ].join('\n')
}
