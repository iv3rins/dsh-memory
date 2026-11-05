/**
 * The panel's data and configuration endpoints.
 *
 * A static Client bundle cannot read Host services, so the panel needs an HTTP
 * surface. This module owns it, and deliberately owns nothing else:
 *
 * - it **reads** the same files the tools read (`atoms.jsonl`, the compaction
 *   ledger) through the same functions, so the panel cannot drift from
 *   `/memory-status`;
 * - it **writes** configuration through the Host's own `configEditor`, which
 *   applies the change through the normal Loader path, instead of editing
 *   `cordis.yml` by hand. A hand edit would look correct and then be ignored until
 *   a restart, which is the worst of both.
 *
 * Two things are deliberately absent:
 *
 * - **No atom mutation.** Memory is written by compaction and by tools that record
 *   provenance and honour tombstones. A panel button that deleted an atom would
 *   bypass both, so removal stays `memory_forget`.
 * - **No binding beyond loopback.** These endpoints reveal project memory and can
 *   change plugin settings, so `isLoopback` gates every request rather than relying
 *   on the route registry's defaults.
 *
 * @module @dsh-external/dsh-project-memory/panel
 */

import { ATOMS_FILE, MAX_LIVE_ATOMS, atomStats, readAtoms } from '../core/memory.js'
import { readLedger, summarizeLedger, COMPACTIONS_FILE } from '../core/compactions.js'
import { ROUTER_TIERS, ROUTER_STRATEGIES } from '../core/config.js'
import { OVERRIDABLE, effectiveSettings, projectKey, writeOverride } from '../core/projects.js'
import { countTiers, readLifecycle, countersFor } from '../core/lifecycle.js'
import { categoryCounts } from '../core/retrieval.js'
import { resolveCategories } from '../core/category.js'
import { catalog, metricsReport } from './semantic.js'

/** Route that serves panel state. */
export const STATUS_PATH = '/project-memory/status'

/** Route that reads and writes settings. */
export const CONFIG_PATH = '/project-memory/config'

/** Settings the panel may change, with the values each accepts. */
export const EDITABLE_SETTINGS = Object.freeze({
  routerTier: ROUTER_TIERS,
  routerStrategy: ROUTER_STRATEGIES,
})

/** Settings the panel may change but whose value is free-form. */
export const EDITABLE_TEXT_SETTINGS = Object.freeze(['routerProvider', 'routerModel'])

/**
 * How many compaction records the panel shows as a timeline.
 *
 * The summary counts every compaction in the ledger; this bounds only the list, because
 * the panel's job is to answer "did the last few compactions write memory", not to be a
 * full audit browser. Reading 12 lines is also what keeps the endpoint cheap enough to
 * call on every panel open.
 */
export const RECENT_COMPACTIONS = 12

/**
 * Decide whether a request came from this machine.
 *
 * The panel is a local convenience, not a service. Binding these routes to
 * loopback is the difference between "the user can tune memory" and "anything that
 * can reach the port can read project memory and change how it routes".
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} whether the peer is local.
 */
