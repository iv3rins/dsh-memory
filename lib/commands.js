/**
 * Slash commands for dsh-project-memory.
 *
 * Commands exist because context management has to be possible without asking a
 * model: a user should be able to see the saved state, preview the injected
 * baseline, force a handoff, or check the architecture directly. Every handler
 * returns the harness `CommandResult` union (`success` with text, or `error`
 * with a reason) and never throws, so a broken project cannot break the UI.
 */

import { buildBaseline } from '../core/context.js'
import { buildSnapshot } from './inject.js'
import { APPEND_FIELDS, writeState } from '../core/state.js'
import { ensureIndex } from '../core/indexer.js'
import { ARCH_FILE, checkArchitecture } from '../core/arch.js'
import { readText } from '../core/store.js'
import { resolveWithin } from '../core/paths.js'
import { ensureProjectFile } from '../core/project.js'
import { effectiveSettings } from '../core/projects.js'
import { atomStats, forgetAtoms, readAtoms } from '../core/memory.js'
import { readLedger, summarizeLedger } from '../core/compactions.js'
import { buildQuery, decideRoute, gateAtoms, renderAtoms } from '../core/gate.js'
import { clusterCandidates } from '../core/clusters.js'
import { partitionByLifecycle, readLifecycle } from '../core/lifecycle.js'
import { categoryContext } from '../core/query-category.js'
import { routerReadiness } from './delegate.js'
import { localRouterEnabled, localRouterReadiness } from './local-router.js'
import { routingModelConfigured } from './recall-review.js'

function routingModelStatus(settings, ctx) {
  if (settings.routerTier === 'off') return { local: false, ok: false, description: 'off' }
  if (localRouterEnabled(settings)) {
    const ready = localRouterReadiness(settings)
    return { local: true, ok: ready.ok, description: ready.ok ? `independent model ${settings.localRouterModel} (configured)` : ready.reason }
  }
  const ready = routerReadiness({ ctx: ctx ?? {}, tier: settings.routerTier, provider: settings.routerProvider, model: settings.routerModel })
  return { local: false, ok: ready.ok, description: ready.ok ? `${settings.routerProvider}/${settings.routerModel}` : ready.reason }
}

function previewRecall(root, store, text, settings) {
  const query = buildQuery([text])
  const lifecycle = readLifecycle(root)
  if (!lifecycle.ok) return lifecycle
  const { injectable } = partitionByLifecycle(store.live, lifecycle.state.atoms, {
    includeCold: settings.lifecycleEnabled !== true,
  })
  const shortlist = clusterCandidates({
    clusters: store.clusters,
    atoms: injectable,
    query,
    limit: Math.max(40, settings.recallLimit * 4),
    includeStanding: true,
  })
  const gating = gateAtoms({
    atoms: shortlist.atoms,
    query,
    budget: settings.recallBudget,
    limit: settings.recallLimit,
    categories: categoryContext({ text: query.text }),
  })
  return {
    ok: true,
    gating,
    eligibleCount: injectable.length,
    candidateCount: shortlist.atoms.length,
    clusterCount: shortlist.clusters.filter((cluster) => cluster.score > 0).length,
  }
}

/** A successful command result with text. */
function success(text) {
  return { kind: /** @type {const} */ ('success'), text }
}

/** A failed command result with a reason. */
function failure(text) {
  return { kind: /** @type {const} */ ('error'), text }
}

/**
 * Describe one list entry as a single line.
 * @param {any} entry - a string or one of the structured list entries.
 * @returns {string} the line.
 */
function entryLine(entry) {
  if (typeof entry === 'string') return entry
  const main = entry?.step ?? entry?.text ?? entry?.path ?? JSON.stringify(entry)
  const details = []
  if (typeof entry?.why === 'string') details.push(entry.why)
  if (typeof entry?.ref === 'string') details.push(entry.ref)
  if (typeof entry?.id === 'string') details.push(`id ${entry.id}`)
  return details.length === 0 ? main : `${main} — ${details.join('; ')}`
}

