/**
 * Front-matter parsing and document classification.
 *
 * Documents are Markdown with an optional YAML-ish front-matter block. A full
 * YAML parser is deliberately avoided: this plugin only needs flat scalar keys
 * and simple string lists, and a wrong-but-valid YAML edge case must not be able
 * to break an index build. Anything unparsable is reported as `malformed` and
 * the document still indexes with default metadata.
 *
 * Pure Node; no DSH import.
 */

/** Keys this plugin interprets. Everything else is preserved in `extra`. */
export const KNOWN_KEYS = Object.freeze(['title', 'status', 'kind', 'tags', 'supersedes', 'supersededBy', 'owner'])

/** Recognized statuses, in precedence order for conflict reporting. */
export const STATUSES = Object.freeze(['current', 'accepted', 'proposal', 'deprecated', 'history', 'draft'])

/** Recognized document kinds. */
export const KINDS = Object.freeze(['spec', 'guide', 'decision', 'proposal', 'history', 'readme', 'reference'])

/**
 * Split a Markdown document into front matter and body.
 *
 * A front-matter block starts on the first line with exactly `---` and ends at
 * the next line that is exactly `---`. A document that opens the fence and never
 * closes it is reported as malformed rather than swallowing the whole file.
 *
 * @param {string} text - document text.
 * @returns {{ ok: true, frontMatter: string | null, body: string, bodyLine: number } | { ok: false, reason: string }} the split.
 */
export function splitFrontMatter(text) {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) {
    return { ok: true, frontMatter: null, body: normalized, bodyLine: 1 }
  }
  const lines = normalized.split('\n')
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      return {
        ok: true,
        frontMatter: lines.slice(1, index).join('\n'),
        body: lines.slice(index + 1).join('\n'),
        bodyLine: index + 2,
      }
    }
  }
  return { ok: false, reason: 'front matter opens with --- but is never closed' }
}

/**
 * Parse a flat front-matter block into an object.
 *
 * Supported forms: `key: value`, `key: [a, b]`, and a `key:` line followed by
 * `  - item` lines. Nested objects are not supported and are reported in
 * `unsupported` instead of being silently misread.
 *
 * @param {string} block - the text between the fences.
 * @returns {{ values: Record<string, string | string[]>, unsupported: string[] }} parsed values.
 */
export function parseFrontMatter(block) {
  /** @type {Record<string, string | string[]>} */
  const values = {}
  const unsupported = []
  const lines = block.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (/^\s+-\s+/.test(line)) continue // handled with its parent key below
    const match = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line)
    if (match === null) {
      unsupported.push(line.trim())
      continue
    }
    const key = match[1]
    const rawValue = match[2].trim()

    if (rawValue === '') {
      const items = []
      for (let look = index + 1; look < lines.length; look += 1) {
        const item = /^\s+-\s+(.*)$/.exec(lines[look])
        if (item === null) break
        items.push(unquote(item[1].trim()))
        index = look
      }
      values[key] = items
      continue
    }
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const inner = rawValue.slice(1, -1).trim()
      values[key] = inner === ''
        ? []
        : inner.split(',').map((entry) => unquote(entry.trim())).filter((entry) => entry !== '')
      continue
    }
    if (rawValue.startsWith('{')) {
      unsupported.push(`${key}: nested mappings are not supported`)
      continue
    }
    values[key] = unquote(rawValue)
  }
  return { values, unsupported }
}

/** Strip a matching pair of quotes. */
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}

/**
 * Derive document metadata from its directory.
 *
 * Directory rules come second: explicit front matter always wins. The mapping
 * mirrors the documented layout, so a file dropped into `docs/proposals/`
 * cannot claim to be an approved decision by omission.
 *
 * @param {string} relative - project-relative path with forward slashes.
 * @returns {{ status: string, kind: string }} the inferred classification.
 */
export function classifyByPath(relative) {
  const lowered = relative.toLowerCase()
  const segments = lowered.split('/')
  const file = segments[segments.length - 1] ?? ''
  if (segments.some((segment) => segment === 'proposals' || segment === 'proposal')) {
    return { status: 'proposal', kind: 'proposal' }
  }
  if (segments.some((segment) => segment === 'adr' || segment === 'decisions' || segment === 'decision')) {
    return { status: 'accepted', kind: 'decision' }
  }
  if (segments.some((segment) => segment === 'history' || segment === 'archive' || segment === 'archived')) {
    return { status: 'history', kind: 'history' }
  }
  if (file === 'agents.md' || file === 'claude.md' || file === 'contributing.md' || file === 'code_of_conduct.md') {
    return { status: 'current', kind: 'guide' }
  }
  if (file === 'readme.md') return { status: 'current', kind: 'readme' }
  if (file === 'changelog.md') return { status: 'history', kind: 'history' }
  return { status: 'current', kind: 'spec' }
}