export function isLoopback(req) {
  const address = req?.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Write a JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 * @returns {void}
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // The payload reflects a local file that changes on every compaction; a cached
    // response would show the user stale counts while the store moved on.
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Turn anything that was thrown into a message and a stack, without throwing.
 *
 * `String(error)` and `error.message` both look safe and are not: an object with a
 * throwing `toString` or a getter that raises makes the reporter fail with the very
 * error it was trying to report. That is how this handler once answered HTTP 500
 * with an empty body.
 *
 * @param {unknown} error - whatever was caught.
 * @returns {{ message: string, stack: string }} a description that always exists.
 */
function describeError(error) {
  const message = (() => {
    try {
      if (error !== null && typeof error === 'object' && 'message' in error) {
        const value = /** @type {any} */ (error).message
        if (typeof value === 'string' && value !== '') return value
      }
      return String(error)
    } catch {
      return 'unknown error (it could not be described)'
    }
  })()
  const stack = (() => {
    try {
      const value = /** @type {any} */ (error)?.stack
      if (typeof value === 'string' && value !== '') {
        // Only this plugin's own frames: the point is to locate the fault, and the
        // host's internals are neither actionable nor this project's business.
        return value.split('\n').filter((line) => line.includes('dsh-project-memory') || line.includes('/lib/') || line.includes('\\lib\\')).slice(0, 8).join('\n')
      }
      return ''
    } catch {
      return ''
    }
  })()
  return { message, stack }
}

/**
 * Project one ledger row into the shape the panel renders.
 *
 * The panel shows a timeline of compactions, so each row has to carry its own verdict:
 * how many atoms it wrote and, when it wrote none, why. The reason is passed through
 * verbatim rather than translated here — `SKIP_REASONS` is a closed set owned by
 * `core/compactions.js`, and the panel dictionary is the right place to turn a member
 * into prose. An unknown reason is forwarded as-is so a newer writer cannot silently
 * produce a blank row.
 *
 * @param {any} entry - one ledger line.
 * @returns {{ compactionId: string | null, at: string | null, turn: number | null, summaryChars: number, added: number, updated: number, unchanged: number, statementsSkipped: number, skipReason: string | null }} the row.
 */
export function toRecentCompaction(entry) {
  const number = (value) => (Number.isSafeInteger(value) ? value : 0)
  return {
    compactionId: typeof entry?.compactionId === 'string' ? entry.compactionId : null,
    // A row can exist with no timestamp if the writer was mid-append when it died; the
    // panel renders that as an unknown time rather than inventing one.
    at: typeof entry?.at === 'string' ? entry.at : null,
    turn: Number.isSafeInteger(entry?.turn) ? entry.turn : null,
    summaryChars: number(entry?.summaryChars),
    added: number(entry?.atomsAdded),
    updated: number(entry?.atomsUpdated),
    // "Unchanged" and "skipped" are the two ways a compaction can produce nothing while
    // still having parsed the summary, so they are kept apart from `skipReason`.
    unchanged: number(entry?.atomsUnchanged),
    statementsSkipped: number(entry?.statementsSkipped),
    skipReason: typeof entry?.skipReason === 'string' ? entry.skipReason : null,
  }
}

/**
 * Assemble everything the panel shows, from the same sources the tools use.
 *
 * @param {{ root: string, settings: any }} input - project root and live settings.
 * @returns {object} a JSON-serializable snapshot.
 */
export function buildPanelStatus(input) {
  // `settings` is already the *effective* set: profile values with this project's
  // overrides applied. `base` is the unmerged profile set, present only so the panel can
  // show what an override replaced and offer to fall back to it.
  const settings = input.settings
  const base = input.base ?? settings
  const overridden = Array.isArray(input.overridden) ? input.overridden : []
  const projects = Array.isArray(input.projects) ? input.projects : []
  const overrideReason = input.overrideReason ?? null

  // Whether the host can delegate at all. Without it the panel can only say "no model
  // configured", which is the wrong advice when the real problem is a missing subagent
  // provider: filling in the model would change nothing. `undefined` means the caller did
  // not check, which the panel renders as "unknown" rather than as a failure.
  const serviceAvailable = input.delegationAvailable === true
  const router = {
    tier: settings.routerTier,
    provider: settings.routerProvider,
    model: settings.routerModel,
    serviceAvailable,
  }

  // A null root means no project is known for the panel. Serving an empty store would
  // look identical to "this project has no memory", which is a different and much more
  // alarming statement; say what actually happened instead.
  if (typeof input.root !== 'string' || input.root === '') {
    return {
      root: null,
      projects,
      scope: 'global',
      overridden: [],
      overrideReason,
      settings: {
        routerTier: settings.routerTier,
        routerStrategy: settings.routerStrategy,
        routerProvider: settings.routerProvider,
        routerModel: settings.routerModel,
        recallBudget: settings.recallBudget,
        recallLimit: settings.recallLimit,
        extractOnCompaction: settings.extractOnCompaction,
      },
      base: {
        routerTier: base.routerTier,
        routerStrategy: base.routerStrategy,
        routerProvider: base.routerProvider,
        routerModel: base.routerModel,
        recallBudget: base.recallBudget,
        recallLimit: base.recallLimit,
      },
      // Which keys a project may override, so the panel does not hardcode a list that
      // drifts from the writer's validator.
      overridable: [...OVERRIDABLE],
      router,
      choices: {
        routerTier: [...ROUTER_TIERS],
        routerStrategy: [...ROUTER_STRATEGIES],
      },
      atoms: { readable: false, reason: 'no-project-root', file: ATOMS_FILE },
      compactions: { readable: false, reason: 'no-project-root', file: COMPACTIONS_FILE, total: 0, produced: 0, skipped: 0, atoms: 0, byReason: {}, lastAt: null, lastCompactionId: null, recent: [] },
    }
  }
  const store = readAtoms(input.root)
  // The ledger is read newest-first for the timeline below, but summarized in its
  // natural oldest-first order so the counts cannot depend on presentation order.
  const ledger = readLedger(input.root, { limit: RECENT_COMPACTIONS })
  const ledgerEntries = ledger.ok === true ? ledger.entries : []
  const summed = summarizeLedger(ledgerEntries)

  /** @type {any} */
  const status = {
    root: input.root,
    projects,
    // Which layer the numbers above came from. `project` means at least one field is
    // this project's own; the panel uses it to say so rather than leaving a user to
    // wonder why a global edit changed nothing here.
    scope: overridden.length > 0 ? 'project' : 'global',
    overridden,
    overrideReason,
    settings: {
      routerTier: settings.routerTier,
      routerStrategy: settings.routerStrategy,
      routerProvider: settings.routerProvider,
      routerModel: settings.routerModel,
      recallBudget: settings.recallBudget,
      recallLimit: settings.recallLimit,
      extractOnCompaction: settings.extractOnCompaction,
    },
    // The profile values this project is allowed to differ from.
    base: {
      routerTier: base.routerTier,
      routerStrategy: base.routerStrategy,
      routerProvider: base.routerProvider,
      routerModel: base.routerModel,
      recallBudget: base.recallBudget,
      recallLimit: base.recallLimit,
    },
    overridable: [...OVERRIDABLE],
    router,
    // The panel offers these as choices, so it must not hardcode a copy that drifts
    // from the validator.
    choices: {
      routerTier: [...ROUTER_TIERS],
      routerStrategy: [...ROUTER_STRATEGIES],
    },
    atoms: null,
    compactions: {
      readable: ledger.ok === true,
      reason: ledger.ok === true ? null : ledger.reason,
      file: COMPACTIONS_FILE,
      total: summed.total,
      produced: summed.produced,
      skipped: summed.skipped,
      atoms: summed.atoms,
      byReason: summed.byReason,
      lastAt: summed.lastAt,
      lastCompactionId: summed.lastCompactionId,
      // Newest first, because the question this answers is "did the last compaction
      // write memory", and the answer is at the top of the list.
      recent: [...ledgerEntries].reverse().map(toRecentCompaction),
    },
  }

  if (store.ok !== true) {
    status.atoms = { readable: false, reason: store.reason, file: ATOMS_FILE }
    return status
  }
  const stats = atomStats(store.atoms)
  status.atoms = {
    readable: true,
    file: ATOMS_FILE,
    live: stats.live,
    forgotten: stats.forgotten,
    // A skipped line is not a crash — `readAtoms` tolerates a corrupt record rather
    // than losing the whole store — but it is also not nothing. Reporting it is the
    // difference between "you have no rules" and "a rule is unreadable".
    invalid: store.invalid ?? 0,
    lines: store.lines ?? 0,
    byKind: stats.byKind,
    // Standing is what the panel's "hard rules" line reports. It is counted from the
    // same field the gate uses, so the number the user sees is the number in force.
    standing: store.live.filter((atom) => atom.standing === true).length,
    // The ceiling the store prunes to. Without it, a user watching `live` sit at exactly
    // 400 every time has no way to tell "nothing new is happening" from "the store is
    // full and older atoms are being dropped to make room".
    limit: MAX_LIVE_ATOMS,
    atLimit: stats.live >= MAX_LIVE_ATOMS,
    byWeight: store.live.reduce((counts, atom) => {
      counts[atom.weight] = (counts[atom.weight] ?? 0) + 1
      return counts
    }, /** @type {Record<number, number>} */ ({})),
  }

  /*
   * The semantic upgrade's panel surface.
   *
   * Everything here is best-effort and additive: a broken lifecycle or metrics file must
   * degrade one card, never blank the panel, so each read is guarded and its failure is
   * reported as data. The switches are included because a user looking at a store with
   * no tiers needs to know whether lifecycle management is off or broken — those are
   * completely different problems and look identical from the numbers alone.
   */
  status.semantic = buildSemanticCard({
    root: input.root,
    settings,
    atoms: store.live,
  })

  /*
   * The memory explorer's data.
   *
   * Deliberately a *list*, not the whole store: the panel pages it, and a 400-atom
   * payload on every status request would make the first paint slow for exactly the
   * project that is most likely to be opened. `explorer.total` still reports the true
   * count so the UI can say "50 of 400" without loading 400 rows.
   *
   * Category and tier are resolved per row rather than stored, so this view can never
   * disagree with the retrieval path about what an atom is.
   */
  status.explorer = buildExplorerCard({ root: input.root, atoms: store.live, settings })
  /*
   * The capacity picture, stated in the four separate numbers the user actually needs:
   * live, archived, forgotten and superseded are different fates and collapsing them into
   * one "400/400" is what makes a full store look like a broken one.
   */
  status.capacity = buildCapacityCard({ atoms: store.atoms, live: store.live, limit: MAX_LIVE_ATOMS })
  return status
}

/**
 * Build the memory-explorer payload.
 *
 * @param {{ root: string, atoms: object[], settings: any, limit?: number }} input - the store and how many rows to send.
 * @returns {object} the card, never throwing.
 */
export function buildExplorerCard(input) {
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(400, input.limit)) : 50
  const rows = []
  let categoryReason = null
  try {
    for (const atom of input.atoms.slice(0, limit)) {
      const lifecycle = countersFor(atom, readCounters(input.root))
      rows.push({
        id: atom.id,
        kind: atom.kind,
        text: atom.text,
        weight: atom.weight,
        confidence: atom.confidence,
        standing: atom.standing === true,
        category: resolveCategories(atom),
        tier: lifecycle.tier,
        status: lifecycle.status,
        pinned: lifecycle.pinned,
        retrieved: lifecycle.retrieved,
        delivered: lifecycle.delivered,
        used: lifecycle.used,
        lastUsedAt: lifecycle.lastUsedAt,
        createdAt: atom.createdAt,
        updatedAt: atom.updatedAt,
        files: atom.files,
        tags: atom.tags,
        source: atom.source,
      })
    }
  } catch (error) {
    categoryReason = error instanceof Error ? error.message : String(error)
  }
  return {
    total: input.atoms.length,
    limit,
    rows,
    kindCounts: input.atoms.reduce((counts, atom) => {
      counts[atom.kind] = (counts[atom.kind] ?? 0) + 1
      return counts
    }, /** @type {Record<string, number>} */ ({})),
    categoryReason,
  }
}

