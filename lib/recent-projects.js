/**
 * The small, durable record of which projects this plugin has served.
 *
 * Why a file and not just module memory: the panel is opened from the host process,
 * and the host process is restarted whenever the user updates DSH, changes a profile,
 * or simply reboots. Every restart used to blank the record, so a panel opened before
 * any session ran answered `no-project-root` — while the project it should have been
 * looking at was sitting right there on disk with 400 atoms in it. The user's first
 * impression of the panel was "it found nothing", which is indistinguishable from
 * "your memory is gone".
 *
 * Three rules shape the store:
 *
 * 1. **Never in a project.** This is the one artifact that cannot live in
 *    `.dsh-memory/`, because it is the index of which of those directories exist. It
 *    goes under the harness home (`$DSH_HOME`, `~/.dsh` by default), which is the only
 *    location that outlives a single project.
 * 2. **Never required.** A missing, unreadable, or corrupt file is an empty list, not
 *    an error. The panel falls back to the profile setting and then to
 *    `workingDirectory`; this file only improves the middle of that order.
 * 3. **Never bloated.** A handful of roots, most recent first. It answers "which
 *    project was I just in", not "what is on this machine".
 *
 * Writes are best effort: a read-only home directory must not break a session, and the
 * in-memory list stays correct for the rest of the process either way.
 *
 * @module @dsh-external/dsh-project-memory/recent-projects
 */

import path from 'node:path'

import { readJson, writeJsonAtomic } from '../core/store.js'

/** How many roots are retained. Small on purpose: this is a recency list, not an index. */
export const MAX_RECENT = 8

/** Schema version of the store, so a future change can migrate instead of guessing. */
export const RECENT_SCHEMA = 1

/**
 * Resolve the harness home without importing a host package.
 *
 * `@deepseek-ai/dsh-home-paths` is the authoritative resolver, and it is a plain peer
 * of every plugin; importing it would add a load-time dependency for one string. The
 * rule it implements is small enough to restate: an explicit `$DSH_HOME` wins, and the
 * default is `~/.dsh`. Tilde and whitespace handling match it so a value that works in
 * the rest of the harness works here.
 *
 * @param {Record<string, string | undefined>} [env] - environment mapping.
 * @param {() => string} [home] - the OS home directory.
 * @returns {string} the absolute harness home.
 */
export function resolveHome(env = process.env, home) {
  const override = env.DSH_HOME
  if (typeof override === 'string' && override.trim() !== '') {
    const expanded = override.trim()
    const base = typeof home === 'function' ? home() : ''
    if (expanded === '~' && base !== '') return path.resolve(base)
    if ((expanded.startsWith('~/') || expanded.startsWith('~\\')) && base !== '') {
      return path.resolve(path.join(base, expanded.slice(2)))
    }
    return path.resolve(expanded)
  }
  const base = typeof home === 'function' ? home() : ''
  return path.resolve(path.join(base, '.dsh'))
}

/**
 * Where the recency list lives.
 * @param {{ env?: Record<string, string | undefined>, home?: () => string }} [options] - resolution inputs.
 * @returns {string} absolute path to the JSON file.
 */
export function recentProjectsFile(options = {}) {
  return path.join(resolveHome(options.env ?? process.env, options.home), 'dsh-project-memory', 'recent-projects.json')
}

/**
 * Read the recency list, most recent first.
 *
 * Every failure is an empty list. The caller is the panel's root resolver, and an
 * exception there takes the whole panel down for a convenience feature.
 *
 * @param {{ file?: string }} [options] - override the file path (used by tests).
 * @returns {string[]} absolute roots, most recent first.
 */
export function readRecentProjects(options = {}) {
  const file = options.file ?? recentProjectsFile()
  try {
    const loaded = readJson(file)
    if (loaded.ok !== true) return []
    const values = /** @type {any} */ (loaded.value)?.roots
    if (!Array.isArray(values)) return []
    return values.filter((value) => typeof value === 'string' && value.trim() !== '').slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

/**
 * Record that a project root was used, moving it to the front.
 *
 * Written on every step, which sounds excessive and is not: the comparison below is
 * what keeps it cheap. When the root is already first — the overwhelmingly common case
 * while someone works in one repository — nothing is written at all.
 *
 * @param {string} root - absolute project root.
 * @param {{ file?: string }} [options] - override the file path (used by tests).
 * @returns {{ ok: boolean, roots: string[], wrote: boolean, reason?: string }} the outcome.
 */
export function noteRecentProject(root, options = {}) {
  if (typeof root !== 'string' || root.trim() === '') {
    return { ok: false, roots: [], wrote: false, reason: 'empty-root' }
  }
  const file = options.file ?? recentProjectsFile()
  const existing = readRecentProjects({ file })
  const resolved = path.resolve(root)
  if (existing.length > 0 && existing[0] === resolved) {
    // Already the most recent: reporting a write here would be a lie the tests can catch.
    return { ok: true, roots: existing, wrote: false }
  }
  const roots = [resolved, ...existing.filter((value) => value !== resolved)].slice(0, MAX_RECENT)
  try {
    const written = writeJsonAtomic(file, { schema: RECENT_SCHEMA, roots })
    if (written.ok !== true) return { ok: false, roots, wrote: false, reason: 'write-failed' }
    return { ok: true, roots, wrote: true }
  } catch (error) {
    return { ok: false, roots, wrote: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