/**
 * Extract the heading outline of a document body.
 *
 * Fenced code blocks are skipped so a `#` comment inside a shell snippet does
 * not become a heading.
 *
 * @param {string} body - Markdown body without front matter.
 * @param {{ max?: number }} [options] - how many headings to keep.
 * @returns {{ text: string, level: number, line: number }[]} the headings, in order.
 */
export function extractHeadings(body, options = {}) {
  const max = options.max ?? 50
  const headings = []
  let fence = null
  const lines = body.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line)
    if (fenceMatch !== null) {
      if (fence === null) fence = fenceMatch[1][0]
      else if (fenceMatch[1][0] === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(line)
    if (heading === null) continue
    headings.push({ text: heading[2].trim(), level: heading[1].length, line: index + 1 })
    if (headings.length >= max) break
  }
  return headings
}

/**
 * Parse one Markdown document into index metadata.
 *
 * Never throws: an unparsable front matter block yields defaults plus a warning,
 * because one bad file must not prevent the project's knowledge from loading.
 *
 * @param {{ relative: string, text: string, size?: number, mtime?: number | null }} input - the document.
 * @returns {{
 *   relative: string, title: string, status: string, kind: string, tags: string[],
 *   headings: { text: string, level: number, line: number }[],
 *   supersedes: string | null, supersededBy: string | null, owner: string | null,
 *   hasFrontMatter: boolean, warnings: string[], bodyChars: number, size: number | null, mtime: number | null,
 * }} the parsed document.
 */
export function parseDocument(input) {
  const warnings = []
  const split = splitFrontMatter(input.text)
  let values = /** @type {Record<string, string | string[]>} */ ({})
  let body = input.text
  let hasFrontMatter = false
  if (!split.ok) {
    warnings.push(split.reason)
  } else {
    body = split.body
    if (split.frontMatter !== null) {
      hasFrontMatter = true
      const parsed = parseFrontMatter(split.frontMatter)
      values = parsed.values
      for (const warning of parsed.unsupported) warnings.push(`unsupported front matter: ${warning}`)
    }
  }

  const inferred = classifyByPath(input.relative)
  const headings = extractHeadings(body)
  const firstHeading = headings.find((heading) => heading.level === 1) ?? headings[0]
  const rawTitle = typeof values.title === 'string' && values.title.trim() !== '' ? values.title.trim() : null
  const title = rawTitle ?? firstHeading?.text ?? input.relative.split('/').pop() ?? input.relative

  const rawStatus = typeof values.status === 'string' ? values.status.trim().toLowerCase() : ''
  const status = STATUSES.includes(rawStatus) ? rawStatus : inferred.status
  if (rawStatus !== '' && !STATUSES.includes(rawStatus)) {
    warnings.push(`unknown status "${rawStatus}" is treated as "${inferred.status}"`)
  }
  const rawKind = typeof values.kind === 'string' ? values.kind.trim().toLowerCase() : ''
  const kind = KINDS.includes(rawKind) ? rawKind : inferred.kind
  if (rawKind !== '' && !KINDS.includes(rawKind)) {
    warnings.push(`unknown kind "${rawKind}" is treated as "${inferred.kind}"`)
  }

  const tags = Array.isArray(values.tags)
    ? values.tags.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
    : typeof values.tags === 'string' && values.tags.trim() !== ''
      ? values.tags.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
      : []

  return {
    relative: input.relative,
    title,
    status,
    kind,
    tags,
    headings,
    supersedes: typeof values.supersedes === 'string' ? values.supersedes.trim() : null,
    supersededBy: typeof values.supersededBy === 'string' ? values.supersededBy.trim() : null,
    owner: typeof values.owner === 'string' ? values.owner.trim() : null,
    hasFrontMatter,
    warnings,
    bodyChars: body.length,
    size: input.size ?? null,
    mtime: input.mtime ?? null,
  }
}