/** Read lifecycle counters once per request, tolerating a missing or corrupt file. */
function readCounters(root) {
  try {
    const lifecycle = readLifecycle(root)
    return lifecycle.ok === true ? lifecycle.state.atoms : {}
  } catch {
    return {}
  }
}

/**
 * Build the capacity card.
 *
 * `archived` counts records that are still on disk but not live, which is what a pruned
 * store keeps: the point is that pruning removes an atom from the *injectable* set without
 * erasing the row, so "at the ceiling" must never be described as "memory was deleted".
 *
 * @param {{ atoms: object[], live: object[], limit: number }} input - the store.
 * @returns {object} the card.
 */
export function buildCapacityCard(input) {
  const records = Array.isArray(input.atoms) ? input.atoms : []
  const live = Array.isArray(input.live) ? input.live : []
  const forgotten = records.filter((atom) => atom.forgotten === true)
  return {
    limit: input.limit,
    live: live.length,
    records: records.length,
    archived: records.length - live.length,
    forgotten: forgotten.length,
    atLimit: live.length >= input.limit,
    headroom: Math.max(0, input.limit - live.length),
    overLimit: Math.max(0, live.length - input.limit),
    // The first few archived ids, so the panel can offer a way back to a specific row
    // instead of only reporting a number.
    archivedIds: forgotten.slice(0, 50).map((atom) => ({ id: atom.id, kind: atom.kind, updatedAt: atom.updatedAt })),
  }
}

