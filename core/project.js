/**
 * Project identity and git facts for dsh-project-memory.
 *
 * A project is identified by a **stable uuid** stored in
 * `.dsh-memory/project.json`, never by its directory name: renaming or moving a
 * checkout must not orphan its memory. The directory only supplies the *anchor*
 * used to find that file.
 *
 * A git-less project is a first-class case. This very workspace started without
 * a repository, so every consumer receives an explicit `kind` instead of a
 * silently absent branch.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { MEMORY_DIR, canonical, findProjectRoot, isDirectory, toPosix } from './paths.js'
import { readJson, writeJsonAtomic } from './store.js'

/** Current on-disk schema version for `project.json`. */
export const PROJECT_SCHEMA = 1

/**
 * One git fact set, always fully populated so callers never branch on undefined.
 * @typedef {object} GitFacts
 * @property {'repository' | 'absent' | 'unavailable'} kind - how much is known.
 * @property {string | null} branch - current branch, null when detached or unknown.
 * @property {string | null} head - abbreviated commit, null when unknown.
 * @property {boolean} detached - whether HEAD is not on a branch.
 * @property {boolean | null} dirty - whether the worktree has changes, null when unknown.
 * @property {string | null} toplevel - repository root reported by git.
 * @property {string | null} remote - `origin` URL when configured.
 * @property {string | null} reason - why facts are missing, for user-facing text.
 */

/** Run one git command with a hard timeout and no shell. */
function git(cwd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, reason: error.code === 'ENOENT' ? 'git is not installed' : 'git command failed' })
          return
        }
        resolve({ ok: true, stdout: String(stdout).trim() })
      },
    )
  })
}

/**
 * Collect the git facts for a directory.
 *
 * Every failure mode is reported as data, never thrown: a missing `git` binary,
 * a timeout, and a directory outside any repository all produce a populated
 * `GitFacts` with `kind: 'absent' | 'unavailable'`.
 *
 * @param {string} directory - directory to inspect.
 * @param {{ timeoutMs?: number }} [options] - timeout for each git call.
 * @returns {Promise<GitFacts>} the facts.
 */
export async function readGitFacts(directory, options = {}) {
  const timeoutMs = options.timeoutMs ?? 4000
  const cwd = canonical(directory)
  const empty = {
    kind: /** @type {'absent'} */ ('absent'),
    branch: null,
    head: null,
    detached: false,
    dirty: null,
    toplevel: null,
    remote: null,
    reason: null,
  }

  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'], timeoutMs)
  if (!inside.ok) return { ...empty, kind: 'unavailable', reason: inside.reason }
  if (inside.stdout !== 'true') return { ...empty, reason: 'not inside a git work tree' }

  const toplevel = await git(cwd, ['rev-parse', '--show-toplevel'], timeoutMs)
  const headResult = await git(cwd, ['rev-parse', '--short', 'HEAD'], timeoutMs)
  const branchResult = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], timeoutMs)
  const statusResult = await git(cwd, ['status', '--porcelain=v1', '--untracked-files=no'], timeoutMs)
  const remoteResult = await git(cwd, ['config', '--get', 'remote.origin.url'], timeoutMs)

  const branchRaw = branchResult.ok ? branchResult.stdout : ''
  const detached = branchRaw === 'HEAD' || branchRaw === ''
  return {
    kind: 'repository',
    branch: detached ? null : branchRaw,
    head: headResult.ok && headResult.stdout !== '' ? headResult.stdout : null,
    detached,
    dirty: statusResult.ok ? statusResult.stdout !== '' : null,
    toplevel: toplevel.ok ? toPosix(toplevel.stdout) : null,
    remote: remoteResult.ok && remoteResult.stdout !== '' ? remoteResult.stdout : null,
    reason: headResult.ok ? null : 'repository has no commits yet',
  }
}

/**
 * Read the plugin's `project.json` from a project root.
 *
 * @param {string} root - project root.
 * @returns {{ ok: true, value: any } | { ok: false, reason: string, quarantinedTo?: string, message?: string }} the document.
 */
