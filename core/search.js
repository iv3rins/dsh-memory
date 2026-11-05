/**
 * Deterministic search over the document index.
 *
 * No embeddings, no network, no randomness: the same index and query always give
 * the same ranking, which is what makes a search result defensible when it lands
 * in a model's context. Matching is token-prefix based and scoring is explained
 * per hit, so a user can see *why* a document ranked where it did.
 *
 * Pure Node; no DSH import.
 */

import { toPosix } from './paths.js'

/** Weight of each match source; higher is stronger. */
export const WEIGHTS = Object.freeze({
  titleExact: 100,
  titleToken: 40,
  tag: 30,
  heading: 18,
  pathSegment: 14,
  body: 6,
})

/** Statuses that are privileged by default because they are authoritative now. */
const CURRENT_STATUSES = new Set(['current', 'accepted'])

/**
 * Tokenize text for matching: lowercase, split on non-word characters, drop
 * single characters and a small stop list.
 *
 * @param {string} text - arbitrary text.
 * @returns {string[]} tokens.
 */
export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 1)
}

/**
 * Parse a query into required tokens and status filters.
 *
 * `status:proposal`, `kind:spec`, and `path:docs/combat` are recognized filters;
 * everything else becomes a search token.
 *
 * @param {string} query - raw user query.
 * @returns {{ tokens: string[], statuses: string[], kinds: string[], paths: string[] }} the parsed query.
 */
export function parseQuery(query) {
  /** @type {{ tokens: string[], statuses: string[], kinds: string[], paths: string[] }} */
  const parsed = { tokens: [], statuses: [], kinds: [], paths: [] }
  for (const word of String(query ?? '').split(/\s+/)) {
    if (word === '') continue
    const filter = /^(status|kind|path):(.+)$/i.exec(word)
    if (filter !== null) {
      const value = filter[2].toLowerCase()
      if (filter[1].toLowerCase() === 'status') parsed.statuses.push(value)
      else if (filter[1].toLowerCase() === 'kind') parsed.kinds.push(value)
      else parsed.paths.push(value)
      continue
    }
    parsed.tokens.push(...tokenize(word))
  }
  return parsed
}

/**
 * Score one document against a parsed query.
 *
 * @param {object} document - index entry.
 * @param {{ tokens: string[], statuses: string[], kinds: string[], paths: string[] }} query - parsed query.
 * @returns {{ score: number, reasons: string[] } | null} the score, or null when the document does not match.
 */
export function scoreDocument(document, query) {
  if (query.statuses.length > 0 && !query.statuses.includes(String(document.status).toLowerCase())) return null
  if (query.kinds.length > 0 && !query.kinds.includes(String(document.kind).toLowerCase())) return null
  if (query.paths.length > 0) {
    const relative = String(document.path).toLowerCase()
    if (!query.paths.some((prefix) => relative.includes(prefix))) return null
  }

  const reasons = []
  let score = 0
  const title = String(document.title ?? '').toLowerCase()
  const titleTokens = tokenize(title)
  const pathText = String(document.path ?? '').toLowerCase()
  const tags = Array.isArray(document.tags) ? document.tags.map((tag) => String(tag).toLowerCase()) : []
  const headings = Array.isArray(document.headings) ? document.headings.map((entry) => String(entry).toLowerCase()) : []

  for (const token of query.tokens) {
    let matched = false
    if (title === token) {
      score += WEIGHTS.titleExact
      reasons.push(`title is exactly "${token}"`)
      matched = true
    } else if (titleTokens.some((entry) => entry.startsWith(token))) {
      score += WEIGHTS.titleToken
      reasons.push(`title contains "${token}"`)
      matched = true
    }
    if (tags.some((tag) => tag === token || tag.startsWith(token))) {
      score += WEIGHTS.tag
      reasons.push(`tag "${token}"`)
      matched = true
    }
    const headingHits = headings.filter((heading) => heading.includes(token)).length
    if (headingHits > 0) {
      score += WEIGHTS.heading * Math.min(headingHits, 3)
      reasons.push(`${headingHits} heading(s) mention "${token}"`)
      matched = true
    }
    if (pathText.split(/[/\-.]/).some((segment) => segment.startsWith(token))) {
      score += WEIGHTS.pathSegment
      reasons.push(`path segment matches "${token}"`)
      matched = true
    }
    if (!matched) return null
  }

  // A query with no tokens (only filters) matches everything the filters allowed.
  if (query.tokens.length === 0) {
    score = 1
    reasons.push('matched by filter only')
  }
  if (CURRENT_STATUSES.has(String(document.status).toLowerCase())) {
    score += 5
    reasons.push('status is authoritative')
  }
  if (String(document.status).toLowerCase() === 'deprecated') {
    score -= 10
    reasons.push('status is deprecated (ranked lower)')
  }
  return { score, reasons }
}