/**
 * Render the saved state as plain text.
 * @param {any} snapshot - the memory snapshot.
 * @returns {string} the report.
 */
function renderStateReport(snapshot) {
  if (snapshot.uninitialized === true) {
    return `Project memory is not initialized at ${snapshot.root}. Run /memory-init or call project_init.`
  }
  const lines = [
    `project: ${snapshot.project.name} (${snapshot.project.projectId})`,
    `root: ${snapshot.root}`,
    `git: ${snapshot.git.kind === 'repository' ? `${snapshot.git.branch ?? '(detached)'}@${snapshot.git.head ?? 'no-commits'}${snapshot.git.dirty === true ? ' dirty' : ''}` : snapshot.git.kind}`,
    `state revision: ${snapshot.state.rev}, updated ${snapshot.state.updatedAt ?? 'never'}`,
    `staleness: ${snapshot.staleness.status} — ${snapshot.staleness.detail}`,
    `index: ${snapshot.index === null ? 'none' : `${snapshot.index.documentCount} documents, built ${snapshot.index.builtAt}`}`,
  ]
  if (snapshot.state.task !== null) {
    lines.push(`task: ${snapshot.state.task.title} [${snapshot.state.task.status}]`)
  }
  if (snapshot.state.progress !== null) {
    lines.push(`progress: ${snapshot.state.progress.summary} (${snapshot.state.progress.verifiedBy === null ? 'unverified' : `verified by ${snapshot.state.progress.verifiedBy}`})`)
  }
  for (const field of APPEND_FIELDS) {
    const entries = snapshot.state[field]
    if (!Array.isArray(entries) || entries.length === 0) continue
    lines.push('', `${field}:`)
    for (const entry of entries) lines.push(`  - ${entryLine(entry)}`)
  }
  return lines.join('\n')
}

/**
 * Render the baseline a new session would receive.
 * @param {any} settings - plugin settings.
 * @param {any} snapshot - the memory snapshot.
 * @returns {string} the preview.
 */
function renderBaselinePreview(settings, snapshot) {
  if (snapshot.uninitialized === true) {
    return `Project memory is not initialized at ${snapshot.root}; a new session would only receive a one-line hint to run project_init.`
  }
  const baseline = buildBaseline({
    project: snapshot.project,
    git: snapshot.git,
    state: snapshot.state,
    staleness: snapshot.staleness,
    index: snapshot.index,
    l0Budget: settings.l0Budget,
    l1Budget: settings.l1Budget,
  })
  return [
    `tier ${baseline.tier} (~${baseline.tokens} tokens; L0 budget ${settings.l0Budget}, L1 budget ${settings.l1Budget})`,
    `kept: ${baseline.kept.join(', ') || '(none)'}`,
    `dropped: ${baseline.dropped.join(', ') || '(none)'}`,
    '',
    baseline.text,
  ].join('\n')
}

/**
 * Build the command set.
 *
 * @param {{ settings: any }} runtime - host services.
 * @returns {object[]} command definitions accepted by `ctx.commands.register`.
 */
