#!/usr/bin/env node
/**
 * Ask the host's own compatibility checker how it judges this plugin's manifest.
 *
 * Guessing at `engines.dsh` was a mistake worth not repeating: the host has an exact
 * rule, and it is stricter than it looks. `unmetRequirements` in `dsh-app-boot` reads
 * `engines.dsh` if it is present and ignores peerDependencies entirely; otherwise it
 * checks **every** `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peer range against the
 * running version. So an omitted `engines.dsh` silently delegates the decision to the
 * peer ranges, and a too-narrow peer range would block installation on a host the
 * plugin actually works on.
 *
 * This test runs the real evaluator against the real `package.json` and the real
 * runtime version, so the manifest cannot drift away from what the host accepts.
 *
 * SKIPs when the harness packages are not linked.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const NM = path.join(import.meta.dirname, '..', '_research', 'asar-nm', '@deepseek-ai')
let evaluatePluginCompatibility
let getDshRuntimeVersion
try {
  const boot = await import(pathToFileURL(path.join(NM, 'dsh-app-boot', 'lib', 'index.js')).href)
  evaluatePluginCompatibility = boot.evaluatePluginCompatibility
  getDshRuntimeVersion = boot.getDshRuntimeVersion
} catch (error) {
  console.log(`SKIP: dsh-app-boot unavailable (${error.code ?? error.message}); manifest compatibility not checked`)
  process.exit(0)
}
assert.equal(typeof evaluatePluginCompatibility, 'function', 'the host exports its own checker')
assert.equal(typeof getDshRuntimeVersion, 'function', 'the host exports its runtime version')

const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'))
const runtimeVersion = getDshRuntimeVersion()

// --- The installed host must accept this manifest as-is ---
const verdict = evaluatePluginCompatibility(manifest, {}, runtimeVersion)
assert.equal(
  verdict,
  undefined,
  `the running host must accept this plugin unchanged; ${runtimeVersion} rejected: ${verdict === undefined ? '' : JSON.stringify(verdict.requirements)}`,
)

// --- The identity the host would report on a mismatch must be present ---
// `identityField` throws when a mismatch cannot be named, so an install failure on a
// nameless manifest is a crash rather than a message.
assert.equal(typeof manifest.name, 'string', 'the manifest is named')
assert.match(manifest.name, /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, 'the name is a valid package name')
assert.match(manifest.version, /^\d+\.\d+\.\d+/, 'the manifest is versioned')

// --- An impossible requirement must be rejected, not silently accepted ---
// This proves the check above is meaningful: a checker that returned undefined for
// everything would make the first assertion worthless.
const impossible = evaluatePluginCompatibility({ ...manifest, engines: { dsh: '>=99.0.0 <100' } }, {}, runtimeVersion)
assert.notEqual(impossible, undefined, 'an unsatisfiable engines.dsh is rejected')
assert.equal(impossible.requirements['engines.dsh'], '>=99.0.0 <100', 'the unmet range is reported verbatim')

// --- `engines.dsh` decides alone; peer ranges are then ignored ---
// This is the host's rule, and the manifest relies on it: the peer range is a
// declaration for consumers, while `engines.dsh` is what the runtime enforces. If the
// two ever disagree, the host follows `engines.dsh` silently rather than reporting the
// conflict, so the asymmetry is asserted here instead of assumed.
const peerOnly = evaluatePluginCompatibility(
  { ...manifest, engines: { dsh: '>=0.2.0-rc.0 <0.3.0' }, peerDependencies: { '@deepseek-ai/dsh-llm': '>=99.0.0 <100' } },
  {},
  runtimeVersion,
)
assert.equal(peerOnly, undefined, 'a satisfiable engines.dsh wins even when a peer range is unsatisfiable')

// The manifest's own peer range is satisfiable, so it must be overridden here to
// prove the peer path is actually consulted when `engines.dsh` is absent.
const peerDecides = evaluatePluginCompatibility(
  { ...manifest, engines: { node: '>=20' }, peerDependencies: { '@deepseek-ai/dsh-llm': '>=99.0.0 <100' } },
  {},
  runtimeVersion,
)
assert.notEqual(peerDecides, undefined, 'without engines.dsh the peer ranges decide')
assert.equal(peerDecides.requirements['@deepseek-ai/dsh-llm'], '>=99.0.0 <100', 'and the unmet peer is named')

// --- Malformed requirement fields must throw rather than be ignored ---
assert.throws(
  () => evaluatePluginCompatibility({ ...manifest, engines: { dsh: 42 } }, {}, runtimeVersion),
  /must be a string/,
  'a non-string engines.dsh throws, so a typo cannot silently disable the check',
)

// --- Document which rule decided, because the two paths differ ---
const usesEngines = Object.hasOwn(manifest.engines ?? {}, 'dsh')
const dshPeers = Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
assert.ok(
  usesEngines || dshPeers.length > 0,
  'the manifest declares a dsh requirement one way or another; declaring neither would accept any future host silently',
)

console.log(
  `COMPAT OK: host ${runtimeVersion} accepts the manifest via ${usesEngines ? 'engines.dsh' : `peerDependencies (${dshPeers.map(([n, r]) => `${n}@${r}`).join(', ')})`}; ` +
    'an unsatisfiable range is rejected and a malformed one throws',
)
