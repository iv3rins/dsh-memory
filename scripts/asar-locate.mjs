/**
 * Locate the installed harness `app.asar` without hard-coding one machine's path.
 *
 * These scripts read the host's own bundles to answer questions about the host
 * (which slot props it passes, how the panel contract works). That file lives in a
 * per-install location, so an absolute path baked into the repository both leaks the
 * author's home directory and stops working for anyone else.
 *
 * Resolution order, cheapest and most explicit first:
 *
 * 1. `DSH_ASAR` — the caller says exactly which file to read.
 * 2. `DSH_INSTALL_DIR` — a harness install root; `resources/app.asar` is appended.
 * 3. The conventional per-platform install locations below, by product name.
 *
 * A miss is reported with every location that was tried, because "app.asar not
 * found" with no list is the message that made this worth centralising.
 *
 * Pure Node; no dependency on the host packages it helps read.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'

/** Product directory name used by the installer, without the arch-specific prefix. */
const PRODUCT = 'DeepSeek Harness'

/**
 * Candidate install roots for this platform.
 *
 * `%LOCALAPPDATA%` is the documented per-user install base on Windows; the macOS and
 * Linux entries cover the other places an Electron app of this name can land, since
 * these scripts are useful on any of them.
 *
 * @param {{ env?: Record<string, string | undefined> }} [options] - environment to read.
 * @returns {string[]} directories that may contain `resources/app.asar`.
 */
export function candidateInstallRoots(options = {}) {
  const env = options.env ?? process.env
  const roots = []
  const localAppData = env.LOCALAPPDATA
  const appData = env.APPDATA
  if (typeof localAppData === 'string' && localAppData !== '') {
    roots.push(path.join(localAppData, 'Programs', PRODUCT))
    roots.push(path.join(localAppData, PRODUCT))
  }
  if (typeof appData === 'string' && appData !== '') {
    roots.push(path.join(appData, PRODUCT))
  }
  const home = env.HOME ?? env.USERPROFILE
  if (typeof home === 'string' && home !== '') {
    roots.push(path.join(home, 'Applications', `${PRODUCT}.app`, 'Contents', 'Resources'))
    roots.push(path.join(home, '.local', 'share', PRODUCT))
    roots.push(path.join(home, '.config', PRODUCT))
  }
  // A system-wide install is still a legitimate location for the same file.
  roots.push(`/Applications/${PRODUCT}.app/Contents/Resources`)
  roots.push(path.join('/opt', PRODUCT))
  return roots
}

/**
 * Resolve the `app.asar` to read.
 *
 * @param {{ env?: Record<string, string | undefined>, extraRoots?: string[], includeSystemRoots?: boolean }} [options] - overrides for tests.
 * @returns {{ ok: true, path: string } | { ok: false, reason: string, tried: string[] }} the location, or why not.
 */
export function resolveAsar(options = {}) {
  const env = options.env ?? process.env
  const tried = []

  const explicit = env.DSH_ASAR
  if (typeof explicit === 'string' && explicit !== '') {
    tried.push(explicit)
    if (existsSync(explicit)) return { ok: true, path: explicit }
  }

  const installDir = env.DSH_INSTALL_DIR
  if (typeof installDir === 'string' && installDir !== '') {
    const candidate = path.join(installDir, 'resources', 'app.asar')
    tried.push(candidate)
    if (existsSync(candidate)) return { ok: true, path: candidate }
    // A macOS bundle root already points at Resources, so `resources` is wrong there.
    const direct = path.join(installDir, 'app.asar')
    tried.push(direct)
    if (existsSync(direct)) return { ok: true, path: direct }
  }

  // Environment-derived roots are always searched. The two absolute system locations
  // are skipped only when a caller says so, which is how the failure path is testable
  // on a machine that does have the harness installed.
  const conventional = candidateInstallRoots({ env })
  const roots = options.includeSystemRoots === false
    ? conventional.filter((root) => !root.startsWith('/Applications') && !root.startsWith('/opt'))
    : conventional

  for (const root of [...(options.extraRoots ?? []), ...roots]) {
    const candidate = path.join(root, 'resources', 'app.asar')
    tried.push(candidate)
    if (existsSync(candidate)) return { ok: true, path: candidate }
    // Roots that already name a Resources directory, as the macOS entries do.
    const direct = path.join(root, 'app.asar')
    tried.push(direct)
    if (existsSync(direct)) return { ok: true, path: direct }
  }

  return {
    ok: false,
    reason: 'app.asar was not found; set DSH_ASAR to the installed file, or DSH_INSTALL_DIR to the harness install root',
    tried,
  }
}

/**
 * Resolve the asar or exit with the list of attempted locations.
 *
 * A script that cannot find the file has nothing to do, so this turns the diagnosis
 * into one message instead of a stack trace from `openSync`.
 *
 * @param {(line: string) => void} [log] - where to write the failure.
 * @returns {string} the resolved path.
 */
export function requireAsar(log = (line) => console.error(line)) {
  const resolved = resolveAsar()
  if (resolved.ok === true) return resolved.path
  log(`asar-locate: ${resolved.reason}`)
  for (const candidate of resolved.tried) log(`  tried: ${candidate}`)
  process.exit(1)
}
