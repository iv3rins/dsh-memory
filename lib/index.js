/**
 * dsh-project-memory — a host-only DeepSeek Harness plugin.
 *
 * Three cooperating systems, all stored inside the project so they belong to the
 * repository rather than to one conversation:
 *
 * - **System A (documents)** — Markdown stays the source of truth; the plugin
 *   only derives an index and reads sections on demand. It never rewrites an
 *   authoritative document.
 * - **System B (state)** — one durable JSON document holds the task, verified
 *   progress, next steps, blockers, decisions, and invariants, with
 *   compare-and-set writes, idempotence, and an audit journal.
 * - **System C (atoms)** — short durable statements harvested at compaction time,
 *   stored outside the conversation, and selected sparsely per request. This is
 *   the answer to "compaction discarded something the model needed": the summary
 *   is prose, the atoms are addressable records.
 *
 * The session receives a small baseline at its first step, deltas afterwards, and
 * a bounded recall of atoms on every step. Selection goes through a gate with a
 * three-tier router setting (`always` / `smart` / `off`) so a profile with a cheap
 * model can afford to route with a subagent on every step, while a profile that
 * would rather not spend anything stays on deterministic scoring.
 *
 * No dsh source is modified; every capability used here is a documented seam.
 */

import { normalizeConfig, routerConfigured } from '../core/config.js'
import { registerPanelRoutes } from './panel.js'
import { listProjects, effectiveSettings } from '../core/projects.js'
import { writeSetting } from './settings-write.js'
import { loadProject } from '../core/project.js'
import { ensureIndex } from '../core/indexer.js'
import { readState, staleness } from '../core/state.js'
import { MEMORY_DIR } from '../core/paths.js'
import { estimateTokens } from '../core/context.js'
import { extractFromEvents, withSource } from '../core/extract.js'
import { recordAtoms } from '../core/memory.js'
import { createConfigValidator, verifyHarness } from './harness.js'
import { buildTools, renderToolGuidance } from './tools.js'
import { withArgumentValidation } from './validate.js'
import { buildCommands } from './commands.js'
import { createCompactionObserver } from './compaction-memory.js'
import { describeRecall, recallForStep, stepQuery } from './recall.js'
import { createRouterDelegate, delegationAvailable, routeIdentity } from './delegate.js'
import {
  FORM_BASELINE,
  FORM_DELTA,
  buildSnapshot,
  composePayload,
  createInjectionMessage,
  createRecallMessage,
  recallIdentity,
  surfaceHasBaseline,
  surfaceHasRecall,
} from './inject.js'

/** Stable plugin name used in profile rows and logs. */
export const name = 'project-memory'

/**
 * The most recent project root this plugin resolved for a step.
 *
 * Module-level, not per-activation, because it answers a question about the *user*,
 * not about one plugin instance: "which project are they working on". It is set from
 * the same `resolveCwd` the tools use, so the panel and the tools agree on what the
 * current project is.
 *
 * The panel needs this because the host process has no working directory of its own.
 * `process.cwd()` is the harness install directory, which is how a live panel came to
 * report an empty store for a project that had 188 atoms.
 *
 * Deliberately not persisted: after a restart the panel shows `no-project-root` until
 * the first step runs, which is honest — the plugin genuinely does not know yet which
 * project the user is looking at.
 */
let lastProjectRoot = null

/**
 * Every project this process has served, mapped to when it last did.
 *
 * The value is a millisecond timestamp, used only to order the picker. Capped at a
 * small number because this exists to answer "which project was I just in", not to
 * build an index of the machine — an unbounded map would grow for as long as the host
 * runs and turn a convenience into a leak.
 *
 * Deliberately not persisted. After a restart the picker shows the configured project
 * and whatever the new session touches, which is honest: the plugin has not seen the
 * others yet in this process.
 */
const recentProjectRoots = new Map()

/** Remember a project root this process served. */
function noteProjectRoot(root) {
  if (typeof root !== 'string' || root === '') return
  lastProjectRoot = root
  recentProjectRoots.set(root, Date.now())
  while (recentProjectRoots.size > 20) {
    // Map preserves insertion order, and every hit re-inserts below, so the first key is
    // the least recently used.
    const oldest = recentProjectRoots.keys().next()
    if (oldest.done === true) break
    recentProjectRoots.delete(oldest.value)
  }
}