/**
 * Search an index.
 *
 * @param {{ documents: object[] }} index - the document index.
 * @param {string} query - raw query string.
 * @param {{ limit?: number, includeDeprecated?: boolean }} [options] - result controls.
 * @returns {{ hits: { path: string, title: string, status: string, kind: string, tags: string[], score: number, reasons: string[] }[], total: number, query: object }} ranked hits.
 */
export function search(index, query, options = {}) {
  const limit = options.limit ?? 10
  const parsed = parseQuery(query)
  const includeDeprecated = options.includeDeprecated === true
  const hits = []
  for (const document of index.documents ?? []) {
    if (!includeDeprecated && parsed.statuses.length === 0 && String(document.status).toLowerCase() === 'deprecated') continue
    const scored = scoreDocument(document, parsed)
    if (scored === null) continue
    hits.push({
      path: document.path,
      title: document.title,
      status: document.status,
      kind: document.kind,
      tags: Array.isArray(document.tags) ? document.tags : [],
      score: scored.score,
      reasons: scored.reasons,
    })
  }
  hits.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    return String(left.path).localeCompare(String(right.path))
  })
  return { hits: hits.slice(0, limit), total: hits.length, query: parsed }
}

/**
 * Read one document section by heading, returning the exact source span.
 *
 * Reading by heading keeps the returned text small and traceable: the caller
 * learns which heading (and line range) the excerpt came from, so it can cite the
 * document instead of paraphrasing it.
 *
 * @param {string} text - full document text.
 * @param {{ heading?: string, maxChars?: number }} [options] - section selector.
 * @returns {{ text: string, heading: string | null, startLine: number, endLine: number, truncated: boolean, availableHeadings: string[] }} the excerpt.
 */
export function readSection(text, options = {}) {
  const normalized = text.replace(/\r\n/g, '\n')
  const maxChars = options.maxChars ?? 8000
  const lines = normalized.split('\n')
  const headings = []
  let fence = null
  for (let index = 0; index < lines.length; index += 1) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(lines[index])
    if (fenceMatch !== null) {
      if (fence === null) fence = fenceMatch[1][0]
      else if (fenceMatch[1][0] === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(lines[index])
    if (heading !== null) headings.push({ text: heading[2].trim(), level: heading[1].length, line: index })
  }
  const availableHeadings = headings.map((heading) => heading.text)

  const wanted = typeof options.heading === 'string' ? options.heading.trim().toLowerCase() : ''
  let startLine = 0
  let endLine = lines.length - 1
  let matchedHeading = null
  if (wanted !== '') {
    const found = headings.find((heading) => heading.text.toLowerCase() === wanted)
      ?? headings.find((heading) => heading.text.toLowerCase().includes(wanted))
    if (found === undefined) {
      return {
        text: '',
        heading: null,
        startLine: 0,
        endLine: 0,
        truncated: false,
        availableHeadings,
      }
    }
    matchedHeading = found.text
    startLine = found.line
    const next = headings.find((heading) => heading.line > found.line && heading.level <= found.level)
    endLine = next === undefined ? lines.length - 1 : next.line - 1
  }

  let body = lines.slice(startLine, endLine + 1).join('\n')
  let truncated = false
  if (body.length > maxChars) {
    body = `${body.slice(0, maxChars)}\n\n[truncated at ${maxChars} characters]`
    truncated = true
  }
  return {
    text: body,
    heading: matchedHeading,
    startLine: startLine + 1,
    endLine: endLine + 1,
    truncated,
    availableHeadings,
  }
}

/**
 * Normalize a project-relative path for lookup.
 * @param {string} value - a user-supplied path.
 * @returns {string} forward-slashed, no leading `./`.
 */
export function normalizeDocPath(value) {
  return toPosix(String(value).trim()).replace(/^\.\//, '')
}
