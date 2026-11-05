/**
 * L0–L3 context construction.
 *
 * The budget model exists because context is the scarce resource: an eager
 * memory plugin that pastes a project's whole state into every session is worse
 * than no plugin at all. Four explicit tiers, each with a hard character ceiling
 * and a documented truncation order:
 *
 * | tier | when | content |
 * |------|------|---------|
 * | L0   | every new session | identity, git revision, one task line, top invariant |
 * | L1   | when the state is fresh | L0 + next/blockers/decisions + document titles |
 * | L2   | on demand | search hits / one document section |
 * | L3   | on request | a whole document, paged |
 *
 * Estimation is deliberately conservative: one token is assumed per four
 * characters, which over-counts prose and under-counts nothing important.
 *
 * Pure Node; no DSH import.
 */

/** Characters per token assumed for budgeting (conservative for mixed prose). */
export const CHARS_PER_TOKEN = 4

/** Truncation priority when the baseline exceeds its budget; earlier survives. */
export const TRUNCATION_ORDER = Object.freeze(['identity', 'task', 'invariants', 'next', 'blockers', 'decisions', 'documents', 'progress'])

/**
 * Estimate the token cost of a string.
 * @param {string} text - input text.
 * @returns {number} estimated tokens, rounded up.
 */
export function estimateTokens(text) {
  return Math.ceil(String(text).length / CHARS_PER_TOKEN)
}

/**
 * Render one line per list entry with an item cap.
 * @param {string} label - section label.
 * @param {string[]} items - rendered entries.
 * @param {number} max - maximum entries kept.
 * @returns {string} the rendered block, or an empty string.
 */
function bulletBlock(label, items, max) {
  if (items.length === 0) return ''
  const kept = items.slice(0, max)
  const lines = [`${label}:`, ...kept.map((item) => `- ${item}`)]
  if (items.length > kept.length) lines.push(`- (+${items.length - kept.length} more, use memory_search)`)
  return lines.join('\n')
}

/**
 * Render a state document into the individual baseline sections.
 *
 * Returning sections instead of a finished string is what makes honest budget
 * enforcement possible: the caller drops whole sections by priority rather than
 * slicing a rendered blob mid-sentence.
 *
 * @param {{ project: any, git: any, state: any, staleness: any, index: any | null, documentsLimit?: number }} input - render inputs.
 * @returns {{ key: string, text: string }[]} sections in priority order.
 */
export function renderSections(input) {
  const { project, git, state, staleness, index } = input
  const documentsLimit = input.documentsLimit ?? 60
  const sections = []

  const identityLines = [`project: ${project?.name ?? '(unnamed)'} (id ${String(project?.projectId ?? 'unknown').slice(0, 8)})`]
  if (git?.kind === 'repository') {
    const branch = git.detached ? '(detached)' : git.branch ?? '(unknown)'
    identityLines.push(`git: ${branch}@${git.head ?? 'no-commits'}${git.dirty === true ? ' (dirty)' : ''}`)
  } else {
    identityLines.push('git: not a repository (revision tracking unavailable)')
  }
  identityLines.push(`state: rev ${state?.rev ?? 0}${staleness === undefined ? '' : `, staleness ${staleness.status}`}`)
  if (staleness !== undefined && staleness.status !== 'fresh') identityLines.push(`note: ${staleness.detail}`)
  sections.push({ key: 'identity', text: identityLines.join('\n') })

  if (state?.task !== null && state?.task !== undefined) {
    const task = state.task
    const parts = [`task: ${task.title || '(untitled)'}`, `status: ${task.status}`]
    if (typeof task.id === 'string' && task.id !== '') parts.push(`id: ${task.id}`)
    if (typeof task.phase === 'string' && task.phase !== '') parts.push(`phase: ${task.phase}`)
    sections.push({ key: 'task', text: parts.join('; ') })
  }

  if (Array.isArray(state?.invariants) && state.invariants.length > 0) {
    sections.push({ key: 'invariants', text: bulletBlock('invariants (hard rules, never violate)', state.invariants, 8) })
  }
  if (Array.isArray(state?.next) && state.next.length > 0) {
    const items = state.next.map((entry) => (entry.why === undefined ? entry.step : `${entry.step} — ${entry.why}`))
    sections.push({ key: 'next', text: bulletBlock('next steps', items, 6) })
  }
  if (Array.isArray(state?.blockers) && state.blockers.length > 0) {
    sections.push({ key: 'blockers', text: bulletBlock('blockers', state.blockers.map((entry) => entry.text), 6) })
  }
  if (Array.isArray(state?.decisions) && state.decisions.length > 0) {
    const items = state.decisions.map((entry) => (entry.ref === undefined ? entry.text : `${entry.text} (${entry.ref})`))
    sections.push({ key: 'decisions', text: bulletBlock('decisions already made (do not relitigate)', items, 6) })
  }
  if (index !== null && index !== undefined && Array.isArray(index.documents)) {
    const current = index.documents.filter((entry) => entry.status === 'current' || entry.status === 'accepted')
    if (current.length > 0) {
      const kept = current.slice(0, documentsLimit)
      const lines = [`project documents (${current.length} current, call memory_read for content):`]
      for (const document of kept) lines.push(`- ${document.path} — ${document.title} [${document.status}/${document.kind}]`)
      if (current.length > kept.length) lines.push(`- (+${current.length - kept.length} more, use memory_search)`)
      sections.push({ key: 'documents', text: lines.join('\n') })
    }
  }
  if (state?.progress !== null && state?.progress !== undefined && typeof state.progress.summary === 'string' && state.progress.summary !== '') {
    const verified = state.progress.verifiedBy === null || state.progress.verifiedBy === undefined
      ? 'not yet verified'
      : `verified by ${state.progress.verifiedBy}${state.progress.lastVerifiedAt === null ? '' : ` at ${state.progress.lastVerifiedAt}`}`
    sections.push({ key: 'progress', text: `progress (${verified}): ${state.progress.summary}` })
  }
  return sections
}