/**
 * Loader entry id this plugin registers under, as `cordis.patch.yml` declares it.
 *
 * The panel needs it to find its own configuration row. Kept next to the export so
 * a rename in the patch is one edit, not a silent mismatch.
 */
export const ENTRY_ID = 'project-memory'

/** Services required before anything can be registered. */
export const inject = ['tools']

/**
 * Config is validated by a plain normalizer wrapped in the standard-schema
 * interface: a malformed config degrades features instead of preventing the
 * plugin from loading, which matters for a plugin attached to long-lived
 * projects.
 */
export const Config = createConfigValidator(normalizeConfig)

/** Order of the guidance section inside the harness's tool-guidance band. */
const SECTION_ORDER = 165

/**
 * A logger that never throws and never writes to stdout.
 *
 * Plugin diagnostics go to the harness logger when available; a file fallback is
 * deliberately not used, because a stray write into a project directory would
 * violate this plugin's own rule about touching only `.dsh-memory`.
 *
 * @param {any} ctx - plugin context.
 * @returns {{ info: Function, warn: Function, error: Function }} a logger.
 */
function makeLogger(ctx) {
  const write = (level, message) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('project-memory') : undefined
      if (typeof logger?.[level] === 'function') logger[level](message)
    } catch {
      // Logging must never be the reason a session fails.
    }
  }
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}

/**
 * Resolve the working directory for an agent, preferring the durable session
 * header so a resumed session keeps its original project.
 *
 * `workingDirectory.get(session)` is a synchronous read of committed projection
 * state — it takes the session, not nothing, and it is not a promise.
 *
 * @param {any} ctx - plugin context.
 * @param {any} agent - the live agent, when available.
 * @returns {Promise<string | undefined>} the directory.
 */
async function resolveCwd(ctx, agent) {
  const headerCwd = agent?.session?.header?.cwd
  if (typeof headerCwd === 'string' && headerCwd !== '') return headerCwd
  const session = agent?.session
  if (session !== undefined && session !== null) {
    try {
      const value = ctx.workingDirectory?.get(session)
      if (typeof value === 'string' && value !== '') return value
    } catch {
      // An unavailable service is treated as "no directory known".
    }
  }
  return typeof process.cwd === 'function' ? process.cwd() : undefined
}

/**
 * Read the current session id from an execution or agent context.
 * @param {any} agent - the live agent.
 * @returns {string | null} the id.
 */
function sessionIdOf(agent) {
  const id = agent?.session?.header?.id ?? agent?.session?.id
  return typeof id === 'string' ? id : null
}

/**
 * Mount the plugin.
 *
 * @param {any} ctx - cordis plugin context.
 * @param {any} rawConfig - profile-supplied config.
 * @returns {Promise<void>} resolves once registration settles.
 */
