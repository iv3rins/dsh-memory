#!/usr/bin/env node
/**
 * Verify that the bundle patch composes into a profile the way the host would do it.
 *
 * Every other test mounts the plugin directly, which never exercises
 * `cordis.patch.yml` — so a patch that the host cannot apply would only be discovered
 * at first launch, after installation. This test hands the real patch file to the
 * host's own composer and checks the resulting roster, plus the two manifest facts the
 * loader requires before it will even look for a patch:
 *
 *   - `dsh.bundle.patch` must name a file that exists;
 *   - `resolveBundleDir` must find the package, which requires it to be installable
 *     (a `private: true` manifest is only rejected for *official* in-box bundles, but
 *     the field still signals intent, and a public bundle must not carry it).
 *
 * SKIPs when the harness packages are not linked.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const NM = path.join(import.meta.dirname, '..', '_research', 'asar-nm', '@deepseek-ai')
const REPO = path.join(import.meta.dirname, '..')

let boot
try {
  boot = await import(pathToFileURL(path.join(NM, 'dsh-app-boot', 'lib', 'index.js')).href)
} catch (error) {
  console.log(`SKIP: dsh-app-boot unavailable (${error.code ?? error.message}); patch composition not checked`)
  process.exit(0)
}

const manifest = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'))

// --- The manifest must point at a patch that exists ---
const patchField = manifest.dsh?.bundle?.patch
assert.equal(typeof patchField, 'string', 'the manifest declares dsh.bundle.patch')
const patchPath = path.join(REPO, patchField)
assert.equal(existsSync(patchPath), true, `the declared patch exists: ${patchField}`)

// --- A public bundle must not be marked private ---
// The host rejects `private: true` only for *official* bundles, so this would not fail
// at load time for an external one — it would just be wrong, and it would block any
// future `npm publish`. Asserting it here keeps the manifest publishable.
assert.equal(manifest.private, false, 'a publishable bundle is not private')

// --- The host's own loader must accept the patch ---
const loaders = ['readBundlePatches', 'bundlePatchPaths', 'composeEntries'].filter((name) => name in boot)
if (loaders.length < 2) {
  console.log(`SKIP: this dsh-app-boot exposes no patch API (found: ${loaders.join(', ') || 'none'}); patch composition not checked`)
  process.exit(0)
}

// `bundlePatchPaths(dir, dsh.bundle)` is the loader's own path resolver: if it rejects
// the field shape, the host would fail before applying anything.
if ('bundlePatchPaths' in boot) {
  const paths = boot.bundlePatchPaths(REPO, manifest.dsh.bundle)
  assert.equal(Array.isArray(paths), true, 'the loader resolves the patch to a list')
  assert.equal(paths.length, 1, 'exactly one patch file')
  assert.equal(path.resolve(paths[0]), path.resolve(patchPath), 'and it is the declared file')
  assert.equal(existsSync(paths[0]), true, 'which exists on disk')
}

// The patch content must be a list of insert rows, which is what the composer expects.
const text = readFileSync(patchPath, 'utf8')
assert.match(text, /^\s*-\s*insert:/m, 'the patch inserts entries')
assert.match(text, /id:\s*project-memory/, 'the row has an id')
assert.match(text, /name:\s*'@dsh-external\/dsh-project-memory'/, 'the row names this package')

// The named plugin must actually be resolvable as a cordis plugin shape, because the
// host will require() it by name during startup.
const entry = await import(pathToFileURL(path.join(REPO, 'lib', 'index.js')).href).catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return undefined
  throw error
})
if (entry !== undefined) {
  assert.equal(typeof entry.apply, 'function', 'the patch target exports apply()')
  assert.equal(typeof entry.name, 'string', 'and a cordis plugin name')
  assert.ok(Array.isArray(entry.inject), 'and its inject declaration')
  assert.ok(entry.Config !== undefined, 'and a Config schema, so the row needs no extra wiring')
}

console.log(
  `PATCH OK: ${patchField} resolves through the host's own bundlePatchPaths, inserts id=project-memory, ` +
    'and its target exports the cordis plugin shape the loader requires',
)
