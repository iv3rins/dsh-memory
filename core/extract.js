/**
 * Extraction: turning a compaction summary — and the turns around it — into
 * durable memory atoms.
 *
 * The problem this solves is specific. The harness's compactor produces a
 * structured checkpoint with fixed sections and then *replaces the original
 * turns with it*. Everything the checkpoint drops is gone for the rest of the
 * session. The checkpoint is also prose written for a reader, not a set of
 * addressable records, so it cannot be re-selected later: the next request has
 * no way to say "give me the two constraints about Windows paths from that
 * summary".
 *
 * Extraction is deliberately deterministic and conservative. A model call here
 * would double the cost of every compaction and could hallucinate a constraint
 * that the user never stated; a parser over the known section headings cannot.
 * What it cannot parse it leaves alone — a missing atom costs one search, a
 * fabricated one corrupts every later turn.
 *
 * Pure Node; no DSH import.
 */

import { normalizeAtomText, ATOM_KINDS } from './memory.js'

/** Section heading → default atom kind, for the compactor's own output shape. */
export const SECTION_KINDS = Object.freeze({
  'primary request and intent': 'task',
  'key technical concepts': 'fact',
  'files and code': 'fact',
  'errors and fixes': 'pitfall',
  'pending jobs': 'task',
  'current work': 'task',
  'next step': 'task',
  'critical context': 'constraint',
})

/** Sections whose statements are about the user's wishes, not the code. */
const USER_SECTIONS = new Set(['primary request and intent', 'critical context'])

/**
 * Keyword cues that reclassify a statement regardless of its section.
 *
 * Order matters: the first matching rule wins, and prohibitions are checked
 * before preferences because "never use X" is a constraint even when it appears
 * under a preferences heading.
 */
export const KIND_CUES = Object.freeze([
  { kind: 'constraint', pattern: /\b(?:must not|must never|never|do not|don't|dont|forbidden|prohibited|refuse|not allowed)\b/i },
  { kind: 'constraint', pattern: /\b(?:must|required|always|only)\b/i },
  { kind: 'preference', pattern: /\b(?:prefers?|preference|would rather|instead of|favour|favor)\b/i },
  { kind: 'pitfall', pattern: /\b(?:error|failed|failure|bug|pitfall|trap|breaks?|broken|regression|does not work|doesn't work)\b/i },
  { kind: 'decision', pattern: /\b(?:decided|decision|chose|chosen|agreed|settled on|we will use|opted)\b/i },
  { kind: 'question', pattern: /\b(?:open question|unclear|unknown|tbd|to be decided|unresolved)\b/i },
])

/** Markers the compactor writes for an empty section, which are not content. */
const EMPTY_MARKERS = new Set(['(none)', 'none', '-', 'n/a', '(n/a)', 'nothing'])

/**
 * Patterns matching the harness's own injected boilerplate rather than project memory.
 *
 * This is not hypothetical tidiness. A compaction summary is written by a model that
 * has read the whole transcript, so its "Critical Context" section routinely restates
 * the session's scaffolding: the runtime-context preamble, the checkpoint header, this
 * plugin's own recall block, the skill catalog notice. Those strings are *about* the
 * session, not about the project, and once stored they are recalled forever — they
 * never expire, they crowd the budget, and they are the ones most likely to be
 * re-extracted into further copies because the next summary contains them again.
 *
 * A false negative here costs nothing: the real content of the sentence is kept
 * elsewhere in the same section. A false positive costs a genuinely useful atom, so
 * these patterns are anchored and specific.
 */
const BOILERPLATE_PATTERNS = Object.freeze([
  /^current runtime context\b/i,
  /^this is an automatically generated checkpoint\b/i,
  /^recalled project memory\b/i,
  /^project memory for\b/i,
  /^this block is durable project memory\b/i,
  /^you are the team lead named\b/i,
  /^the available skill catalog changed\b/i,
  /^instructions from:\s/i,
  /^<\/?compacted-summary>/i,
  /^the following (?:tools|skills) are available\b/i,
])

/**
 * Decide whether a statement is the harness talking about the session rather than the
 * project talking about itself.
 * @param {string} text - a candidate statement.
 * @returns {boolean} whether it should be dropped.
 */
export function isBoilerplate(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return true
  return BOILERPLATE_PATTERNS.some((pattern) => pattern.test(trimmed))
}

/** Paths inside atom text, used to attach an atom to the files it concerns. */
const PATH_PATTERN = /(?:[A-Za-z]:)?[\\/]?(?:[\w.@-]+[\\/])+[\w.@-]+\.[A-Za-z0-9]{1,8}\b/g

/** Inline code spans, which usually hold the identifiers worth keeping verbatim. */
const CODE_SPAN = /`([^`\n]{1,120})`/g

/**
 * Split a Markdown document into `##` sections.
 *
 * Only level-two headings are honored: the compactor's directive fixes that
 * level, and honoring deeper headings would fragment one statement across
 * several sections.
 *
 * @param {string} text - the summary or any Markdown.
 * @returns {{ heading: string | null, body: string }[]} sections in order.
 */
export function splitSections(text) {
  /** @type {{ heading: string | null, body: string }[]} */
  const sections = []
  let heading = null
  let body = []
  for (const line of String(text).split('\n')) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (match !== null) {
      if (heading !== null || body.some((entry) => entry.trim() !== '')) {
        sections.push({ heading, body: body.join('\n') })
      }
      heading = match[1].trim()
      body = []
      continue
    }
    body.push(line)
  }
  if (heading !== null || body.some((entry) => entry.trim() !== '')) sections.push({ heading, body: body.join('\n') })
  return sections
}

/**
 * Split a section body into individual statements.
 *
 * Bullets are the documented format, but a model occasionally writes a
 * paragraph; both are handled, and a continuation line is joined to the bullet
 * above it so a wrapped sentence is not chopped in half.
 *
 * @param {string} body - section body.
 * @returns {string[]} statements.
 */
export function splitStatements(body) {
  /** @type {string[]} */
  const statements = []
  let current = null
  for (const rawLine of String(body).split('\n')) {
    const line = rawLine.trimEnd()
    if (line.trim() === '') {
      if (current !== null) {
        statements.push(current)
        current = null
      }
      continue
    }
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (bullet !== null) {
      if (current !== null) statements.push(current)
      current = bullet[1]
      continue
    }
    if (current === null) current = line.trim()
    else current = `${current} ${line.trim()}`
  }
  if (current !== null) statements.push(current)
  return statements
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '' && !EMPTY_MARKERS.has(statement.toLowerCase()))
    .filter((statement) => !isBoilerplate(statement))
}

