/**
 * Durable file primitives for dsh-project-memory.
 *
 * Pure Node, no DSH import. Three guarantees the rest of the plugin relies on:
 *
 * 1. **Atomic replacement** — a reader never observes a half-written file. The
 *    temporary file lives in the destination directory so `rename` stays on one
 *    volume (a cross-volume rename fails, which is the classic Windows trap).
 * 2. **Exclusive locks** — concurrent writers serialize on an `O_EXCL` lock file
 *    with a stale-lock timeout, so a crashed holder cannot wedge the project.
 * 3. **Corruption quarantine** — unreadable JSON is renamed aside instead of
 *    thrown, so a damaged state file degrades the tool rather than the session.
 */

import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'

/** Default lock wait before giving up, in milliseconds. */
export const DEFAULT_LOCK_WAIT_MS = 5000

/** Lock age after which a holder is presumed dead, in milliseconds. */
export const DEFAULT_LOCK_STALE_MS = 30000

/** Upper bound on a single JSON document this plugin will read, in bytes. */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

/**
 * Read a UTF-8 text file, stripping a byte-order mark if present.
 *
 * @param {string} absolute - absolute path to read.
 * @returns {{ ok: true, text: string } | { ok: false, reason: 'absent' | 'too-large' | 'unreadable', error?: unknown }} the outcome.
 */
export function readText(absolute) {
  let stat
  try {
    stat = statSync(absolute)
  } catch {
    return { ok: false, reason: 'absent' }
  }
  if (!stat.isFile()) return { ok: false, reason: 'unreadable' }
  if (stat.size > MAX_DOCUMENT_BYTES) return { ok: false, reason: 'too-large' }
  try {
    const text = readFileSync(absolute, 'utf8')
    return { ok: true, text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text }
  } catch (error) {
    return { ok: false, reason: 'unreadable', error }
  }
}

/**
 * Write a file atomically: temp file in the destination directory, fsync, rename.
 *
 * The rename replaces the destination in one filesystem operation, so a
 * concurrent reader sees either the old or the new content, never a mixture.
 *
 * @param {string} absolute - destination path (its directory is created).
 * @param {string} text - content to write, UTF-8 without a BOM.
 * @returns {{ ok: true, bytes: number } | { ok: false, error: unknown }} the outcome.
 */
export function writeTextAtomic(absolute, text) {
  const directory = path.dirname(absolute)
  const temporary = path.join(directory, `.${path.basename(absolute)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  let handle
  try {
    mkdirSync(directory, { recursive: true })
    handle = openSync(temporary, 'wx')
    const bytes = Buffer.from(text, 'utf8')
    writeSync(handle, bytes)
    fsyncSync(handle)
    closeSync(handle)
    handle = undefined
    renameSync(temporary, absolute)
    return { ok: true, bytes: bytes.length }
  } catch (error) {
    if (handle !== undefined) {
      try {
        closeSync(handle)
      } catch {
        /* the write already failed; a second failure here carries no new information */
      }
    }
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* a leftover temp file is harmless; the next attempt writes a fresh name */
    }
    return { ok: false, error }
  }
}

/**
 * Read and parse a JSON document.
 *
 * A document that exists but cannot be parsed is *quarantined* (renamed to
 * `<name>.corrupt-<timestamp>`) and reported as `corrupt`, so the caller can
 * tell the user what happened and start from a clean default. The original
 * bytes are never overwritten silently.
 *
 * @param {string} absolute - absolute path to read.
 * @returns {{ ok: true, value: unknown } | { ok: false, reason: 'absent' | 'too-large' | 'unreadable' | 'corrupt', quarantinedTo?: string, message?: string }} the outcome.
 */
export function readJson(absolute) {
  const text = readText(absolute)
  if (!text.ok) return text
  try {
    return { ok: true, value: JSON.parse(text.text) }
  } catch (error) {
    const quarantine = `${absolute}.corrupt-${Date.now()}`
    let quarantinedTo
    try {
      renameSync(absolute, quarantine)
      quarantinedTo = quarantine
    } catch {
      /* if the rename fails we still report corruption; nothing is destroyed */
    }
    return {
      ok: false,
      reason: 'corrupt',
      ...(quarantinedTo === undefined ? {} : { quarantinedTo }),
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Write a JSON document atomically with two-space indentation and a trailing newline.
 * @param {string} absolute - destination path.
 * @param {unknown} value - JSON-serializable value.
 * @returns {{ ok: true, bytes: number } | { ok: false, error: unknown }} the outcome.
 */
export function writeJsonAtomic(absolute, value) {
  let text
  try {
    text = JSON.stringify(value, null, 2) + '\n'
  } catch (error) {
    return { ok: false, error }
  }
  return writeTextAtomic(absolute, text)
}

/**
 * Acquire an exclusive lock file, waiting up to `waitMs` and stealing a stale one.
 *
 * `open(..., 'wx')` is the atomic primitive: exactly one caller can create the
 * file. A holder that crashed leaves the file behind, so a lock older than
 * `staleMs` is removed and retried once.
 *
 * @param {string} lockPath - lock file path.
 * @param {{ waitMs?: number, staleMs?: number, pollMs?: number }} [options] - timing knobs.
 * @returns {Promise<{ ok: true, release: () => void } | { ok: false, reason: string }>} the lock handle or a reason.
 */
export async function acquireLock(lockPath, options = {}) {
  const waitMs = options.waitMs ?? DEFAULT_LOCK_WAIT_MS
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS
  const pollMs = options.pollMs ?? 15
  const deadline = Date.now() + waitMs
  mkdirSync(path.dirname(lockPath), { recursive: true })

  for (;;) {
    try {
      const handle = openSync(lockPath, 'wx')
      writeSync(handle, `${process.pid}\n${Date.now()}\n`)
      closeSync(handle)
      let released = false
      return {
        ok: true,
        release() {
          if (released) return
          released = true
          try {
            rmSync(lockPath, { force: true })
          } catch {
            /* an unreleased lock is reclaimed by the stale timeout, not lost */
          }
        },
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') return { ok: false, reason: `lock failed: ${error?.code ?? error}` }
    }

    let age = 0
    try {
      age = Date.now() - statSync(lockPath).mtimeMs
    } catch {
      continue // the holder released between our failed create and this stat
    }
    if (age > staleMs) {
      try {
        rmSync(lockPath, { force: true })
      } catch {
        /* another waiter stole it first */
      }
      continue
    }
    if (Date.now() >= deadline) {
      return { ok: false, reason: `lock is held (${Math.round(age)} ms old): ${lockPath}` }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/**
 * Run a function while holding a lock, always releasing it.
 * @template T
 * @param {string} lockPath - lock file path.
 * @param {() => Promise<T>} operation - work to run under the lock.
 * @param {{ waitMs?: number, staleMs?: number }} [options] - timing knobs.
 * @returns {Promise<{ ok: true, value: T } | { ok: false, reason: string }>} the result or a lock failure.
 */
export async function withLock(lockPath, operation, options = {}) {
  const lock = await acquireLock(lockPath, options)
  if (!lock.ok) return lock
  try {
    return { ok: true, value: await operation() }
  } finally {
    lock.release()
  }
}

/**
 * Remove a file, ignoring an already-absent target.
 * @param {string} absolute - path to remove.
 * @returns {void}
 */
export function removeFile(absolute) {
  try {
    rmSync(absolute, { force: true })
  } catch {
    /* removal is best-effort cleanup */
  }
}
