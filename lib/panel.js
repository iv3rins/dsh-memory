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

import { ATOMS_FILE, atomStats, readAtoms } from '../core/memory.js'
import { readLedger, summarizeLedger, COMPACTIONS_FILE } from '../core/compactions.js'
import { ROUTER_TIERS, ROUTER_STRATEGIES } from '../core/config.js'

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
 * Assemble everything the panel shows, from the same sources the tools use.
 *
 * @param {{ root: string, settings: any }} input - project root and live settings.
 * @returns {object} a JSON-serializable snapshot.
 */
export function buildPanelStatus(input) {
  const store = readAtoms(input.root)
  const ledger = readLedger(input.root)
  const summed = summarizeLedger(ledger.ok === true ? ledger.entries : [])

  /** @type {any} */
  const status = {
    root: input.root,
    settings: {
      routerTier: input.settings.routerTier,
      routerStrategy: input.settings.routerStrategy,
      routerProvider: input.settings.routerProvider,
      routerModel: input.settings.routerModel,
      recallBudget: input.settings.recallBudget,
      recallLimit: input.settings.recallLimit,
      extractOnCompaction: input.settings.extractOnCompaction,
    },
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
    byWeight: store.live.reduce((counts, atom) => {
      counts[atom.weight] = (counts[atom.weight] ?? 0) + 1
      return counts
    }, /** @type {Record<number, number>} */ ({})),
  }
  return status
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
 *   resolveRoot: () => string,
 * }} input - the host context and the two capabilities the panel needs.
 * @returns {void}
 */
export function registerPanelRoutes(input) {
  const { ctx, logger } = input

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
          sendJson(res, 200, buildPanelStatus({ root: input.resolveRoot(), settings: input.readSettings() }))
        } catch (error) {
          // A panel that throws takes the user's view of memory down with it. Report
          // the failure as data instead, so the panel can show it.
          logger.warn(`panel status failed: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
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
          sendJson(res, 200, { settings: input.readSettings(), editable: { ...EDITABLE_SETTINGS }, text: [...EDITABLE_TEXT_SETTINGS] })
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
            const checked = validateSetting(key, body?.value)
            if (checked.ok !== true) {
              sendJson(res, 400, { error: checked.reason })
              return
            }
            await input.applySetting(key, checked.value)
            sendJson(res, 200, { ok: true, key, value: checked.value, settings: input.readSettings() })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn(`panel config write failed: ${message}`)
            sendJson(res, 500, { error: message })
          }
        })()
      },
    }),
  )
}