/**
 * Build the semantic upgrade card for the panel.
 *
 * @param {{ root: string, settings: any, atoms: object[] }} input - what to describe.
 * @returns {object} the card, never throwing.
 */
export function buildSemanticCard(input) {
  const settings = input.settings ?? {}
  const switches = {
    semanticRouting: settings.semanticRouting === true,
    lifecycleEnabled: settings.lifecycleEnabled === true,
    lifecycleAutoSweep: settings.lifecycleAutoSweep === true,
    taskIntentEnabled: settings.taskIntentEnabled === true,
    intentCacheEnabled: settings.intentCacheEnabled === true,
    metricsEnabled: settings.metricsEnabled === true,
  }
  const enabled = switches.semanticRouting || switches.lifecycleEnabled || switches.taskIntentEnabled

  let tiers = null
  let tierReason = null
  try {
    const lifecycle = readLifecycle(input.root)
    if (lifecycle.ok === true) {
      tiers = countTiers(input.atoms, lifecycle.state.atoms)
      tierReason = lifecycle.corrupt ?? null
    } else {
      tierReason = lifecycle.reason
    }
  } catch (error) {
    tierReason = error instanceof Error ? error.message : String(error)
  }

  let categories = null
  let categoryReason = null
  try {
    categories = categoryCounts(input.atoms)
  } catch (error) {
    categoryReason = error instanceof Error ? error.message : String(error)
  }

  let metrics = null
  let metricsReason = null
  try {
    const report = metricsReport({ root: input.root })
    metrics = report.ok === true ? report.summary : null
    if (report.ok !== true) metricsReason = report.reason
  } catch (error) {
    metricsReason = error instanceof Error ? error.message : String(error)
  }

  return {
    enabled,
    switches,
    tiers,
    tierReason,
    categories,
    categoryReason,
    catalog: catalog(),
    metrics,
    metricsReason,
    // Stated in the payload so the panel does not have to invent the caveat.
    caveats: [
      'retrieved, delivered and confirmed-used are three separate counters; only confirmed use promotes an atom',
      'recall@k and the constraint violation rate are not measurable without ground truth, so they are null',
    ],
  }
}