export async function apply(ctx, rawConfig) {
  const settings = normalizeConfig(rawConfig)
  const logger = makeLogger(ctx)
  if (settings.enabled !== true) {
    logger.info('disabled by config; no tools, commands, or context injection registered')
    return
  }

  const harness = verifyHarness()
  if (harness.ok !== true) {
    logger.error(`harness binding is unusable: ${harness.reason}`)
    return
  }
  const canInjectContext = settings.injectContext === true

  /** Resolve the full memory context for one tool execution. */
  const resolveContext = async (exec) => {
    const cwd = await resolveCwd(ctx, exec?.agent)
    const loaded = await loadProject({
      ...(settings.projectRoot === undefined ? {} : { configuredRoot: settings.projectRoot }),
      ...(cwd === undefined ? {} : { cwd }),
      timeoutMs: settings.gitTimeoutMs,
    })
    if (!loaded.ok) return { ok: false, reason: loaded.reason }
    if (loaded.initialized === false) {
      return {
        ok: true,
        root: loaded.root,
        project: null,
        git: loaded.git,
        state: { rev: 0, task: null, blockers: [], next: [], decisions: [], invariants: [], touched: [], openQuestions: [], progress: null },
        staleness: { status: 'unknown', detail: 'project memory is not initialized' },
        index: null,
      }
    }
    const state = readState(loaded.root, { projectId: loaded.project.projectId })
    if (!state.ok) return { ok: false, reason: `cannot read state: ${state.reason}` }
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

  const tools = buildTools({
    settings,
    resolveContext,
    // Tool executions carry the live agent, so the recording can name the session
    // that wrote it instead of an anonymous null.
    sessionIdOf: (exec) => sessionIdOf(exec?.agent ?? exec?.context?.agent),
  })

  for (const tool of tools) {
    // `ctx.tools.register` enforces the *schema* but not the *arguments*, so the
    // declaration is made binding here. Without this, `{ query: 12345 }` would
    // reach the body and be stringified into a search term.
    const execute = withArgumentValidation(tool.parameters, tool.execute)
    ctx.effect(() => ctx.tools.register({ ...tool, execute }))
  }
  logger.info(`registered ${tools.length} tools`)

  /*
   * Compaction observation.
   *
   * `session/event` is post-commit and fire-and-forget: the listener is called
   * after the event is durable, failures are contained, and nothing it returns is
   * consulted. That makes it the right seam for harvesting memory and the wrong
   * seam for anything a step depends on — so the observer owns its own error
   * containment and never throws.
   *
   * The root has to be resolved per event because a session may outlive a working
   * directory change; the durable session header is preferred, exactly as for
   * context injection.
   */
  /** Last routing decision per session, so `/memory-route` can report the truth. */
  const routeCache = new Map()
  const rootBySession = new Map()
  const resolveSessionRoot = (session) => {
    const key = typeof session?.id === 'string' ? session.id : 'unknown'
    const cached = rootBySession.get(key)
    if (cached !== undefined) return cached
    const header = session?.header?.cwd
    if (typeof header === 'string' && header !== '') {
      rootBySession.set(key, header)
      return header
    }
    return null
  }
  const compaction = createCompactionObserver({
    logger,
    settings,
    resolveRoot: resolveSessionRoot,
    onWritten: () => {
      // The next step's recall must see the new atoms, so the per-session route
      // cache is dropped rather than waiting for an identity to change.
      routeCache.clear()
    },
  })
  ctx.on('session/event', (session, event) => {
    compaction.observe(session, event)
  })
  ctx.effect(() => () => {
    rootBySession.clear()
    routeCache.clear()
  })
  logger.info(`compaction memory ${settings.extractOnCompaction === true ? 'active' : 'disabled by config'}`)

  /*
   * The router runs as a real subagent, so its context comes from a context that
   * has declared `subagents` in its dependency set. Reading `ctx.subagents` on the
   * plugin's own context would throw — cordis only exposes declared services — and
   * a profile that omits the subagent bundle must not break the load, so this is
   * deferred and nullable rather than assumed.
   */
  let routerCtx = null
  ctx.inject(['subagents'], (subCtx) => {
    routerCtx = subCtx
  })


  // The guidance section is optional too. A profile may replace the system-prompt
  // service, and touching an unavailable service on a cordis context *throws*
  // rather than returning undefined — so the access goes inside `ctx.inject`,
  // which waits for the service instead of failing the whole plugin load.
  if (settings.announceToAgent === true) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      try {
        promptCtx.effect(() => promptCtx.systemPrompt.section({
          name: 'project-memory',
          order: SECTION_ORDER,
          text: renderToolGuidance(tools),
        }))
      } catch (error) {
        logger.warn(`system prompt section unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  // Commands are optional: a profile can omit the commands service entirely.
  // `ctx.inject` defers this body until the service exists, whereas touching
  // `ctx.commands` eagerly throws `cannot get property "commands" without inject`
  // and would take the whole plugin — including its tools — down with it.
  if (settings.registerCommands === true) {
    ctx.inject(['commands'], (commandCtx) => {
      try {
        const commands = buildCommands({ settings, ctx: routerCtx ?? commandCtx })
        for (const command of commands) {
          commandCtx.effect(() => commandCtx.commands.register(command))
        }
        logger.info(`registered ${commands.length} slash commands`)
      } catch (error) {
        logger.warn(`commands unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  // The sidebar panel needs an HTTP surface, because a static Client bundle cannot
  // read Host services. Everything it exposes is read-only except the router
  // settings, and those go through `configEditor` so the change is applied by the
  // Loader rather than by editing YAML behind its back.
  //
  // `configEditor` is listed alongside `webServer` and is not optional: a save that
  // cannot reach it is reported as a failure, and cordis throws on reading a service
  // this activation did not declare. Injecting only `webServer` here made every panel
  // save die with `cannot get property "configEditor" without inject`, which is a stack
  // trace from the framework where the panel's own "cannot save" sentence belonged.
  ctx.inject(['webServer', 'configEditor'], (panelCtx) => {
    try {
      // A write re-enters the Loader, which re-runs `apply` with the new config; until
      // that settles, the panel must still report something. Reading the live config
      // off the entry (when available) and falling back to the settings this
      // activation was built with keeps the panel honest in both directions.
      const readSettings = () => {
        try {
          const live = panelCtx.configEditor?.entries?.().find((entry) => entry?.id === ENTRY_ID)
          if (live !== undefined && live.config !== null && typeof live.config === 'object') {
            return { ...settings, ...live.config }
          }
        } catch {
          // An unavailable configEditor must not blank the panel.
        }
        return settings
      }
      registerPanelRoutes({
        ctx: panelCtx,
        logger,
        readSettings,
        applySetting: async (key, value) => {
          await writeSetting({ ctx: panelCtx, entryId: ENTRY_ID, key, value, logger, settings })
        },
        // Every project this process has a reason to know about: the configured root,
        // the projects previous steps served, and the current one. Ordered most-recent
        // first so the picker opens on what the user was just working on. It is not a
        // filesystem scan — walking for repositories would make opening the panel an
        // unbounded disk read, and "every directory with a .dsh-memory" is not something
        // a person wants to see in a dropdown anyway.
        listProjects: () => {
          /** @type {Array<{ root: string, lastSeen?: string | null, current?: boolean }>} */
          const candidates = []
          const configured = readSettings().projectRoot
          if (typeof configured === 'string' && configured.trim() !== '') {
            candidates.push({ root: configured })
          }
          const recent = [...recentProjectRoots.entries()].sort((left, right) => right[1] - left[1])
          for (const [root] of recent) candidates.push({ root })
          if (typeof lastProjectRoot === 'string' && lastProjectRoot !== '') {
            candidates.push({ root: lastProjectRoot, current: true })
          }
          return listProjects(candidates)
        },
        // Whether a router subagent could run here at all. Checked per request rather
        // than once at mount, because the subagents service and its providers are
        // separate plugins and either can arrive after this one.
        delegationAvailable: () => delegationAvailable(routerCtx ?? ctx),
        resolveRoot: () => {
          // Three sources, in order of how precisely each answers "which project is the
          // user looking at".
          //
          // 1. An explicit `projectRoot` config, because the operator said so.
          // 2. The root of the most recent step this process served. The panel is opened
          //    while a session is in view, so the project being worked on is the project
          //    to show. This is the only source that is right in the common case: the
          //    host process has no cwd of its own, and `workingDirectory.defaultDirectory`
          //    is a directory the shell happened to start in, not this repository.
          // 3. `workingDirectory.defaultDirectory`, read defensively — it is not among
          //    the services injected for this body, and cordis throws rather than
          //    returning undefined for a service a plugin did not inject. Optional
          //    chaining does not catch a throw.
          //
          // The whole body is wrapped because a resolver that throws is a bug in the
          // resolver, not a reason to take the panel down: with no root the panel still
          // serves settings and says it could not find the project, which is strictly
          // more useful than an error page.
          try {
            const configured = readSettings().projectRoot
            if (typeof configured === 'string' && configured.trim() !== '') {
              const resolved = resolveProjectRoot({ configuredRoot: configured })
              if (resolved.ok === true) return resolved.root
            }
            if (typeof lastProjectRoot === 'string' && lastProjectRoot !== '') return lastProjectRoot
          try {
            const directory = panelCtx.workingDirectory?.defaultDirectory
            if (typeof directory === 'string' && directory.trim() !== '') {
              const resolved = resolveProjectRoot({ cwd: directory })
              if (resolved.ok === true) return resolved.root
            }
          } catch {
            // Falls through to null.
          }
          // Reporting nothing is better than reporting the app directory: the panel
          // renders "no root known" instead of confidently showing a wrong store.
          return null
          } catch {
            // Every source failed. The panel shows "could not locate the project",
            // which is true and actionable; an exception here would show nothing.
            return null
          }
        },
      })
      logger.info('panel routes registered')
    } catch (error) {
      logger.warn(`panel routes unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  if (!canInjectContext) {
    logger.info('context injection is disabled by config; tools and commands are still registered')
    return
  }

  /** Per-session cache: the last identity delivered, keyed by session id. */
  const delivered = new Map()
  /** Per-session start source, set by `agent/created`. */
  const startSource = new WeakMap()

  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    if (agent === undefined) return
    startSource.set(agent, payload.source)
    delivered.delete(sessionIdOf(agent) ?? 'unknown')
  })

  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    if (agent === undefined) return
    delivered.delete(sessionIdOf(agent) ?? 'unknown')
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      const agent = payload?.agent
      if (agent === undefined) return decision
      if (decision?.kind === 'reject') return decision

      const cwd = await resolveCwd(ctx, agent)
      const key = sessionIdOf(agent) ?? 'unknown'
      const outbound = []
      let root = null
      let state = null
      let task = null

      const snapshot = await buildSnapshot({
        settings,
        ...(cwd === undefined ? {} : { cwd }),
      })
      if (snapshot.ok !== true) {
        logger.warn(`memory snapshot unavailable: ${snapshot.reason}`)
      } else {
        root = snapshot.root
        // The panel shows the project the user is currently working in, and this is the
        // one place that knows it. Recorded on every step, so switching projects moves
        // the panel with the user.
        if (typeof root === 'string' && root !== '') noteProjectRoot(root)
        state = snapshot.state ?? null
        task = state?.task ?? null

        const source = startSource.get(agent) ?? 'startup'
        const previous = delivered.get(key)

        // A resume, clear, or compact restarts the model's view of history, so the
        // baseline must be reasserted even when the identity is unchanged. Which
        // sources actually reach this listener is a host decision — the observed local
        // build only announces `startup` — so this is a fast path, not the guarantee;
        // the surface scan below is what actually protects against sending twice.
        const restarted = source === 'resume' || source === 'clear' || source === 'compact'
        const form = previous === undefined || restarted || previous !== snapshot.identity ? FORM_BASELINE : FORM_DELTA

        // The surface is authoritative: a compaction may already have shadowed a
        // baseline this process believes it delivered, and a forked or resumed session
        // may already contain one this process never sent.
        const alreadyDelivered = surfaceHasBaseline(agent, snapshot.identity) && restarted !== true
        if (form === FORM_BASELINE && !alreadyDelivered) {
          const composed = composePayload({ snapshot, settings, form })
          if (composed !== null) {
            outbound.push(createInjectionMessage({ payload: composed, snapshot }))
            logger.info(`injected ${composed.form} context (${composed.tier}) for ${snapshot.project?.name ?? 'uninitialized project'}`)
          }
        }
        if (form === FORM_BASELINE) delivered.set(key, snapshot.identity)
      }

      // Durable-rule harvesting runs on the messages the loop is about to send,
      // which is the only place a user's correction is visible before compaction
      // can shadow it. It never blocks the step: a failed write is a lost atom, not
      // a lost turn.
      if (settings.extractUserRules === true && root !== null) {
        const harvested = extractFromEvents(
          (decision?.messages ?? payload?.messages ?? []).map((message, index) => ({
            type: 'user/message',
            seq: index,
            data: message,
          })),
          { sessionId: key, maxAtoms: 4 },
        )
        if (harvested.atoms.length > 0) {
          const atoms = withSource(harvested.atoms, { sessionId: key, compactionId: null, seq: null })
          recordAtoms({ root, atoms, by: { sessionId: key, source: 'user-rule' } })
            .then((result) => {
              if (result.ok === true && result.added + result.updated > 0) {
                logger.info(`harvested ${result.added + result.updated} durable rule atom(s) from the current step`)
                routeCache.delete(key)
              }
            })
            .catch((error) => logger.warn(`rule harvest failed: ${error instanceof Error ? error.message : String(error)}`))
        }
      }

      // Recall is computed per step and injected only when it produced something.
      // The router runs at most once per resolved route identity, so a retried step
      // reuses the decision instead of paying for it twice.
      if (settings.injectRecall === true && root !== null) {
        // This is where a per-project override becomes real. Everything from here down
        // uses `stepSettings`, so which model reviews recall and what it prioritises are
        // this project's choices — not the profile's — without any tool needing to know
        // that a second layer exists.
        const merged = effectiveSettings(settings, root)
        if (merged.reason !== null) logger.warn(`project settings ignored: ${merged.reason}`)
        const stepSettings = merged.settings
        const query = stepQuery({
          messages: decision?.messages ?? payload?.messages ?? [],
          task,
          touched: state?.touched ?? [],
          blockers: state?.blockers ?? [],
        })
        const delegate = createRouterDelegate({
          ctx: routerCtx ?? ctx,
          settings: stepSettings,
          logger,
          agent,
          ...(cwd === undefined ? {} : { cwd }),
          ...(payload?.signal === undefined ? {} : { signal: payload.signal }),
        })
        const identity = routeIdentity({ agentId: key, queryText: query.text, tier: stepSettings.routerTier })
        const prior = routeCache.get(key)
        const recall = await recallForStep({
          root,
          settings: stepSettings,
          query,
          ...(delegate === null ? {} : { delegate }),
          routerAvailable: delegate !== null,
          cooldown: prior !== undefined && prior.identity === identity,
          ...(payload?.signal === undefined ? {} : { signal: payload.signal }),
        })
        routeCache.set(key, { identity, recall, at: Date.now() })
        if (recall.ok === true) {
          // A recall the model can still see must not be repeated: re-stating the
          // same atoms every step would spend the very budget this system exists to
          // protect. Identity is the atom set, so new atoms still get through.
          const recallKey = recallIdentity(recall)
          if (!surfaceHasRecall(agent, recallKey)) {
            outbound.push(createRecallMessage({ recall, root, identity: recallKey }))
            logger.info(`recall ${describeRecall(recall)}`)
          }
        } else if (settings.routerTier === 'always') {
          // In the `always` tier an empty recall is a configuration signal worth a
          // log line; in the other tiers it is the normal "nothing relevant" case.
          logger.info(`recall produced nothing: ${recall.reason}`)
        }
      }

      if (outbound.length === 0) return decision

      // `agent/pre-step` is a waterfall whose decision carries the messages for the
      // step; the loop then sends exactly `decision.messages`. Returning them is the
      // supported way to inject — the inbox is the wrong mailbox here, because the
      // step's message list has already been claimed by the time this listener runs,
      // so an inbox write would surface on some later step (or never).
      const messages = Array.isArray(decision?.messages) ? decision.messages : []
      return { ...decision, messages: [...messages, ...outbound] }
    } catch (error) {
      // Context injection is an enhancement: never fail a step because of it.
      logger.warn(`context injection skipped: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })

  ctx.on('agent/turn-stopping', async (payload) => {
    // Opportunistic: refresh the recorded git facts so the next session's
    // staleness verdict is accurate. Business fields are never touched here.
    try {
      const agent = payload?.agent
      if (agent === undefined) return
      const cwd = await resolveCwd(ctx, agent)
      const loaded = await loadProject({
        ...(settings.projectRoot === undefined ? {} : { configuredRoot: settings.projectRoot }),
        ...(cwd === undefined ? {} : { cwd }),
        timeoutMs: settings.gitTimeoutMs,
      })
      if (loaded.ok !== true || loaded.initialized !== true) return
      const current = readState(loaded.root, { projectId: loaded.project.projectId })
      if (current.ok !== true) return
      if (current.state.git.head === loaded.git.head && current.state.git.branch === loaded.git.branch) return
      const { writeState } = await import('../core/state.js')
      await writeState({
        root: loaded.root,
        identity: { projectId: loaded.project.projectId },
        patch: {
          git: {
            branch: loaded.git.branch,
            head: loaded.git.head,
            dirty: loaded.git.dirty,
            worktree: loaded.root,
            detached: loaded.git.detached,
          },
        },
        by: { sessionId: sessionIdOf(agent), source: 'turn-stopping' },
      })
    } catch {
      // The turn-stop hook is best-effort by design.
    }
  })

  logger.info(`context injection active (L0 ${settings.l0Budget} / L1 ${settings.l1Budget} tokens)`)
}
