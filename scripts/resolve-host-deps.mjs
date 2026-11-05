#!/usr/bin/env node
/**
 * Resolve every package a host module needs, by importing it and following the
 * `ERR_MODULE_NOT_FOUND` errors until it loads.
 *
 * The host's `dsh/node_modules` is a flat bundle assembled by the packer; the package
 * manifests in it do not list every package the code actually imports (several are
 * pulled in by the app itself, not by a declared dependency). Walking the manifests
 * therefore stops short, and each missing package only surfaces one import at a time.
 *
 * This resolver closes that gap: import, read the missing name, extract it, link it,
 * repeat — with a hard bound so a genuinely absent package fails loudly instead of
 * looping.
 *
 * Usage: `node scripts/resolve-host-deps.mjs @deepseek-ai/dsh-app-boot`
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'

const REPO = path.join(import.meta.dirname, '..')
const MAX_ROUNDS = 40

const target = process.argv[2]
if (target === undefined || target === '') {
  console.error('resolve-host-deps: name the module to load, e.g. @deepseek-ai/dsh-app-boot')
  process.exit(1)
}

const run = (script, args) =>
  execFileSync(process.execPath, [path.join(REPO, 'scripts', script), ...args], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

/** Import the target and report either success or the package that is missing. */
const probe = () =>
  execFileSync(process.execPath, ['-e', `import(${JSON.stringify(target)}).then(() => console.log('RESOLVED'), (error) => console.log('MISSING ' + (error.message.match(/Cannot find package '([^']+)'/) ?? [])[1] ?? 'UNKNOWN ' + error.code))`], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

const extracted = new Set()
for (let round = 1; round <= MAX_ROUNDS; round += 1) {
  const result = probe()
  if (result === 'RESOLVED') {
    console.log(`resolve-host-deps: ${target} loads after ${round - 1} extractions${extracted.size > 0 ? ` (${[...extracted].join(', ')})` : ''}`)
    process.exit(0)
  }

  const missing = result.startsWith('MISSING ') ? result.slice('MISSING '.length) : undefined
  if (missing === undefined || missing === 'undefined') {
    console.error(`resolve-host-deps: ${target} failed for a reason other than a missing package: ${result}`)
    process.exit(1)
  }
  if (extracted.has(missing)) {
    // Extracted once already and still missing: the asar genuinely lacks it.
    console.error(`resolve-host-deps: ${missing} was extracted but still does not resolve; the host does not ship a usable copy`)
    process.exit(1)
  }

  extracted.add(missing)
  try {
    run('extract-harness.mjs', [missing])
    run('link-harness.mjs', [])
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim().split('\n')[0]
    console.error(`resolve-host-deps: could not extract ${missing}: ${detail}`)
    process.exit(1)
  }
}

console.error(`resolve-host-deps: gave up after ${MAX_ROUNDS} rounds; still extracting packages`)
process.exit(1)
