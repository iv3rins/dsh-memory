/**
 * Path identity and project-root discovery for dsh-project-memory.
 *
 * Everything here is pure Node: no DSH import, so `node --test` can exercise it
 * without a harness. The one filesystem touch is `findProjectRoot`, which needs
 * to look for a `.git` marker.
 */

import { existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

/** Directory (relative to a project root) holding every plugin-owned artifact. */
export const MEMORY_DIR = '.dsh-memory'

/** Case sensitivity of the platform filesystem, for containment comparisons. */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

/**
 * Canonicalize a path, falling back to a resolved copy when the path is absent.
 * A missing tail is the common case here: we canonicalize directories that may
 * not exist yet (the memory directory before `project_init`).
 *
 * @param {string} target - any absolute or resolvable path.
 * @returns {string} an absolute canonical path.
 */
export function canonical(target) {
  const absolute = path.resolve(target)
  try {
    return realpathSync.native(absolute)
  } catch {
    try {
      return realpathSync(absolute)
    } catch {
      return absolute
    }
  }
}

/**
 * Compare two paths for equality under the platform's case rules.
 * @param {string} a - first path.
 * @param {string} b - second path.
 * @returns {boolean} whether both name the same location.
 */
export function samePath(a, b) {
  const left = path.resolve(a)
  const right = path.resolve(b)
  return CASE_INSENSITIVE ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Whether one path is inside a root (or is the root itself).
 *
 * Containment is decided on resolved paths, so `..` cannot escape it. Callers
 * must canonicalize symlinks first when the target may be a link: this function
 * compares the strings it is given.
 *
 * @param {string} root - the directory that must contain the target.
 * @param {string} target - the candidate path.
 * @returns {boolean} true when target is the root or below it.
 */
export function isInside(root, target) {
  const base = path.resolve(root)
  const candidate = path.resolve(target)
  const relative = path.relative(base, candidate)
  if (relative === '') return true
  if (relative.startsWith('..')) return false
  return !path.isAbsolute(relative)
}

/**
 * Resolve a project-relative path and refuse anything that escapes the root.
 *
 * Symlinks are canonicalized before the check, so a repository-owned link
 * pointing outside the project is rejected rather than silently followed.
 *
 * @param {string} root - the project root.
 * @param {string} relativeOrAbsolute - the path to resolve.
 * @returns {{ ok: true, absolute: string, relative: string } | { ok: false, reason: string }} the verdict.
 */
export function resolveWithin(root, relativeOrAbsolute) {
  if (typeof relativeOrAbsolute !== 'string' || relativeOrAbsolute.trim() === '') {
    return { ok: false, reason: 'empty path' }
  }
  if (relativeOrAbsolute.includes('\0')) {
    return { ok: false, reason: 'path contains a NUL byte' }
  }
  const base = canonical(root)
  const joined = path.isAbsolute(relativeOrAbsolute)
    ? path.resolve(relativeOrAbsolute)
    : path.resolve(base, relativeOrAbsolute)
  const resolved = canonical(joined)
  if (!isInside(base, resolved)) {
    return {
      ok: false,
      reason: `path escapes the project root: ${path.relative(base, resolved)}`,
    }
  }
  return {
    ok: true,
    absolute: resolved,
    relative: toPosix(path.relative(base, resolved)),
  }
}

/**
 * Normalize separators to forward slashes for stable display, keys, and matching.
 * @param {string} value - a path in either separator style.
 * @returns {string} the same path with forward slashes.
 */
export function toPosix(value) {
  return String(value).replace(/\\/g, '/')
}

/**
 * Whether a directory looks like a git working tree root.
 * Worktrees and submodules use a `.git` *file*, so both forms count.
 *
 * @param {string} dir - candidate directory.
 * @returns {boolean} true when a `.git` marker exists there.
 */
export function hasGitMarker(dir) {
  try {
    return existsSync(path.join(dir, '.git'))
  } catch {
    return false
  }
}

/**
 * Whether a directory already holds project memory.
 *
 * Only an existing `.dsh-memory/project.json` counts. The directory alone does not: a
 * leftover or hand-made `.dsh-memory/` must not silently capture an unrelated project
 * and start reporting its state.
 *
 * @param {string} dir - candidate directory.
 * @returns {boolean} true when initialized memory lives there.
 */
export function hasMemoryMarker(dir) {
  try {
    return existsSync(path.join(dir, MEMORY_DIR, 'project.json'))
  } catch {
    return false
  }
}

/**
 * Find the project root for a starting directory.
 *
 * The nearest ancestor containing a `.git` marker wins, matching the rule the
 * first-party skill provider uses. Without one, the starting directory itself
 * is the root (a git-less project is a first-class case, not an error).
 *
 * @param {string} startDir - absolute directory to start from.
 * @returns {{ root: string, hasGit: boolean, start: string }} the resolved root facts.
 */
/**
 * Find the project root for a starting directory.
 *
 * Two markers anchor a root, and both are checked at every level while walking up:
 *
 *   - `.dsh-memory/` — an initialized project. This must come first, because it is the
 *     strongest possible signal: the memory is literally here.
 *   - `.git/` — a repository boundary.
 *
 * The nearest ancestor carrying either marker wins. Without one, the starting directory
 * itself is the root (a git-less project is a first-class case, not an error).
 *
 * Checking only `.git` was a real defect: in a project that is not a repository — or one
 * whose session starts deep in a subdirectory before `git init` — a nested session found
 * no marker anywhere and silently started a *second*, empty memory in that subdirectory.
 * The user's recorded state was not lost, but it was invisible, which is worse.
 *
 * @param {string} startDir - absolute directory to start from.
 * @returns {{ root: string, hasGit: boolean, start: string }} the resolved root facts.
 */
export function findProjectRoot(startDir) {
  const start = canonical(startDir)
  let current = start
  let memoryRoot
  for (;;) {
    if (hasGitMarker(current)) return { root: current, hasGit: true, start }
    if (memoryRoot === undefined && hasMemoryMarker(current)) memoryRoot = current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  // A git repository further up wins over a nearer `.dsh-memory/`, matching the rule
  // that the checkout boundary defines the project.
  return { root: memoryRoot ?? start, hasGit: false, start }
}

/**
 * Whether a path is an existing directory.
 * @param {string} target - path to test.
 * @returns {boolean} true for an existing directory.
 */
export function isDirectory(target) {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}
