#!/usr/bin/env node
/**
 * Locating the harness `app.asar` without a hard-coded path.
 *
 * Why this test exists: three scripts carried one machine's absolute path to
 * `app.asar`. That leaked the author's home directory into a public repository and
 * made the scripts useless anywhere else, which is two defects wearing one line of
 * code. The resolver has to honour an explicit override, fall back to conventional
 * install locations, and — most importantly — fail with the list of locations it
 * tried, because "not found" with no evidence is what sends the next person guessing.
 *
 * Everything here is a pure function over an injected `env`, so nothing touches the
 * real filesystem outside a temporary directory.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const { candidateInstallRoots, resolveAsar } = await import('../scripts/asar-locate.mjs')

const sandbox = mkdtempSync(path.join(tmpdir(), 'pm-asar-'))

try {
  // --- 1. An explicit override wins, even when nothing else exists. ---
  {
    const explicit = path.join(sandbox, 'app.asar')
    writeFileSync(explicit, 'not a real asar, only a location', 'utf8')
    const resolved = resolveAsar({ env: { DSH_ASAR: explicit }, extraRoots: [] })
    assert.equal(resolved.ok, true, 'DSH_ASAR is honoured without any installed harness')
    assert.equal(resolved.path, explicit, 'and it is used verbatim')
  }

  // --- 2. An install root contributes `resources/app.asar`. ---
  {
    const install = path.join(sandbox, 'install')
    mkdirSync(path.join(install, 'resources'), { recursive: true })
    const target = path.join(install, 'resources', 'app.asar')
    writeFileSync(target, 'x', 'utf8')
    const resolved = resolveAsar({ env: { DSH_INSTALL_DIR: install }, extraRoots: [] })
    assert.equal(resolved.ok, true, 'DSH_INSTALL_DIR resolves resources/app.asar')
    assert.equal(resolved.path, target, 'to the file, not the directory')
  }

  // --- 3. A macOS-style Resources root also works. ---
  // The bundle layout already names Resources, so appending another one would miss.
  {
    const resources = path.join(sandbox, 'Bundle.app', 'Contents', 'Resources')
    mkdirSync(resources, { recursive: true })
    const target = path.join(resources, 'app.asar')
    writeFileSync(target, 'x', 'utf8')
    const resolved = resolveAsar({ env: { DSH_INSTALL_DIR: resources }, extraRoots: [] })
    assert.equal(resolved.ok, true, 'a directory that already is Resources is handled')
    assert.equal(resolved.path, target, 'without appending a second resources segment')
  }

  // --- 4. Conventional locations are tried, and the first hit wins. ---
  {
    const root = path.join(sandbox, 'conventional')
    mkdirSync(path.join(root, 'resources'), { recursive: true })
    const target = path.join(root, 'resources', 'app.asar')
    writeFileSync(target, 'x', 'utf8')
    const resolved = resolveAsar({ env: {}, extraRoots: [root] })
    assert.equal(resolved.ok, true, 'a conventional root is searched')
    assert.equal(resolved.path, target, 'and resolves')
  }

  // --- 5. A miss reports every location it tried. ---
  // This is the part that makes the failure actionable instead of a stack trace.
  // The machine running the tests may have a real harness installed, which the
  // resolver is entitled to find, so the failure path is exercised against a
  // resolver that cannot fall back to it — the search list is the same either way.
  {
    const resolved = resolveAsar({
      env: {
        DSH_ASAR: path.join(sandbox, 'missing', 'app.asar'),
        DSH_INSTALL_DIR: path.join(sandbox, 'missing-install'),
        LOCALAPPDATA: path.join(sandbox, 'no-local-appdata'),
        APPDATA: path.join(sandbox, 'no-appdata'),
        HOME: path.join(sandbox, 'no-home'),
        USERPROFILE: path.join(sandbox, 'no-profile'),
      },
      extraRoots: [path.join(sandbox, 'nope')],
      includeSystemRoots: false,
    })
    assert.equal(resolved.ok, false, 'a missing asar is reported, not thrown')
    assert.ok(Array.isArray(resolved.tried) && resolved.tried.length >= 2, 'the attempted locations are listed')
    assert.match(resolved.reason, /DSH_ASAR/, 'the message names the override')
    assert.match(resolved.reason, /DSH_INSTALL_DIR/, 'and the install-root override')
    assert.equal(
      resolved.tried.some((entry) => entry.includes(sandbox)),
      true,
      'the list carries the concrete paths that were checked',
    )
  }

  // A stale explicit path must not shadow a working installation: the override is a
  // hint, not a lock, so a miss there continues to the conventional locations.
  {
    const root = path.join(sandbox, 'fallback')
    mkdirSync(path.join(root, 'resources'), { recursive: true })
    const target = path.join(root, 'resources', 'app.asar')
    writeFileSync(target, 'x', 'utf8')
    const resolved = resolveAsar({
      env: { DSH_ASAR: path.join(sandbox, 'stale', 'app.asar') },
      extraRoots: [root],
    })
    assert.equal(resolved.ok, true, 'a stale override still allows a real installation to be found')
    assert.equal(resolved.path, target, 'the working location wins')
  }

  // --- 6. The resolver's own source hard-codes no user directory. ---
  // The regression this module exists to prevent. Candidate paths derived from
  // environment variables are expected to contain a user directory — that is the
  // point of reading `%LOCALAPPDATA%` — so the check is on the source, not on the
  // resolved values.
  {
    const { readFileSync, readdirSync } = await import('node:fs')
    const scriptsDir = path.join(import.meta.dirname, '..', 'scripts')
    const offenders = []
    for (const name of readdirSync(scriptsDir)) {
      if (!name.endsWith('.mjs')) continue
      const text = readFileSync(path.join(scriptsDir, name), 'utf8')
      // A literal drive-letter path naming a Users\<someone> directory, with the
      // name spelled out rather than read from the environment.
      const match = /[A-Za-z]:\\\\?Users\\\\?[A-Za-z0-9._-]{2,}/.exec(text)
      if (match !== null) offenders.push(`${name}: ${match[0]}`)
    }
    assert.deepEqual(offenders, [], 'no script embeds an absolute user directory')
  }

  console.log('ASAR-LOCATE OK: explicit overrides, install roots, macOS Resources, conventional search, actionable failure, no hard-coded user path')
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
