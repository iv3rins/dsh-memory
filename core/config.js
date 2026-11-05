/**
 * Runtime configuration for dsh-project-memory.
 *
 * The plugin ships no schema-library dependency: cordis validates `Config` when
 * it is a standard-schema object, and this module is the *normalizer* that runs
 * regardless. Keeping normalization here means an absent, partial, or
 * wrong-typed config still yields a usable, fully-populated settings object —
 * a bad config degrades features instead of preventing the plugin from loading.
 */

/** The three retrieval-routing tiers a profile may select. */
export const ROUTER_TIERS = Object.freeze(['always', 'smart', 'off'])

/**
 * Routing strategies, mirroring `lib/router.js`.
 *
 * Duplicated rather than imported so `core/config.js` stays free of `lib/` imports —
 * config is the lower layer, and a cycle between them would make load order matter.
 * The unit tests assert the two lists agree.
 */
export const ROUTER_STRATEGIES = Object.freeze(['task', 'compliance', 'orient'])

/** Every default in one place, so documentation and behavior cannot drift apart. */
export const DEFAULTS = Object.freeze({
  /** Master switch for tools, prompt section, and context injection. */
  enabled: true,
  /** Inject the L0/L1 baseline into new sessions. */
  injectContext: true,
  /** Announce the available tools in the system prompt. */
  announceToAgent: true,
  /** Register the slash commands. */
  registerCommands: true,
  /** L0 token budget (hard ceiling for the always-injected block). */
  l0Budget: 300,
  /** L1 token budget (task/next/blockers/decisions plus document titles). */
  l1Budget: 1200,
  /** L2 per-call budget for search and read results. */
  l2Budget: 2000,
  /** Maximum indexed documents in one scan. */
  maxDocuments: 5000,
  /** Maximum bytes read from a single document. */
  maxDocumentBytes: 512 * 1024,
  /** Milliseconds allowed for one `git` invocation. */
  gitTimeoutMs: 4000,
  /** Documents matching these glob-ish prefixes are indexed. */
  includePrefixes: ['docs/', 'README.md', 'CHANGELOG.md', 'AGENTS.md'],
  /** Paths never indexed or written. */
  excludePrefixes: ['.dsh-memory/', 'node_modules/', '.git/', 'dist/', 'build/', 'Library/', 'Temp/', 'obj/'],
  /** Paths the plugin refuses to modify, whatever a tool asks. */
  protectedPaths: ['AGENTS.md', 'docs/decisions/', 'docs/adr/', '.git/'],
  /** Write proposals under this directory instead of editing authoritative docs. */
  proposalsDir: 'docs/proposals',
  /** Refuse writes larger than this many bytes. */
  maxWriteBytes: 512 * 1024,

  /** Harvest memory atoms from a compaction summary when one is written. */
  extractOnCompaction: true,
  /** Harvest memory atoms from user messages that state a durable rule. */
  extractUserRules: true,
  /** Inject recalled memory atoms into each step. */
  injectRecall: true,
  /** Token ceiling for the recalled-memory block in one step. */
  recallBudget: 400,
  /** Maximum atoms injected in one step. */
  recallLimit: 8,

  /**
   * Three-tier retrieval routing.
   *
   * `off` never spends a model call; `always` always asks the router subagent;
   * `smart` asks only when deterministic gating comes back empty or weak. The
   * default is `smart` *with no router route configured*, which resolves to the
   * deterministic path: nothing is spent until a provider and model are named.
   */
  routerTier: 'smart',
  /** Provider id for the router subagent; empty disables router calls. */
  routerProvider: '',
  /** Model id for the router subagent; empty disables router calls. */
  routerModel: '',
  /** Reasoning effort for the router subagent; empty inherits the parent's. */
  routerReasoningEffort: '',
  /** Milliseconds allowed for one router subagent run. */
  routerTimeoutMs: 20000,
  /** Ask the router at most once per this many steps (1 = every step). */
  routerCooldownSteps: 1,
  /** Token ceiling for the memory digest handed to the router. */
  routerDigestBudget: 900,
  /**
   * What the router is asked to prioritise.
   *
   * `task` weights what the step is about to do; `compliance` weights the rules and
   * corrections governing the files in play; `orient` weights background and prior
   * decisions when the request is to understand rather than to act. Each strategy
   * produces different instructions, because one generic "pick what is relevant"
   * prompt makes both jobs look identical to the model.
   */
  routerStrategy: 'task',
})

