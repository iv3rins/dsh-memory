/**
 * Per-project setting overrides.
 *
 * The plugin has always had one settings object for the whole profile. That is right
 * for things a person decides once — budgets, include prefixes — and wrong for the
 * router: which model reviews recall, and what it should prioritise, is a property of
 * the work in front of you, not of the editor. A documentation repository wants
 * `compliance`; a greenfield build wants `task`; a codebase you are reading for the
 * first time wants `orient`.
 *
 * So settings come in two layers:
 *
 *   profile settings  (the plugin config, edited by the Loader)
 *     └─ project override  (stored here, keyed by canonical root)
 *
 * The effective value is the override when present, the profile value otherwise. An
 * override that is removed falls back rather than freezing a copy — that is the whole
 * difference between an override and a snapshot, and it is why the stored shape keeps
 * only the keys that were actually changed.
 *
 * Where this lives: `.dsh-memory/settings/<id>.json` inside each project, next to the
 * memory it governs. Two consequences worth stating, because both are load-bearing:
 *
 * - **A project carries its own routing.** Move the checkout, or open it on another
 *   machine with the same plugin, and the router choice travels with the memory. A
 *   profile-level store would silently lose it.
 * - **Nothing is written outside a project you can see.** Discovering a new project
 *   never mutates it; a file appears only when the user changes a setting while that
 *   project is selected.
 *
 * @module @dsh-project-memory/core/projects
 */

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { MEMORY_DIR, toPosix } from './paths.js'
import { writeJsonAtomic } from './store.js'

/**
 * Settings a project may override.
 *
 * Deliberately narrow. `l0Budget`, `includePrefixes`, `protectedPaths` and friends
 * configure *this profile's* view of every repository at once; letting one project
 * raise another's write ceiling would make the guard depend on which panel tab was
 * last open. The router settings are the ones that genuinely differ per project.
 */
export const OVERRIDABLE = Object.freeze([
  'routerTier',
  'routerStrategy',
  'routerProvider',
  'routerModel',
  'recallBudget',
  'recallLimit',
])

/** Directory under `.dsh-memory/` holding one override file per project. */
export const SETTINGS_DIR = 'settings'

/**
 * Turn any path into the key an override is stored under.
 *
 * The key has to be stable across spellings of the same directory (`D:\x`,
 * `D:/x`, `d:\x`) or a user who types the path differently gets a different
 * routing configuration for the same repository. Lowercasing is Windows-only
 * because on Linux `src` and `SRC` are genuinely different directories.
 *
 * @param {string} root - absolute project root.
 * @returns {string} a canonical, filename-safe key.
 */
export function projectKey(root) {
  const normalized = toPosix(path.resolve(String(root)))
  const cased = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  // A drive letter carries a colon, which is legal in a filename on Windows only in
  // the drive position — not in the middle of a name. Replace the separator rather
  // than risk an invalid path, and strip the leading slash so the name is relative.
  return cased.replace(/^\/+/, '').replace(/[:/\\]+/g, '-').replace(/-+/g, '-')
}

/**
 * Read one project's overrides.
 *
 * A missing file is the ordinary case and returns `{}`. A malformed one is reported
 * rather than silently discarded: the user asked for a routing configuration and is
 * entitled to know it is not in effect.
 *
 * @param {string} root - absolute project root.
 * @returns {{ ok: boolean, values: Record<string, unknown>, reason: string | null, file: string }}
 */
export function readOverrides(root) {
  const file = path.join(root, MEMORY_DIR, SETTINGS_DIR, `${projectKey(root)}.json`)
  if (!existsSync(file)) return { ok: true, values: {}, reason: null, file }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const source = parsed !== null && typeof parsed === 'object' && parsed.values !== null && typeof parsed.values === 'object'
      ? parsed.values
      : parsed
    /** @type {Record<string, unknown>} */
    const values = {}
    if (source !== null && typeof source === 'object') {
      for (const key of OVERRIDABLE) {
        if (Object.prototype.hasOwnProperty.call(source, key)) values[key] = source[key]
      }
    }
    return { ok: true, values, reason: null, file }
  } catch (error) {
    return {
      ok: false,
      values: {},
      reason: `stored settings could not be read: ${error instanceof Error ? error.message : String(error)}`,
      file,
    }
  }
}

/**
 * Merge a project's overrides over the profile settings.
 *
 * The result is a complete settings object, so every caller keeps reading
 * `settings.routerModel` without knowing this layer exists. `overridden` names the keys
 * that came from the project, which is what lets the panel mark a field as
 * project-specific instead of leaving the user wondering why a global edit did nothing.
 *
 * @param {object} base - profile-level normalized settings.
 * @param {string | null} root - project root, or null for no project.
 * @returns {{ settings: object, overridden: string[], reason: string | null }}
 */
export function effectiveSettings(base, root) {
  if (root === null) return { settings: base, overridden: [], reason: null }
  const stored = readOverrides(root)
  if (stored.ok !== true) return { settings: base, overridden: [], reason: stored.reason }
  /** @type {any} */
  const merged = { ...base }
  const overridden = []
  for (const key of OVERRIDABLE) {
    if (!Object.prototype.hasOwnProperty.call(stored.values, key)) continue
    merged[key] = stored.values[key]
    overridden.push(key)
  }
  return { settings: merged, overridden, reason: null }
}

/**
 * Write one override for one project.
 *
 * A value equal to the profile value is stored as an override rather than deleted.
 * That is intentional: "this project uses `task` even though the profile says
 * `compliance`" has to survive a later global edit, and silently deleting the entry
 * would make the project follow the next global change instead of the user's decision.
 * Removing an override is a separate, explicit action (`value: null`).
 *
 * @param {{ root: string, key: string, value: unknown, logger?: { warn: Function } }} input - what to write.
 * @returns {{ ok: boolean, reason: string | null, overridden: string[] }}
 */