/**
 * Read the `project` query parameter, if any.
 *
 * The panel sends the *canonical root* it was given, not an index and not a key. An
 * index would silently point at a different project the moment the list is reordered,
 * and a key would have to be reversible; the root is the thing the Host already uses
 * everywhere else, so it is the thing a request names.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {string | null} the requested root, or null when absent.
 */
export function readProjectParam(req) {
  try {
    const url = new URL(String(req?.url ?? '/'), 'http://localhost')
    const value = url.searchParams.get('project')
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  } catch {
    // A malformed URL means no selection; the default applies.
  }
  return null
}

/**
 * Decide which project a request is about.
 *
 * A requested root is honoured only when it is a project the Host already knows. That
 * is the security-relevant part of this function: without it, `?project=C:\` would make
 * the panel read — and the settings writer write — anywhere on disk. The allow-list is
 * the same list the panel shows, so anything selectable is acceptable and nothing else
 * is.
 *
 * @param {string | null} requested - the `project` query parameter.
 * @param {object[]} known - projects the Host reported.
 * @param {() => string | null} fallback - the default root resolver.
 * @returns {string | null} the root to report on.
 */
export function resolveRequestedRoot(requested, known, fallback) {
  // `fallback` and `known` are optional so a caller cannot turn a missing capability
  // into a crash: no resolver means no default project, no list means nothing is known.
  const fallbackRoot = typeof fallback === 'function' ? fallback : () => null
  const rows = Array.isArray(known) ? known : []
  // An empty string is not a project name; treat it as no selection. `readProjectParam`
  // already normalises this, but the caller may hand us a raw value, and "no selection"
  // must mean the default in every path rather than depending on who cleaned it up.
  if (requested === null || requested === undefined || String(requested).trim() === '') return fallbackRoot()
  const wanted = projectKey(String(requested).trim())
  const match = rows.find((row) => row !== null && typeof row === 'object' && projectKey(String(row.root)) === wanted)
  if (match !== undefined) return String(match.root)
  // An unknown root is not silently swapped for the default: the user asked about a
  // specific project, and answering about a different one would be a lie the UI cannot
  // detect. Reporting "no project" makes the panel say the selection is unknown.
  return null
}

/**
 * Whether a value is one of the per-project overridable settings.
 * @param {string} key - setting name.
 * @returns {boolean} whether a project may override it.
 */
export function isOverridable(key) {
  return OVERRIDABLE.includes(key)
}

/**
 * Report whether the panel may change a setting at all, in either scope.
 *
 * This is separate from `isOverridable`, and the difference is load-bearing for the
 * error message. A removal request (`value: null`) skips `validateSetting` by design,
 * so without this check a key the panel cannot edit in *any* scope would be refused with
 * "can only be set globally" — a reason that is simply false for, say, `projectRoot`,
 * which no scope can set from here. A wrong reason on a refusal is worse than no reason:
 * it sends the reader looking for a global control that does not exist.
 *
 * @param {string} key - the setting name.
 * @returns {boolean} whether the panel may write it.
 */