/** Accept only a finite number inside an inclusive range. */
function number(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/** Accept only a boolean; anything else keeps the default. */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** Accept one of a fixed set of strings; anything else keeps the default. */
function choice(value, fallback, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/** Accept a trimmed string, or the default when absent or empty. */
function text(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** Normalize a list of string prefixes to forward slashes with no leading `./`. */
function prefixes(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const cleaned = value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.replace(/\\/g, '/').replace(/^\.\//, '').trim())
    .filter((entry) => entry !== '')
  return cleaned.length === 0 ? [...fallback] : cleaned
}

/**
 * Normalize a raw plugin config into a complete settings object.
 *
 * @param {unknown} raw - whatever the profile supplied (often `undefined`).
 * @returns {typeof DEFAULTS & { projectRoot?: string }} normalized settings.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  /** @type {any} */
  const settings = {
    enabled: bool(input.enabled, DEFAULTS.enabled),
    injectContext: bool(input.injectContext, DEFAULTS.injectContext),
    announceToAgent: bool(input.announceToAgent, DEFAULTS.announceToAgent),
    registerCommands: bool(input.registerCommands, DEFAULTS.registerCommands),
    l0Budget: number(input.l0Budget, DEFAULTS.l0Budget, 80, 4000),
    l1Budget: number(input.l1Budget, DEFAULTS.l1Budget, 200, 20000),
    l2Budget: number(input.l2Budget, DEFAULTS.l2Budget, 200, 40000),
    maxDocuments: number(input.maxDocuments, DEFAULTS.maxDocuments, 1, 100000),
    maxDocumentBytes: number(input.maxDocumentBytes, DEFAULTS.maxDocumentBytes, 1024, 8 * 1024 * 1024),
    gitTimeoutMs: number(input.gitTimeoutMs, DEFAULTS.gitTimeoutMs, 200, 60000),
    includePrefixes: prefixes(input.includePrefixes, DEFAULTS.includePrefixes),
    excludePrefixes: prefixes(input.excludePrefixes, DEFAULTS.excludePrefixes),
    protectedPaths: prefixes(input.protectedPaths, DEFAULTS.protectedPaths),
    proposalsDir: typeof input.proposalsDir === 'string' && input.proposalsDir.trim() !== ''
      ? input.proposalsDir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
      : DEFAULTS.proposalsDir,
    maxWriteBytes: number(input.maxWriteBytes, DEFAULTS.maxWriteBytes, 256, 8 * 1024 * 1024),
    extractOnCompaction: bool(input.extractOnCompaction, DEFAULTS.extractOnCompaction),
    extractUserRules: bool(input.extractUserRules, DEFAULTS.extractUserRules),
    injectRecall: bool(input.injectRecall, DEFAULTS.injectRecall),
    recallBudget: number(input.recallBudget, DEFAULTS.recallBudget, 100, 8000),
    recallLimit: number(input.recallLimit, DEFAULTS.recallLimit, 1, 40),
    routerTier: choice(input.routerTier, DEFAULTS.routerTier, ROUTER_TIERS),
    routerProvider: text(input.routerProvider, DEFAULTS.routerProvider),
    routerModel: text(input.routerModel, DEFAULTS.routerModel),
    routerReasoningEffort: text(input.routerReasoningEffort, DEFAULTS.routerReasoningEffort),
    routerTimeoutMs: number(input.routerTimeoutMs, DEFAULTS.routerTimeoutMs, 1000, 600000),
    routerCooldownSteps: number(input.routerCooldownSteps, DEFAULTS.routerCooldownSteps, 1, 50),
    routerDigestBudget: number(input.routerDigestBudget, DEFAULTS.routerDigestBudget, 200, 8000),
    routerStrategy: choice(input.routerStrategy, DEFAULTS.routerStrategy, ROUTER_STRATEGIES),
  }
  if (typeof input.projectRoot === 'string' && input.projectRoot.trim() !== '') {
    settings.projectRoot = input.projectRoot
  }
  if (settings.l1Budget < settings.l0Budget) settings.l1Budget = settings.l0Budget
  if (settings.l2Budget < 200) settings.l2Budget = 200
  return settings
}

/**
 * Whether a router subagent route is fully configured.
 *
 * A provider without a model (or the reverse) is a half-written config, not a
 * request to guess: the plugin treats it as unconfigured and stays on the
 * deterministic path rather than inventing a route.
 *
 * @param {{ routerTier: string, routerProvider: string, routerModel: string }} settings - normalized settings.
 * @returns {boolean} whether router calls may be attempted.
 */
export function routerConfigured(settings) {
  return settings.routerTier !== 'off' && settings.routerProvider !== '' && settings.routerModel !== ''
}

/**
 * Decide whether a project-relative path is protected from plugin writes.
 *
 * Protection is prefix-based and case-insensitive on Windows, because a
 * case-variant path must not sneak past the guard.
 *
 * @param {string} relative - project-relative path in forward slashes.
 * @param {readonly string[]} protectedPaths - configured protected prefixes.
 * @returns {string | null} the matching protected prefix, or null when writable.
 */
export function protectedBy(relative, protectedPaths) {
  const normalized = relative.replace(/\\/g, '/').replace(/^\.\//, '')
  const lowered = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  for (const prefix of protectedPaths) {
    const candidate = process.platform === 'win32' ? prefix.toLowerCase() : prefix
    if (lowered === candidate || lowered.startsWith(candidate.endsWith('/') ? candidate : `${candidate}/`)) {
      return prefix
    }
  }
  return null
}
