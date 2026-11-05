#!/usr/bin/env node
/**
 * Link the harness packages this plugin imports into `node_modules`.
 *
 * The plugin imports `@deepseek-ai/dsh-llm` the same way every working external
 * plugin in this environment does: as a plain static import the host resolves for
 * it. That makes `npm test` inside this repository fail on a clean checkout with
 * `ERR_MODULE_NOT_FOUND`, because nothing here installs a harness — the harness
 * lives inside the DSH installation.
 *
 * Rather than vendor a copy or weaken the import, this script points
 * `node_modules/@deepseek-ai` at the packages extracted from the installed payload
 * (see `_research/README.md`). It is idempotent, refuses to overwrite a real
 * directory, and prints exactly what it found so a failure is diagnosable instead of
 * mysterious.
 *
 * Usage: `node scripts/link-harness.mjs` (run by `npm run link:harness`).
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import path from 'node:path'

const repo = path.join(import.meta.dirname, '..')
const target = path.join(repo, '_research', 'asar-nm', '@deepseek-ai')
const linkPath = path.join(repo, 'node_modules', '@deepseek-ai')

/** Packages this plugin or its tests actually import. */
const REQUIRED = ['dsh-llm', 'dsh-tools', 'dsh-system-prompt', 'cordis']

if (!existsSync(target)) {
  console.error(`link-harness: ${target} is missing.`)
  console.error('link-harness: extract the harness packages first (see _research/README.md).')
  process.exit(1)
}

const missing = REQUIRED.filter((name) => !existsSync(path.join(target, name, 'package.json')))
if (missing.length > 0) {
  console.error(`link-harness: the extraction is incomplete; missing ${missing.join(', ')}`)
  process.exit(1)
}

mkdirSync(path.dirname(linkPath), { recursive: true })

if (existsSync(linkPath) || lstatSync(linkPath, { throwIfNoEntry: false }) !== undefined) {
  const stat = lstatSync(linkPath)
  if (!stat.isSymbolicLink()) {
    // A real directory is a genuine install; never delete someone's node_modules.
    console.error(`link-harness: ${linkPath} exists and is not a symlink; leaving it alone.`)
    process.exit(1)
  }
  rmSync(linkPath, { force: true })
}

try {
  // 'junction' keeps this working on Windows without elevation.
  symlinkSync(target, linkPath, 'junction')
} catch (error) {
  console.error(`link-harness: could not create the link: ${error.message}`)
  process.exit(1)
}

const present = readdirSync(target).filter((name) => existsSync(path.join(target, name, 'package.json')))
console.log(`link-harness: ${linkPath} -> ${target}`)
console.log(`link-harness: ${present.length} harness packages available (${present.join(', ')})`)

// --- Top-level (unscoped) dependencies need their own links ---
// The scope junction only resolves `@deepseek-ai/*`. Host modules also import plain
// packages (`js-yaml`, `semver`, …), and a plugin's tests import whatever the host
// imports. Linking each one individually keeps `node_modules` honest: nothing appears
// there that was not explicitly extracted.
const unscoped = readdirSync(target.replace(/[\\/]@deepseek-ai$/, ''))
  .filter((name) => !name.startsWith('@') && !name.startsWith('.'))
  .filter((name) => existsSync(path.join(target.replace(/[\\/]@deepseek-ai$/, ''), name, 'package.json')))

const nodeModules = path.dirname(linkPath)
const linked = []
const skipped = []
for (const name of unscoped) {
  const destination = path.join(nodeModules, name)
  const source = path.join(target.replace(/[\\/]@deepseek-ai$/, ''), name)
  const existing = lstatSync(destination, { throwIfNoEntry: false })
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) {
      // A real package is a genuine install; leave it.
      skipped.push(name)
      continue
    }
    rmSync(destination, { force: true })
  }
  try {
    symlinkSync(source, destination, 'junction')
    linked.push(name)
  } catch (error) {
    console.error(`link-harness: could not link ${name}: ${error.message}`)
  }
}

if (linked.length > 0) console.log(`link-harness: linked ${linked.length} top-level packages (${linked.join(', ')})`)
if (skipped.length > 0) console.log(`link-harness: left ${skipped.length} real installs alone (${skipped.join(', ')})`)