export function isEditable(key) {
  return (
    Object.prototype.hasOwnProperty.call(EDITABLE_SETTINGS, key) ||
    EDITABLE_TEXT_SETTINGS.includes(key)
  )
}

/**
 * Validate one proposed setting.
 *
 * Returning the reason rather than throwing keeps the HTTP handler free of
 * try/catch for an ordinary user error, and gives the panel something to display.
 *
 * @param {string} key - the setting name.
 * @param {unknown} value - the proposed value.
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }} the outcome.
 */
export function validateSetting(key, value) {
  if (Object.prototype.hasOwnProperty.call(EDITABLE_SETTINGS, key)) {
    const allowed = EDITABLE_SETTINGS[key]
    if (typeof value !== 'string' || !allowed.includes(value)) {
      return { ok: false, reason: `${key} must be one of: ${allowed.join(', ')}` }
    }
    return { ok: true, value }
  }
  if (EDITABLE_TEXT_SETTINGS.includes(key)) {
    if (typeof value !== 'string') return { ok: false, reason: `${key} must be a string` }
    const trimmed = value.trim()
    if (trimmed.length > 200) return { ok: false, reason: `${key} is too long` }
    return { ok: true, value: trimmed }
  }
  return { ok: false, reason: `${key} is not editable from the panel` }
}

/**
 * Read a request body, bounded.
 *
 * The bound matters: an unbounded body on a local HTTP endpoint is a way to make
 * the host allocate arbitrary memory.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {number} [limit] - maximum bytes.
 * @returns {Promise<unknown>} the parsed JSON body.
 */
export async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

/**
 * Register both routes.
 *
 * @param {{
 *   ctx: any,
 *   logger: { info: (line: string) => void, warn: (line: string) => void },
 *   readSettings: () => any,
 *   applySetting: (key: string, value: string) => Promise<void>,
 *   resolveRoot: () => string | null,
 *   listProjects?: () => object[],
 * }} input - the host context and the capabilities the panel needs.
 *   `listProjects` is optional on purpose: the project picker is an addition, and a Host
 *   that cannot enumerate projects should still render memory and settings. A missing
 *   capability degrades one card, it does not blank the panel.
 * @returns {void}
 */
