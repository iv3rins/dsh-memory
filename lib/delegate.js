/**
 * Delegation: running the router as a real subagent on this harness.
 *
 * The router is not an in-process function call — it is a child agent with its
 * own session, its own route, and its own cost. That is the point: the whole
 * premise of the three-tier setting is that a *cheap* model can afford to make the
 * routing decision that the main model would otherwise have to make implicitly,
 * on every step, at full price.
 *
 * The harness exposes exactly one way to do that, `ctx.subagents.startActivation`,
 * and its contract shapes this file:
 *
 * - `request.parent` must be the **exact live** Agent object. A stale reference
 *   is rejected with `UNAUTHORIZED`, so the caller passes the live agent down
 *   rather than a captured id.
 * - `delivery: 'caller'` is used deliberately. `delivery: 'parent'` would append a
 *   completion notice to the user's transcript — a memory lookup must not become
 *   visible conversation.
 * - `maxDepth: 1` caps the child: it may not delegate further, so a router can
 *   never spawn a tree.
 * - The activation's `result` settles after teardown, so it is awaited with a
 *   timeout and disposed in `finally`; a router that hangs must not hold a turn.
 *
 * Pure Node; no DSH import. The subagents service arrives through the context.
 */

import { createHash } from 'node:crypto'

/** Tags this plugin's child sessions so `/memory-status` can count them. */
export const ROUTER_LABEL = 'memory-router'

/**
 * The subagent *transport* the router runs on.
 *
 * This is the backend that hosts the child session, and it is a different name space
 * from `routerProvider` (an LLM provider passed to the child as `agentOptions.provider`).
 * It is a constant because it is a property of how this plugin delegates, not something
 * a user configures: `spawn` is the in-process transport every profile with a working
 * router mounts. Keeping it in one place is what stops the readiness check and the
 * activation call from drifting apart, which is exactly the defect that once made the
 * router unreachable.
 */
export const SUBAGENT_TRANSPORT = 'spawn'

/** Default cap on how much of the router's reply is retained. */
export const MAX_REPLY_CHARS = 8000

/**
 * Flatten a subagent result's output blocks into text.
 *
 * Only text blocks count: reasoning blocks are excluded by the harness's own
 * output projection, and an image block in a router reply would be meaningless.
 *
 * @param {readonly any[] | undefined} output - content blocks.
 * @returns {string} the joined text.
 */
export function replyText(output) {
  if (!Array.isArray(output)) return ''
  const parts = []
  for (const block of output) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n').slice(0, MAX_REPLY_CHARS)
}

/**
 * Resolve a service without tripping cordis's `inject` guard.
 *
 * Reading `ctx.subagents` on a context that has not declared `inject: ['subagents']`
 * *throws*; `ctx.get(name)` returns `undefined` instead, which is the answer this
 * check needs.
 *
 * @param {any} ctx - plugin context.
 * @param {string} name - service name.
 * @returns {any} the service, or undefined.
 */
export function serviceOrUndefined(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name)
    return ctx?.[name]
  } catch {
    return undefined
  }
}

/**
 * The providers the subagents service actually has mounted, lowercased.
 *
 * The service is only a router: it dispatches each activation to a named backend, and
 * mounting it alone enables no delegation. A profile that mounts the service but no
 * provider therefore accepts `startActivation` and fails every call, which looks the same
 * from the outside as a router that never runs. Reading the registry lets readiness say
 * which of the two it is.
 *
 * The shape is probed rather than assumed, and an unrecognised shape returns `null`
 * meaning "cannot tell" instead of a wrong `[]` meaning "nothing mounted".
 *
 * @param {any} service - the subagents service, if any.
 * @returns {string[] | null} provider names, or null when the shape is unknown.
 */
export function listProviders(service) {
  if (service === undefined || service === null) return null
  // `list()` is the documented name (`@deepseek-ai/dsh-subagent`'s registry); the rest are
  // tolerated spellings so a renamed accessor degrades to "cannot tell" rather than to a
  // false "nothing mounted", which would disable the router on a working host.
  const candidates = [service.list, service.providers, service.listProviders, service.providerNames, service.backends]
  for (const candidate of candidates) {
    if (typeof candidate === 'function') {
      try {
        const value = candidate.call(service)
        if (Array.isArray(value)) return value.map((entry) => String(entry?.name ?? entry).toLowerCase())
      } catch {
        // A probe that throws tells us nothing; fall through to the next candidate.
      }
    } else if (Array.isArray(candidate)) {
      return candidate.map((entry) => String(entry?.name ?? entry).toLowerCase())
    } else if (candidate instanceof Map) {
      // A Map's keys are its entries; `Object.keys` on one returns [] regardless of
      // contents, which would report "nothing mounted" for a full registry.
      return [...candidate.keys()].map((entry) => String(entry).toLowerCase())
    } else if (candidate instanceof Set) {
      return [...candidate].map((entry) => String(entry?.name ?? entry).toLowerCase())
    } else if (candidate !== null && typeof candidate === 'object') {
      return Object.keys(candidate).map((entry) => entry.toLowerCase())
    }
  }
  return null
}

/**
 * Check whether the host can run a router subagent at all.
 *
 * Four separate things must hold, and each has a different remedy, so they are
 * reported separately instead of collapsing into "unavailable".
 *
 * @param {{ ctx: any, tier: string, provider: string, model: string }} input - the check inputs.
 * @returns {{ ok: true } | { ok: false, reason: string }} the verdict.
 */