/**
 * Classify one statement into an atom kind.
 *
 * @param {string} statement - the statement text.
 * @param {string | null} heading - its section heading, lowercased.
 * @returns {string} an entry of `ATOM_KINDS`.
 */
export function classifyStatement(statement, heading) {
  for (const cue of KIND_CUES) {
    if (cue.pattern.test(statement)) return cue.kind
  }
  if (heading !== null && SECTION_KINDS[heading] !== undefined) return SECTION_KINDS[heading]
  return 'fact'
}

/**
 * Collect file paths mentioned by a statement, as project-relative posix paths.
 *
 * A Windows drive prefix is dropped because the atom belongs to this project, and
 * an absolute path in a memory atom would be wrong the moment the repository
 * moves.
 *
 * @param {string} statement - the statement text.
 * @returns {string[]} normalized paths.
 */
export function extractPaths(statement) {
  /** @type {string[]} */
  const paths = []
  const matches = String(statement).match(PATH_PATTERN)
  if (matches === null) return paths
  for (const match of matches) {
    const normalized = match.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').replace(/^\/+/, '')
    if (normalized === '' || normalized.length > 200) continue
    if (paths.length >= 8) break
    if (!paths.includes(normalized)) paths.push(normalized)
  }
  return paths
}

/**
 * Collect inline code spans, which carry the identifiers a statement is about.
 * @param {string} statement - the statement text.
 * @returns {string[]} code spans, bounded.
 */
export function extractCodeSpans(statement) {
  const spans = []
  for (const match of String(statement).matchAll(CODE_SPAN)) {
    const value = match[1].trim()
    if (value === '') continue
    if (spans.length >= 10) break
    if (!spans.includes(value)) spans.push(value)
  }
  return spans
}

/**
 * Turn one statement into an atom candidate.
 *
 * @param {string} statement - statement text.
 * @param {{ heading?: string | null, weight?: number, confidence?: number, tags?: string[] }} [context] - classification context.
 * @returns {object | null} an atom candidate, or null when nothing survives normalization.
 */
export function atomFromStatement(statement, context = {}) {
  const heading = typeof context.heading === 'string' ? context.heading.toLowerCase() : null
  const text = normalizeAtomText(statement)
  if (text === '') return null
  const kind = classifyStatement(text, heading)
  const files = extractPaths(text)
  const code = extractCodeSpans(text)
  const tags = []
  if (heading !== null && heading !== '') tags.push(heading)
  for (const span of code.slice(0, 4)) tags.push(span)
  return {
    kind: ATOM_KINDS.includes(kind) ? kind : 'fact',
    text,
    files,
    tags,
    weight: typeof context.weight === 'number' ? context.weight : USER_SECTIONS.has(heading ?? '') ? 4 : 2,
    confidence: typeof context.confidence === 'number' ? context.confidence : 0.7,
  }
}