export function registerPanelRoutes(input) {
  const { ctx, logger } = input

  // One accessor so the call sites cannot each invent their own fallback, and so a
  // provider that throws becomes an empty list instead of a 500. Enumeration is
  // best-effort by nature: it depends on which projects this process happens to have
  // seen, and treating that as fatal would make a convenience feature load-bearing.
  const knownProjects = () => {
    try {
      const rows = typeof input.listProjects === 'function' ? input.listProjects() : []
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }

  // Whether the host can delegate at all, read through a function so a provider that
  // registers late is picked up on the next request instead of being frozen at mount.
  const delegationAvailable = () => {
    try {
      return typeof input.delegationAvailable === 'function' ? input.delegationAvailable() === true : false
    } catch {
      return false
    }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: (req, res) => {
        if (!isLoopback(req)) {
          res.writeHead(403)
          res.end()
          return
        }
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' })
          res.end()
          return
        }
        try {
          // Which project the panel is looking at. `?project=` overrides the default,
          // which is the project this process most recently served — opening the panel
          // from a session must show that session's project without asking.
          const requested = readProjectParam(req)
          const known = knownProjects()
          const root = resolveRequestedRoot(requested, known, input.resolveRoot)
          const base = input.readSettings()
          const merged = effectiveSettings(base, root)
          sendJson(
            res,
            200,
            buildPanelStatus({
              root,
              settings: merged.settings,
              base,
              overridden: merged.overridden,
              overrideReason: merged.reason,
              projects: known,
              delegationAvailable: delegationAvailable(),
            }),
          )
        } catch (error) {
          // A panel that throws takes the user's view of memory down with it. Report
          // the failure as data instead, so the panel can show it.
          //
          // Every step of this path is defensive because the failure it reports is
          // exactly the one that has hit it before: reading the error can itself throw
          // (a proxy or an exotic object), and a response that is already committed
          // must not be written twice. Called live, an earlier version of this handler
          // produced HTTP 500 with an EMPTY body, which told the user nothing.
          const detail = describeError(error)
          try {
            logger.warn(`panel status failed: ${detail.message}`)
          } catch {
            // A logger that throws must not swallow the report.
          }
          // The stack is the part that answers "why": without it, a live 500 is a
          // guessing game. It is served over loopback only and names no user data
          // beyond this plugin's own frames.
          const body = { error: detail.message, where: detail.stack }
          if (res.headersSent === true) {
            // Someone already started the response; the status code is fixed. Leave it.
            try { res.end() } catch { /* nothing left to do */ }
            return
          }
          try {
            sendJson(res, 500, body)
          } catch {
            // Last resort: a hand-written response, so the client never gets silence.
            try {
              res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
              res.end(`panel status failed: ${detail.message}`)
            } catch {
              // The socket is gone. Nothing can be reported to it.
            }
          }
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: CONFIG_PATH,
      handler: (req, res) => {
        if (!isLoopback(req)) {
          res.writeHead(403)
          res.end()
          return
        }
        if (req.method === 'GET') {
          const requested = readProjectParam(req)
          const known = knownProjects()
          const root = resolveRequestedRoot(requested, known, input.resolveRoot)
          const base = input.readSettings()
          const merged = effectiveSettings(base, root)
          sendJson(res, 200, {
            settings: merged.settings,
            base,
            overridden: merged.overridden,
            overrideReason: merged.reason,
            root,
            scope: merged.overridden.length > 0 ? 'project' : 'global',
            overridable: [...OVERRIDABLE],
            editable: { ...EDITABLE_SETTINGS },
            text: [...EDITABLE_TEXT_SETTINGS],
          })
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'GET, POST' })
          res.end()
          return
        }
        void (async () => {
          try {
            const body = await readJsonBody(req)
            const key = body?.key
            if (typeof key !== 'string') {
              sendJson(res, 400, { error: 'key is required' })
              return
            }

            // Two scopes, and the difference is not cosmetic: `global` edits the profile
            // through the Loader (one edit for every project), `project` writes one file
            // inside the selected project. Sending a project-scoped save to the global
            // path would change every repository the user has open, so the scope is
            // explicit in the request rather than inferred from which tab is showing.
            const scope = body?.scope === 'project' ? 'project' : 'global'
            // `null` means "stop overriding this here", which is a valid project-scoped
            // request and an invalid global one: the profile always has a value.
            const removing = scope === 'project' && body?.value === null

            if (removing !== true) {
              const checked = validateSetting(key, body?.value)
              if (checked.ok !== true) {
                sendJson(res, 400, { error: checked.reason })
                return
              }
              body.value = checked.value
            }

            if (scope === 'project') {
              // Two distinct refusals, deliberately not merged: "not editable anywhere"
              // and "editable, but only globally" call for different actions from the
              // reader, and reporting the second for the first would send them hunting
              // for a global control that does not exist.
              if (isEditable(key) !== true) {
                sendJson(res, 400, { error: `"${key}" is not editable from the panel` })
                return
              }
              if (isOverridable(key) !== true) {
                sendJson(res, 400, { error: `"${key}" can only be set globally` })
                return
              }
              const requested = readProjectParam(req)
              const known = knownProjects()
              const root = resolveRequestedRoot(requested, known, input.resolveRoot)
              if (root === null) {
                sendJson(res, 400, { error: 'no project selected, so there is nothing to override' })
                return
              }
              // `null` removes the override and restores the profile value; that is a
              // different intention from "set it to the same value as global", and the
              // writer keeps the two apart.
              const written = writeOverride({ root, key, value: removing ? null : body.value })
              if (written.ok !== true) {
                sendJson(res, 500, { error: written.reason ?? 'could not save' })
                return
              }
              const base = input.readSettings()
              const merged = effectiveSettings(base, root)
              sendJson(res, 200, {
                ok: true,
                key,
                value: removing ? null : body.value,
                scope,
                overridden: written.overridden,
                settings: merged.settings,
                root,
              })
              return
            }

            await input.applySetting(key, body.value)
            const base = input.readSettings()
            const root = resolveRequestedRoot(readProjectParam(req), knownProjects(), input.resolveRoot)
            const merged = effectiveSettings(base, root)
            sendJson(res, 200, {
              ok: true,
              key,
              value: body.value,
              scope,
              overridden: merged.overridden,
              settings: merged.settings,
              root,
            })
          } catch (error) {
            const detail = describeError(error)
            logger.warn(`panel config write failed: ${detail.message}`)
            sendJson(res, 500, { error: detail.message, where: detail.stack })
          }
        })()
      },
    }),
  )
}