/**
 * Fit sections into a token budget by dropping lower-priority ones.
 *
 * The first section (identity) is always kept, even when it alone exceeds the
 * budget: a session that knows nothing about the project is worse than one that
 * overshoots slightly. Everything dropped is counted so the caller can say so.
 *
 * @param {{ sections: { key: string, text: string }[], budget: number, order?: readonly string[] }} input - fitting inputs.
 * @returns {{ text: string, kept: string[], dropped: string[], tokens: number }} the fitted baseline.
 */
export function fitBudget(input) {
  const order = input.order ?? TRUNCATION_ORDER
  const prioritized = [...input.sections].sort((left, right) => {
    const leftIndex = order.indexOf(left.key)
    const rightIndex = order.indexOf(right.key)
    return (leftIndex === -1 ? order.length : leftIndex) - (rightIndex === -1 ? order.length : rightIndex)
  })
  const kept = []
  const dropped = []
  let used = 0
  for (const section of prioritized) {
    const cost = estimateTokens(`${section.text}\n`)
    const mandatory = section.key === 'identity'
    if (!mandatory && used + cost > input.budget) {
      dropped.push(section.key)
      continue
    }
    kept.push(section)
    used += cost
  }
  let text = kept.map((section) => section.text).join('\n\n')
  if (dropped.length > 0) {
    text += `\n\n[context trimmed: ${dropped.join(', ')} omitted to stay within the ${input.budget}-token budget. Use memory_status for details.]`
  }
  return { text, kept: kept.map((section) => section.key), dropped, tokens: estimateTokens(text) }
}

/**
 * Build the complete L0/L1 baseline for one session.
 *
 * L1 is attempted first; when the richer rendering exceeds the L1 budget the
 * builder degrades to L0 and reports which tier actually fit, so the caller can
 * log an honest answer instead of claiming rich context it did not deliver.
 *
 * @param {{ project: any, git: any, state: any, staleness: any, index: any | null, l0Budget: number, l1Budget: number }} input - build inputs.
 * @returns {{ text: string, tier: 'L0' | 'L1', tokens: number, kept: string[], dropped: string[], fitsL0: boolean }} the baseline.
 */
export function buildBaseline(input) {
  const sections = renderSections(input)
  const l1 = fitBudget({ sections, budget: input.l1Budget })
  const l0 = fitBudget({ sections, budget: input.l0Budget })

  // L1 only counts as L1 when it kept the richer sections; otherwise degrade
  // honestly rather than shipping an L0 payload under an L1 label.
  const richKeys = new Set(['next', 'blockers', 'decisions', 'documents'])
  const richKept = l1.kept.some((key) => richKeys.has(key))
  if (richKept) {
    return {
      text: l1.text,
      tier: 'L1',
      tokens: l1.tokens,
      kept: l1.kept,
      dropped: l1.dropped,
      fitsL0: estimateTokens(l0.text) <= input.l0Budget,
    }
  }
  return {
    text: l0.text,
    tier: 'L0',
    tokens: l0.tokens,
    kept: l0.kept,
    dropped: l0.dropped,
    fitsL0: true,
  }
}
