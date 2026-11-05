/**
 * System A — the documentation index.
 *
 * The index is a **derived cache**, never a source of truth: deleting
 * `.dsh-memory/index.json` loses nothing, and every field can be recomputed from
 * the Markdown files. It exists so a session can learn a project's document
 * shape without reading thousands of files.
 *
 * Design constraints that come from real large projects:
 * - A scan must be bounded (`maxDocuments`, per-file byte cap) and must never
 *   follow a directory symlink out of the project.
 * - One unreadable file degrades that entry, never the whole index.
 * - Re-indexing compares content hashes so unchanged documents keep their entry.
 *
 * Pure Node; no DSH import.
 */

import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { toPosix } from './paths.js'
import { parseDocument } from './frontmatter.js'
import { readJson, readText, writeJsonAtomic } from './store.js'
import { MEMORY_DIR } from './paths.js'

/** Current index schema version. */
export const INDEX_SCHEMA = 1

/** Index file, project-relative. */
export const INDEX_FILE = `${MEMORY_DIR}/index.json`

/** Directories never descended into during a scan. */
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.dsh-memory', 'dist', 'build', 'Library', 'Temp', 'obj', '.idea', '.vscode'])

/**
 * Decide whether one project-relative path should be indexed.
 *
 * An include list is checked first (a file must look like project knowledge),
 * then the exclude list. `AGENTS.md`, `README.md`, and `CHANGELOG.md` are matched
 * exactly because they sit at the root.
 *
 * @param {string} relative - project-relative path with forward slashes.
 * @param {{ includePrefixes: readonly string[], excludePrefixes: readonly string[] }} settings - normalized settings.
 * @returns {boolean} whether to index it.
 */
export function shouldIndex(relative, settings) {
  if (!relative.toLowerCase().endsWith('.md')) return false
  for (const excluded of settings.excludePrefixes) {
    if (relative === excluded || relative.startsWith(excluded.endsWith('/') ? excluded : `${excluded}/`)) return false
  }
  for (const included of settings.includePrefixes) {
    if (included.endsWith('/')) {
      if (relative.startsWith(included)) return true
    } else if (relative === included) {
      return true
    }
  }
  return false
}

/**
 * Walk the project to collect candidate Markdown files.
 *
 * Symbolic links are recorded but never traversed, so a link to a directory
 * outside the project cannot pull foreign content into the index. Depth and
 * count are both bounded.
 *
 * @param {{ root: string, settings: any, maxDepth?: number }} input - scan inputs.
 * @returns {{ files: { relative: string, absolute: string, size: number, mtime: number }[], skipped: number, truncated: boolean }} the candidates.
 */
export function collectDocuments(input) {
  const maxDepth = input.maxDepth ?? 12
  const files = []
  let skipped = 0
  let truncated = false
  const queue = [{ directory: input.root, depth: 0 }]

  while (queue.length > 0 && !truncated) {
    const current = queue.shift()
    let entries
    try {
      entries = readdirSync(current.directory, { withFileTypes: true })
    } catch {
      skipped += 1
      continue
    }
    for (const entry of entries) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      const absolute = path.join(current.directory, entry.name)
      const relative = toPosix(path.relative(input.root, absolute))
      if (entry.isSymbolicLink()) {
        skipped += 1
        continue
      }
      if (entry.isDirectory()) {
        if (current.depth + 1 <= maxDepth && shouldDescend(relative, input.settings)) {
          queue.push({ directory: absolute, depth: current.depth + 1 })
        }
        continue
      }
      if (!entry.isFile() || !shouldIndex(relative, input.settings)) continue
      let stat
      try {
        stat = statSync(absolute)
      } catch {
        skipped += 1
        continue
      }
      if (stat.size > input.settings.maxDocumentBytes) {
        skipped += 1
        continue
      }
      files.push({ relative, absolute, size: stat.size, mtime: Math.trunc(stat.mtimeMs) })
      if (files.length >= input.settings.maxDocuments) {
        truncated = true
        break
      }
    }
  }
  files.sort((left, right) => left.relative.localeCompare(right.relative))
  return { files, skipped, truncated }
}

/**
 * Whether a directory can possibly contain indexed documents.
 *
 * A directory is descended when it is a prefix of an include entry, or when the
 * index path is unrestricted (`docs/` style prefixes make this cheap). Unknown
 * trees are still walked because include lists are prefixes, not literal paths.
 *
 * @param {string} relative - candidate directory.
 * @param {{ includePrefixes: readonly string[], excludePrefixes: readonly string[] }} settings - settings.
 * @returns {boolean} whether to descend.
 */