/**
 * Extract atom candidates from a compaction summary.
 *
 * The result preserves section order because the compactor writes the most
 * load-bearing material first (intent, then context), and a later tie in the gate
 * should prefer the earlier statement.
 *
 * @param {{
 *   summary: string,
 *   compactionId?: string | null,
 *   sessionId?: string | null,
 *   maxAtoms?: number,
 *   maxChars?: number,
 * }} input - the summary and its provenance.
 * @returns {{ atoms: object[], sections: { heading: string | null, statements: number, atoms: number }[], skipped: number }} extraction result.
 */
export function extractFromSummary(input) {
  const maxAtoms = input.maxAtoms ?? 80
  const maxChars = input.maxChars ?? 480
  /** @type {object[]} */
  const atoms = []
  /** @type {{ heading: string | null, statements: number, atoms: number }[]} */
  const sections = []
  let skipped = 0

  for (const section of splitSections(input.summary)) {
    const statements = splitStatements(section.body)
    let emitted = 0
    for (const statement of statements) {
      if (atoms.length >= maxAtoms) {
        skipped += 1
        continue
      }
      if (statement.length > maxChars * 3) {
        // A statement this long is a pasted transcript, not a memory. Splitting it
        // would smuggle arbitrary content past the length contract, so it is left
        // out rather than truncated into something misleading.
        skipped += 1
        continue
      }
      const atom = atomFromStatement(statement, { heading: section.heading })
      if (atom === null) {
        skipped += 1
        continue
      }
      // Provenance travels with the atom because it is what lets a later reader
      // tell a durable rule from a sentence the summarizer happened to write.
      atoms.push({
        ...atom,
        source: {
          sessionId: input.sessionId ?? null,
          compactionId: input.compactionId ?? null,
          seq: null,
        },
      })
      emitted += 1
    }
    if (statements.length > 0) sections.push({ heading: section.heading, statements: statements.length, atoms: emitted })
  }

  return { atoms, sections, skipped }
}

/**
 * Recognize a user message that states a durable rule.
 *
 * This is the second source of atoms and the reason they are worth keeping: a
 * correction ("no, always use the pnpm bundled with the harness") survives even
 * when the turn that contained it is compacted away. The filter is intentionally
 * narrow — imperative-with-cue phrasing only — because a false positive here
 * would inject a fabricated rule into every later turn.
 *
 * @param {string} text - the message text.
 * @returns {object | null} an atom candidate, or null when the message is not a rule.
 */
export function atomFromUserRule(text) {
  const normalized = normalizeAtomText(text)
  if (normalized === '') return null
  if (normalized.length < 12) return null
  // The harness injects its own user-role messages (recall blocks, runtime context,
  // checkpoint headers). Those are not the user speaking, so they must never be
  // harvested as a rule the user stated.
  if (isBoilerplate(normalized)) return null
  // Questions and task requests are not rules, even when they contain "must".
  if (/[?？]\s*$/.test(normalized)) return null
  const cue = KIND_CUES.find((entry) => (entry.kind === 'constraint' || entry.kind === 'preference') && entry.pattern.test(normalized))
  if (cue === undefined) return null
  return atomFromStatement(normalized, { heading: null, weight: 5, confidence: 0.8 })
}

/**
 * Extract atom candidates from a batch of session-log facts.
 *
 * Kept separate from the summary parser so the caller decides which facts count
 * as evidence: the live session event stream during a turn, or a session's stored
 * log at startup.
 *
 * @param {{ type: string, data?: any }[]} events - session events in order.
 * @param {{ maxAtoms?: number, sessionId?: string | null }} [options] - extraction limits.
 * @returns {{ atoms: object[], considered: number }} extraction result.
 */
export function extractFromEvents(events, options = {}) {
  const maxAtoms = options.maxAtoms ?? 24
  /** @type {object[]} */
  const atoms = []
  let considered = 0
  for (const event of events) {
    if (atoms.length >= maxAtoms) break
    if (event?.type !== 'user/message') continue
    const blocks = event.data?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block?.type !== 'text') continue
      considered += 1
      const atom = atomFromUserRule(block.text)
      if (atom === null) continue
      atom.source = {
        sessionId: options.sessionId ?? null,
        compactionId: null,
        seq: Number.isSafeInteger(event.seq) ? event.seq : null,
      }
      atoms.push(atom)
      if (atoms.length >= maxAtoms) break
    }
  }
  return { atoms, considered }
}

/**
 * Attach provenance to extracted atoms.
 *
 * @param {object[]} atoms - atom candidates.
 * @param {{ sessionId?: string | null, compactionId?: string | null, seq?: number | null }} source - where they came from.
 * @returns {object[]} atoms carrying `source`.
 */
export function withSource(atoms, source) {
  return atoms.map((atom) => ({
    ...atom,
    source: {
      sessionId: source.sessionId ?? null,
      compactionId: source.compactionId ?? null,
      seq: source.seq ?? null,
    },
  }))
}