export function buildCommands(runtime) {
  /**
   * Resolve the snapshot for one invocation without throwing.
   * @param {any} invocation - the command invocation.
   * @returns {Promise<any>} the snapshot, or a failure object.
   */
  const snapshotFor = async (invocation) => {
    const cwd = invocation?.agent?.session?.header?.cwd
    return buildSnapshot({
      settings: runtime.settings,
      ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
    })
  }

  return [
    {
      name: 'memory-status',
      description: 'Show the project memory state, its staleness, the document index, and the memory atoms.',
      handler: async (invocation) => {
        const snapshot = await snapshotFor(invocation)
        if (snapshot.ok !== true) return failure(`project memory unavailable: ${snapshot.reason}`)
        const report = [renderStateReport(snapshot)]
        if (snapshot.uninitialized !== true) {
          const settings = effectiveSettings(runtime.settings, snapshot.root).settings
          const store = readAtoms(snapshot.root)
          if (store.ok !== true) {
            report.push('', `memory atoms: unavailable — ${store.reason}`)
          } else if (store.live.length === 0) {
            report.push('', 'memory atoms: no live records', 'The harness can write memory on compaction, or you can call memory_remember.')
          } else {
            const stats = atomStats(store.atoms)
            report.push(
              '',
              `memory atoms: ${stats.live} live, ${stats.forgotten} forgotten`,
              `by kind: ${Object.entries(stats.byKind).map(([kind, count]) => `${kind} ${count}`).join(', ')}`,
              `recall: budget ${settings.recallBudget} tokens, limit ${settings.recallLimit} atoms, tier ${settings.routerTier}`,
            )
            const readiness = routingModelStatus(settings, runtime.ctx)
            report.push(`routing model: ${readiness.ok ? readiness.description : `inactive (${readiness.description})`}`)
          }
          // The compaction ledger answers what the atom store cannot: how many
          // compactions were observed, and how many of them wrote nothing. Without
          // this line a broken extractor and an idle project look the same.
          const ledger = readLedger(snapshot.root)
          if (ledger.ok === true && ledger.entries.length > 0) {
            const summed = summarizeLedger(ledger.entries)
            const reasons = Object.entries(summed.byReason).map(([reason, count]) => `${reason} ${count}`).join(', ')
            report.push(
              '',
              `compactions observed: ${summed.total} (${summed.produced} wrote atoms, ${summed.skipped} did not)`,
              summed.skipped > 0 ? `  silent because: ${reasons}` : '  every observed compaction wrote atoms',
              `  last: ${summed.lastAt ?? 'unknown'}${summed.lastCompactionId === null ? '' : ` (${String(summed.lastCompactionId).slice(0, 8)})`}`,
            )
          } else {
            report.push(
              '',
              'compactions observed: none recorded yet',
              '  The ledger appears the first time this plugin witnesses a compaction in this project.',
            )
          }
        }
        return success(report.join('\n'))
      },
    },
    {
      name: 'memory-context',
      description: 'Preview the exact baseline a new session would receive, with its token tier.',
      handler: async (invocation) => {
        const snapshot = await snapshotFor(invocation)
        if (snapshot.ok !== true) return failure(`project memory unavailable: ${snapshot.reason}`)
        return success(renderBaselinePreview(runtime.settings, snapshot))
      },
    },
    {
      name: 'memory-init',
      description: 'Create .dsh-memory/project.json and an initial state document for this project.',
      handler: async (invocation) => {
        const snapshot = await snapshotFor(invocation)
        if (snapshot.ok !== true) return failure(`project memory unavailable: ${snapshot.reason}`)
        if (snapshot.uninitialized !== true) return success(`already initialized: ${snapshot.project.projectId}`)
        const created = ensureProjectFile({ root: snapshot.root, git: snapshot.git })
        if (created.ok !== true) return failure(created.reason)
        const indexed = ensureIndex({ root: snapshot.root, settings: runtime.settings, force: true })
        return success([
          `initialized ${snapshot.root}`,
          `project id: ${created.document.projectId}`,
          `index: ${indexed.ok === true ? `${indexed.index.documentCount} documents` : `unavailable (${indexed.reason})`}`,
        ].join('\n'))
      },
    },
    {
      name: 'memory-handoff',
      description: 'Record a handoff note: /memory-handoff <what you finished and what is next>',
      handler: async (invocation) => {
        const note = String(invocation?.rawInput ?? '').trim()
        if (note === '') return failure('usage: /memory-handoff <what you finished and what is next>')
        const snapshot = await snapshotFor(invocation)
        if (snapshot.ok !== true) return failure(`project memory unavailable: ${snapshot.reason}`)
        if (snapshot.uninitialized === true) return failure('project memory is not initialized here; run /memory-init or call project_init first.')
        const written = await writeState({
          root: snapshot.root,
          identity: { projectId: snapshot.project.projectId },
          patch: {
            progress: { summary: note, verifiedBy: null },
            git: {
              branch: snapshot.git.branch,
              head: snapshot.git.head,
              dirty: snapshot.git.dirty,
              worktree: snapshot.root,
              detached: snapshot.git.detached,
            },
          },
          by: { sessionId: invocation?.agent?.session?.header?.id ?? null, source: 'command:memory-handoff' },
        })
        if (written.ok !== true) return failure(`handoff failed: ${written.reason}`)
        if (written.status === 'unchanged') return success(`handoff unchanged at revision ${written.rev}`)
        return success(`handoff recorded at revision ${written.rev} (changed ${written.changed.join(', ')})`)
      },
    },
    {
      name: 'memory-recall',
      description: 'Preview deterministic recall from project memory clusters: /memory-recall <text>',
      handler: async (invocation) => {
        const query = String(invocation?.rawInput ?? '').trim()
        if (query === '') return failure('usage: /memory-recall <what the next step is about>')
        const snapshot = await snapshotFor(invocation)
        if (snapshot.ok !== true) return failure(`project memory unavailable: ${snapshot.reason}`)
        if (snapshot.uninitialized === true) return failure('project memory is not initialized here; run /memory-init or call project_init first.')
        const store = readAtoms(snapshot.root)
        if (store.ok !== true) return failure(`cannot read memory atoms: ${store.reason}`)
        if (store.live.length === 0) return success('no live memory atoms are stored.')
        const settings = effectiveSettings(runtime.settings, snapshot.root).settings
        const preview = previewRecall(snapshot.root, store, query, settings)
        if (!preview.ok) return failure(`cannot read memory lifecycle: ${preview.reason}`)
        const { gating, clusterCount } = preview
        const block = renderAtoms({ selected: gating.selected })
        if (block === '') {
          return success(`No memory matched ${JSON.stringify(query)} across ${store.clusters.length} cluster(s) with ${store.live.length} live atom(s).`)
        }
        const header = [
          `${gating.selected.length} atom(s) selected, ~${gating.tokens}/${gating.budget} tokens, confidence ${gating.confidence}`,
          `${clusterCount} matching cluster(s), ${gating.excluded.length} excluded candidate(s), ${store.live.length} live atom(s)`,
          '',
        ]
        return success(`${header.join('\n')}${block}`)
      },
    },
    {
      name: 'memory-route',
      description: 'Show which recall route the next step would take and why, without spending a model call.',
      handler: async (invocation) => {
        const snapshot = await snapshotFor(invocation)
        if (snapshot.ok !== true) return failure(`project memory unavailable: ${snapshot.reason}`)
        if (snapshot.uninitialized === true) return failure('project memory is not initialized here; run /memory-init or call project_init first.')
        const store = readAtoms(snapshot.root)
        if (store.ok !== true) return failure(`cannot read memory atoms: ${store.reason}`)
        const settings = effectiveSettings(runtime.settings, snapshot.root).settings
        const readiness = routingModelStatus(settings, runtime.ctx)
        const query = String(invocation?.rawInput ?? '').trim() || snapshot.state.task?.title || ''
        if (settings.injectRecall !== true) return success('Automatic memory recall is disabled.')
        const preview = previewRecall(snapshot.root, store, query, settings)
        if (!preview.ok) return failure(`cannot read memory lifecycle: ${preview.reason}`)
        const { gating, clusterCount } = preview
        const configured = routingModelConfigured(settings)
        const decision = decideRoute({
          tier: settings.routerTier,
          gating,
          storedAtoms: preview.eligibleCount,
          routerAvailable: configured,
        })
        let routeLabel = decision.route
        let reason = decision.reason
        if (preview.candidateCount === 0) {
          routeLabel = 'none'
          reason = 'no eligible memory candidates matched this request'
        } else if (decision.route === 'subagent') {
          routeLabel = readiness.local ? 'independent routing model' : 'DSH routing model'
          if (!readiness.ok) {
            routeLabel = 'none'
            reason = 'the configured routing model is unavailable'
          }
        } else if (decision.route === 'deterministic' && configured) {
          routeLabel = 'deterministic proposal'
        }
        return success([
          `tier: ${settings.routerTier} (always | smart | off)`,
          `route for this request: ${routeLabel}`,
          `reason: ${reason}`,
          `routing model: ${readiness.ok ? readiness.description : `inactive (${readiness.description})`}`,
          `store: ${store.live.length} live atom(s), ${clusterCount} matching cluster(s)`,
          `deterministic recall: ${gating.selected.length} atom(s), ~${gating.tokens}/${gating.budget} tokens, confidence ${gating.confidence}`,
          '',
          '/memory-route previews the decision without making a model call.',
        ].join('\n'))
      },
    },
    {
      name: 'memory-forget',
      description: 'Forget memory atoms by id, keeping a tombstone: /memory-forget <id> [id...]',
      handler: async (invocation) => {
        const ids = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter((id) => id !== '')
        if (ids.length === 0) return failure('usage: /memory-forget <atom id> [atom id...] (find ids with /memory-recall)')
        const snapshot = await snapshotFor(invocation)
        if (snapshot.ok !== true) return failure(`project memory unavailable: ${snapshot.reason}`)
        if (snapshot.uninitialized === true) return failure('project memory is not initialized here; run /memory-init or call project_init first.')
        const result = await forgetAtoms({ root: snapshot.root, ids })
        if (result.ok !== true) return failure(`forget failed: ${result.reason}`)
        if (result.forgotten === 0) {
          return success(`nothing forgotten: ${result.missing} id(s) not found among ${result.records} record(s)`)
        }
        return success(`forgot ${result.forgotten} atom(s); ${result.missing} id(s) not found. A tombstone prevents re-extraction from a later compaction summary.`)
      },
    },
    {
      name: 'memory-sync',
      description: 'Re-scan project documents and rebuild the knowledge index.',
      handler: async (invocation) => {
        const snapshot = await snapshotFor(invocation)
        if (snapshot.ok !== true) return failure(`project memory unavailable: ${snapshot.reason}`)
        if (snapshot.uninitialized === true) return failure('project memory is not initialized here; run /memory-init or call project_init first.')
        const rebuilt = ensureIndex({ root: snapshot.root, settings: runtime.settings, force: true })
        if (rebuilt.ok !== true) return failure(`index rebuild failed: ${rebuilt.reason}`)
        const stats = rebuilt.stats ?? { total: rebuilt.index.documentCount, added: 0, changed: 0, unchanged: 0, removed: 0, skipped: 0 }
        return success(`index rebuilt: ${stats.total} documents (added ${stats.added}, changed ${stats.changed}, unchanged ${stats.unchanged}, removed ${stats.removed}, skipped ${stats.skipped})`)
      },
    },
    {
      name: 'architecture-check',
      description: 'Run the deterministic dependency rules from .dsh-memory/arch.json.',
      handler: async (invocation) => {
        const snapshot = await snapshotFor(invocation)
        if (snapshot.ok !== true) return failure(`project memory unavailable: ${snapshot.reason}`)
        if (snapshot.uninitialized === true) return failure('project memory is not initialized here; run /memory-init or call project_init first.')
        const resolved = resolveWithin(snapshot.root, ARCH_FILE)
        if (resolved.ok !== true) return failure(resolved.reason)
        const raw = readText(resolved.absolute)
        if (raw.ok !== true) return failure(`no rules file at ${ARCH_FILE}`)
        let document
        try {
          document = JSON.parse(raw.text)
        } catch (error) {
          return failure(`${ARCH_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
        }
        const result = checkArchitecture({ root: snapshot.root, document })
        if (result.ok !== true) return failure(`architecture check failed: ${result.reason}`)
        const lines = [
          `verdict: ${result.status}`,
          `rules: ${result.rules}, files scanned: ${result.scanned}, violations: ${result.violations.length}`,
        ]
        for (const violation of result.violations.slice(0, 20)) {
          lines.push(`- ${violation.file}:${violation.line} imports ${violation.specifier} (rule ${violation.rule})`)
        }
        if (result.violations.length > 20) lines.push(`- (+${result.violations.length - 20} more)`)
        return success(lines.join('\n'))
      },
    },
  ]
}