export function routerReadiness(input) {
  if (input.tier === 'off') return { ok: false, reason: 'routerTier is "off"' }
  if (input.provider === '' || input.model === '') {
    return { ok: false, reason: 'routerProvider and routerModel are not configured' }
  }
  const service = serviceOrUndefined(input.ctx, 'subagents')
  if (service === undefined || service === null) return { ok: false, reason: 'this profile has no subagents service' }
  if (typeof service.startActivation !== 'function') {
    return { ok: false, reason: 'the subagents service does not expose startActivation' }
  }
  // Mounting the service alone enables no delegation: a transport has to exist.
  //
  // The transport is NOT `routerProvider`. Two different names are in play and
  // conflating them made the router silently unreachable:
  //
  // - `routerProvider` is an *LLM* provider (`airelay`, `deepseek`, ...), passed to
  //   the child as `agentOptions.provider` so the child model runs there.
  // - the activation `provider` is the *subagent transport* (`spawn`), the backend
  //   that hosts the child session at all.
  //
  // The old check asked the subagents registry for `routerProvider`, so a profile
  // configured with `airelay` was told `provider "airelay" is not mounted (available:
  // spawn)`, the delegate returned null, and no routing ever happened. The registry
  // is therefore checked for `SUBAGENT_TRANSPORT`, and `routerProvider` is only
  // validated as a non-empty string (above), which is all the host can check here.
  const providers = listProviders(service)
  if (providers !== null && providers.includes(SUBAGENT_TRANSPORT) !== true) {
    return {
      ok: false,
      reason:
        providers.length === 0
          ? `no subagent provider is mounted, so the "${SUBAGENT_TRANSPORT}" transport cannot run (mount e.g. @deepseek-ai/dsh-subagent-spawn-in-process)`
          : `the "${SUBAGENT_TRANSPORT}" subagent transport is not mounted (available: ${providers.join(', ')})`
    }
  }
  return { ok: true }
}

/**
 * Whether the router could run if a provider and model were filled in.
 *
 * The panel needs this as data, not as prose: "no model configured" and "the host cannot
 * delegate at all" need different fixes, and the fields cannot tell them apart.
 *
 * @param {any} ctx - plugin context.
 * @returns {boolean} true when the subagents service is present and usable.
 */
export function delegationAvailable(ctx) {
  const service = serviceOrUndefined(ctx, 'subagents')
  if (service === undefined || service === null) return false
  if (typeof service.startActivation !== 'function') return false
  const providers = listProviders(service)
  return providers === null ? true : providers.length > 0
}

/**
 * Build the delegation function handed to `runRouter`.
 *
 * @param {{
 *   ctx: any,
 *   settings: any,
 *   logger: { info: Function, warn: Function },
 *   agent: any,
 *   cwd?: string,
 *   signal?: AbortSignal,
 * }} input - host wiring for one step.
 * @returns {((request: { prompt: string, label: string, signal?: AbortSignal }) => Promise<string>) | null} the delegate, or null when delegation is impossible.
 */
export function createRouterDelegate(input) {
  const { ctx, settings, agent } = input
  if (settings.routerTier === 'off') return null
  const ready = routerReadiness({
    ctx,
    tier: settings.routerTier,
    provider: settings.routerProvider,
    model: settings.routerModel,
  })
  if (ready.ok !== true) {
    input.logger.info(`router subagent unavailable: ${ready.reason}`)
    return null
  }
  if (agent === undefined || agent === null) {
    input.logger.info('router subagent unavailable: no live agent in this step')
    return null
  }

  const agentOptions = {
    provider: settings.routerProvider,
    model: settings.routerModel,
    ...(settings.routerReasoningEffort === '' ? {} : { reasoningEffort: settings.routerReasoningEffort }),
  }

  return async (request) => {
    const subagents = serviceOrUndefined(ctx, 'subagents')
    if (subagents === undefined) throw new Error('the subagents service disappeared')
    const signal = request.signal ?? input.signal ?? new AbortController().signal
    const activation = await subagents.startActivation({
      provider: SUBAGENT_TRANSPORT,
      label: request.label,
      request: {
        prompt: [{ type: 'text', text: request.prompt }],
        parent: agent,
        signal,
        agentOptions,
        // The router is a leaf: it may not delegate, so a routing request can
        // never become a tree of model calls.
        maxDepth: 1,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      },
      signal,
      delivery: 'caller',
    })
    try {
      const result = await activation.result
      const text = replyText(result?.output)
      if (result?.stopReason !== 'completed') {
        input.logger.warn(`router subagent stopped with "${String(result?.stopReason)}": ${String(result?.diagnostic ?? 'no diagnostic')}`)
      }
      return text
    } finally {
      try {
        await activation.dispose()
      } catch (error) {
        input.logger.warn(`router subagent disposal failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

/**
 * Stable identity for one routing decision, so a repeated step is not re-routed.
 *
 * Keyed on the agent and the query surface rather than on step numbers: a step
 * that re-asks the same question should reuse the previous answer, and a step that
 * asks a new one should not.
 *
 * @param {{ agentId: string, tenant?: string, queryText: string, tier: string }} input - identity inputs.
 * @returns {string} a short digest.
 */
export function routeIdentity(input) {
  return createHash('sha256')
    .update(`${input.agentId}\u0000${input.tier}\u0000${input.queryText.slice(0, 2000)}`)
    .digest('hex')
    .slice(0, 16)
}