export function readProjectFile(root) {
  const absolute = path.join(root, MEMORY_DIR, 'project.json')
  const result = readJson(absolute)
  if (!result.ok) return result
  const value = result.value
  if (value === null || typeof value !== 'object' || typeof value.projectId !== 'string' || value.projectId === '') {
    return { ok: false, reason: 'invalid', message: 'project.json has no projectId' }
  }
  return result
}

/**
 * Resolve the anchor directory and the project root for one session.
 *
 * Resolution order: an explicit configured root, else the session cwd with the
 * nearest `.git` ancestor (or the cwd itself when there is none).
 *
 * @param {{ configuredRoot?: string, cwd?: string }} input - resolution inputs.
 * @returns {{ ok: true, root: string, anchor: string, hasGit: boolean } | { ok: false, reason: string }} the root, or why it is unknown.
 */
export function resolveProjectRoot(input) {
  if (typeof input.configuredRoot === 'string' && input.configuredRoot.trim() !== '') {
    const root = canonical(input.configuredRoot)
    if (!isDirectory(root)) return { ok: false, reason: `configured projectRoot is not a directory: ${root}` }
    return { ok: true, root, anchor: root, hasGit: existsSync(path.join(root, '.git')) }
  }
  if (typeof input.cwd !== 'string' || input.cwd.trim() === '') {
    return { ok: false, reason: 'no working directory is known for this session' }
  }
  const found = findProjectRoot(input.cwd)
  return { ok: true, root: found.root, anchor: found.start, hasGit: found.hasGit }
}

/**
 * Build the identity document for a new project.
 * @param {{ root: string, git: GitFacts }} input - root and its git facts.
 * @returns {object} a `project.json` value.
 */
export function newProjectDocument(input) {
  return {
    schema: PROJECT_SCHEMA,
    projectId: randomUUID(),
    name: path.basename(input.root),
    createdAt: new Date().toISOString(),
    gitRemote: input.git.remote ?? null,
    note: 'This identifier is stable for the life of the project. It is NOT derived from the directory name, so renaming or moving the checkout keeps the same project memory.',
  }
}

/**
 * Load full project identity: root, git facts, and the persisted identifier.
 *
 * @param {{ configuredRoot?: string, cwd?: string, timeoutMs?: number }} input - resolution inputs.
 * @returns {Promise<
 *   | { ok: true, initialized: true, root: string, anchor: string, hasGit: boolean, project: any, document: any, git: GitFacts }
 *   | { ok: true, initialized: false, root: string, anchor: string, hasGit: boolean, git: GitFacts, reason: string }
 *   | { ok: false, reason: string }
 * >} identity, or a reason it is unavailable.
 */
export async function loadProject(input) {
  const resolved = resolveProjectRoot(input)
  if (!resolved.ok) return resolved
  const git = await readGitFacts(resolved.root, { timeoutMs: input.timeoutMs })
  const document = readProjectFile(resolved.root)
  if (!document.ok) {
    return {
      ok: true,
      initialized: false,
      root: resolved.root,
      anchor: resolved.anchor,
      hasGit: resolved.hasGit,
      git,
      reason: document.reason,
    }
  }
  return {
    ok: true,
    initialized: true,
    root: resolved.root,
    anchor: resolved.anchor,
    hasGit: resolved.hasGit,
    project: document.value,
    document,
    git,
  }
}

/**
 * Create `.dsh-memory/project.json` without touching anything that exists.
 *
 * Initialization is incremental: a re-run against an initialized project reports
 * `already-initialized` and writes nothing, so it can never overwrite a uuid.
 *
 * @param {{ root: string, git: GitFacts, name?: string }} input - what to record.
 * @returns {{ ok: true, created: boolean, document: any, path: string } | { ok: false, reason: string }} the outcome.
 */
export function ensureProjectFile(input) {
  const existing = readProjectFile(input.root)
  const target = path.join(input.root, MEMORY_DIR, 'project.json')
  if (existing.ok) return { ok: true, created: false, document: existing.value, path: target }
  const document = newProjectDocument(input)
  if (typeof input.name === 'string' && input.name.trim() !== '') document.name = input.name.trim()
  const written = writeJsonAtomic(target, document)
  if (!written.ok) return { ok: false, reason: `cannot write project.json: ${written.error?.message ?? written.error}` }
  return { ok: true, created: true, document, path: target }
}