function shouldDescend(relative, settings) {
  for (const excluded of settings.excludePrefixes) {
    if (relative === excluded.replace(/\/$/, '') || relative.startsWith(excluded.endsWith('/') ? excluded : `${excluded}/`)) {
      return false
    }
  }
  return true
}

/**
 * Hash a document body for change detection.
 * @param {string} text - document text.
 * @returns {string} short hex digest.
 */
export function documentHash(text) {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12)
}

/**
 * Build (or refresh) the document index for a project.
 *
 * @param {{ root: string, settings: any, previous?: any }} input - build inputs.
 * @returns {{ ok: true, index: object, stats: { total: number, added: number, changed: number, unchanged: number, removed: number, skipped: number, truncated: boolean, warnings: number } } | { ok: false, reason: string }} the index.
 */
export function buildIndex(input) {
  const collected = collectDocuments({ root: input.root, settings: input.settings })
  const previousByPath = new Map()
  if (input.previous?.documents !== undefined && Array.isArray(input.previous.documents)) {
    for (const entry of input.previous.documents) {
      if (typeof entry?.path === 'string') previousByPath.set(entry.path, entry)
    }
  }

  const documents = []
  let added = 0
  let changed = 0
  let unchanged = 0
  let warnings = 0
  for (const file of collected.files) {
    const read = readText(file.absolute)
    if (!read.ok) {
      warnings += 1
      continue
    }
    const hash = documentHash(read.text)
    const previous = previousByPath.get(file.relative)
    if (previous === undefined) added += 1
    else if (previous.hash !== hash) changed += 1
    else unchanged += 1
    const parsed = parseDocument({ relative: file.relative, text: read.text, size: file.size, mtime: file.mtime })
    documents.push({
      path: file.relative,
      title: parsed.title,
      status: parsed.status,
      kind: parsed.kind,
      tags: parsed.tags,
      headings: parsed.headings.map((heading) => heading.text),
      hash,
      size: file.size,
      mtime: file.mtime,
      supersedes: parsed.supersedes,
      supersededBy: parsed.supersededBy,
      owner: parsed.owner,
      hasFrontMatter: parsed.hasFrontMatter,
      warnings: parsed.warnings,
    })
  }

  const currentPaths = new Set(documents.map((entry) => entry.path))
  const removed = [...previousByPath.keys()].filter((key) => !currentPaths.has(key)).length

  const index = {
    schema: INDEX_SCHEMA,
    builtAt: new Date().toISOString(),
    documentCount: documents.length,
    documents,
  }
  return {
    ok: true,
    index,
    stats: {
      total: documents.length,
      added,
      changed,
      unchanged,
      removed,
      skipped: collected.skipped,
      truncated: collected.truncated,
      warnings: warnings + documents.filter((entry) => entry.warnings.length > 0).length,
    },
  }
}

/**
 * Read the persisted index, if any.
 * @param {string} root - project root.
 * @returns {{ ok: boolean, index: any | null, reason?: string }} the index or why it is missing.
 */
export function readIndex(root) {
  const result = readJson(path.join(root, INDEX_FILE))
  if (!result.ok) return { ok: false, index: null, reason: result.reason }
  const value = result.value
  if (value === null || typeof value !== 'object' || !Array.isArray(value.documents)) {
    return { ok: false, index: null, reason: 'invalid' }
  }
  return { ok: true, index: value }
}

/**
 * Persist an index atomically.
 * @param {string} root - project root.
 * @param {object} index - the index document.
 * @returns {{ ok: true } | { ok: false, reason: string }} the outcome.
 */
export function writeIndex(root, index) {
  const result = writeJsonAtomic(path.join(root, INDEX_FILE), index)
  if (!result.ok) return { ok: false, reason: `cannot write index: ${result.error?.message ?? result.error}` }
  return { ok: true }
}

/**
 * Ensure an index exists, rebuilding it when absent or stale.
 *
 * Staleness is judged by document count and the newest mtime, which is cheap and
 * catches the common cases; `memory_status` reports the exact build time so a
 * user can force a rebuild when they suspect drift.
 *
 * @param {{ root: string, settings: any, force?: boolean }} input - request.
 * @returns {{ ok: true, index: object, rebuilt: boolean, stats?: object } | { ok: false, reason: string }} the index.
 */
export function ensureIndex(input) {
  const existing = input.force === true ? { ok: false, index: null, reason: 'forced' } : readIndex(input.root)
  if (existing.ok) return { ok: true, index: existing.index, rebuilt: false }

  const built = buildIndex({ root: input.root, settings: input.settings, previous: existing.index })
  if (!built.ok) return built
  const written = writeIndex(input.root, built.index)
  if (!written.ok) return { ok: true, index: built.index, rebuilt: true, stats: built.stats }
  return { ok: true, index: built.index, rebuilt: true, stats: built.stats }
}