export function writeOverride(input) {
  const { root, key, value } = input
  if (!OVERRIDABLE.includes(key)) {
    return { ok: false, reason: `"${key}" is not a per-project setting`, overridden: [] }
  }
  const current = readOverrides(root)
  if (current.ok !== true) {
    // Overwriting a file we could not parse would destroy whatever the user had.
    return { ok: false, reason: current.reason ?? 'stored settings are unreadable', overridden: [] }
  }
  /** @type {Record<string, unknown>} */
  const next = { ...current.values }
  if (value === null) delete next[key]
  else next[key] = value

  const overridden = OVERRIDABLE.filter((candidate) => Object.prototype.hasOwnProperty.call(next, candidate))
  try {
    if (overridden.length === 0) {
      // Nothing left to override. Leaving an empty file behind would read as a
      // configuration someone intended; removing it restores the profile defaults
      // honestly, which is what an empty override set means.
      if (existsSync(current.file)) rmSync(current.file, { force: true })
    } else {
      writeJsonAtomic(current.file, { schema: 1, root: path.resolve(root), values: next })
    }
  } catch (error) {
    return {
      ok: false,
      reason: `could not save: ${error instanceof Error ? error.message : String(error)}`,
      overridden: [],
    }
  }
  return { ok: true, reason: null, overridden }
}

/**
 * Describe one project for the panel's picker.
 *
 * `atoms` and `lastCompactionAt` are the two facts that let a person tell two
 * checkouts of the same repository apart at a glance, so they are read here rather
 * than fetched per row later.
 *
 * @param {string} root - absolute project root.
 * @returns {object} a serializable row.
 */
export function describeProject(root) {
  const resolved = path.resolve(root)
  const memoryDir = path.join(resolved, MEMORY_DIR)
  const atomsFile = path.join(memoryDir, 'memory', 'atoms.jsonl')
  /** @type {number} */
  let atoms = 0
  /** @type {string | null} */
  let lastCompactionAt = null
  try {
    if (existsSync(atomsFile)) {
      const text = readFileSync(atomsFile, 'utf8')
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          const row = JSON.parse(line)
          if (row !== null && typeof row === 'object' && row.forgotten !== true) atoms += 1
        } catch {
          // A malformed line is counted by the panel's own reader, not here.
        }
      }
    }
    const ledger = path.join(memoryDir, 'state', 'compactions.jsonl')
    if (existsSync(ledger)) {
      const rows = readFileSync(ledger, 'utf8').split('\n').filter((line) => line.trim() !== '')
      if (rows.length > 0) {
        const parsed = JSON.parse(rows[rows.length - 1])
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.at === 'string') lastCompactionAt = parsed.at
      }
    }
  } catch {
    // A project row that cannot be summarised is still a project that can be opened.
  }
  const overrides = readOverrides(resolved)
  return {
    root: resolved,
    name: path.basename(resolved),
    key: projectKey(resolved),
    atoms,
    lastCompactionAt,
    overridden: OVERRIDABLE.filter((candidate) => Object.prototype.hasOwnProperty.call(overrides.values, candidate)),
    hasMemory: existsSync(memoryDir),
  }
}

/**
 * Find every project this machine knows about.
 *
 * A project is "known" when it has a `.dsh-memory/` directory, which is the same
 * condition the tools use to decide whether a directory is a project at all. Roots are
 * supplied by the caller because only the Host knows which directories sessions have
 * used; this function does not walk the filesystem looking for repositories, which
 * would make opening the panel an unbounded disk scan.
 *
 * @param {Array<{ root: string, lastSeen?: string | null, current?: boolean }>} roots - candidate roots, most relevant first.
 * @returns {object[]} one row per distinct project, deduplicated by canonical key.
 */
export function listProjects(roots) {
  /** @type {Map<string, object>} */
  const seen = new Map()
  for (const candidate of roots) {
    if (candidate === null || typeof candidate !== 'object') continue
    if (typeof candidate.root !== 'string' || candidate.root.trim() === '') continue
    const resolved = path.resolve(candidate.root)
    const key = projectKey(resolved)
    if (seen.has(key)) {
      // A later entry only adds a timestamp; it must not reorder the list.
      const existing = /** @type {any} */ (seen.get(key))
      if (existing.lastSeen === null && typeof candidate.lastSeen === 'string') existing.lastSeen = candidate.lastSeen
      if (candidate.current === true) existing.current = true
      continue
    }
    // The cast belongs on the declaration, not on the next statement: this file has no
    // semicolons, so a line starting with `(` continues the previous expression and
    // `const row = describeProject(resolved)(row).lastSeen = …` reads `row` before it
    // exists. That threw on every call, and the panel's listProjects guard turned the
    // throw into an empty list, so the picker silently showed no projects.
    const row = /** @type {any} */ (describeProject(resolved))
    row.lastSeen = typeof candidate.lastSeen === 'string' ? candidate.lastSeen : null
    row.current = candidate.current === true
    seen.set(key, row)
  }
  return [...seen.values()]
}

/**
 * Whether a directory looks like a project owned by this plugin.
 * @param {string} root - candidate directory.
 * @returns {boolean} whether it holds a `.dsh-memory/` directory.
 */
export function isKnownProject(root) {
  try {
    return existsSync(path.join(path.resolve(String(root)), MEMORY_DIR))
  } catch {
    return false
  }
}

/**
 * Read the settings directory for diagnostics.
 * @param {string} root - absolute project root.
 * @returns {string[]} the file names present.
 */
export function settingsFiles(root) {
  try {
    return readdirSync(path.join(root, MEMORY_DIR, SETTINGS_DIR))
  } catch {
    return []
  }
}
