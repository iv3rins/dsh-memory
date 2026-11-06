#!/usr/bin/env node
/**
 * Extract host packages from the installed app.asar, with their dependencies.
 *
 * The plugin's own tests need only a few harness packages, but host-side checks such
 * as `tests/compat.mjs` import real host modules (`dsh-app-boot`, which pulls in
 * plugin-loader, js-yaml, semver…). Resolving those by hand produced a chain of
 * `ERR_MODULE_NOT_FOUND` failures, each for a different package, so the walk is done
 * here from the manifests instead of from guesses.
 *
 * Layout: everything lands flat under `_research/asar-nm/`, mirroring how
 * `dsh/node_modules` itself is organised (hoisted, with nested copies preserved for
 * scoped packages). `npm run link:harness` then points `node_modules/@deepseek-ai`
 * and `node_modules/<other>` at it.
 *
 * Usage: `node scripts/extract-harness.mjs @scope/name [name ...]`
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { requireAsar } from './asar-locate.mjs'

const ASAR = requireAsar()
/** The asar subtree that holds the host's node_modules. */
const ROOT_PREFIX = 'dsh/node_modules'
const REPO = path.join(import.meta.dirname, '..')
const OUT = path.join(REPO, '_research', 'asar-nm')

/**
 * Map an asar package directory to its extraction directory.
 *
 * `dsh/node_modules/@scope/name` → `_research/asar-nm/@scope/name`
 * `dsh/node_modules/name`        → `_research/asar-nm/name`
 *
 * A nested copy such as `dsh/node_modules/a/node_modules/b` keeps its nesting so two
 * versions of one package cannot collide.
 */
function extractDirOf(asarDir) {
  const relative = asarDir.startsWith(`${ROOT_PREFIX}/`) ? asarDir.slice(ROOT_PREFIX.length + 1) : asarDir
  return path.join(OUT, relative)
}

/** Dump one package directory from the asar, unless it is already extracted. */
function dump(asarDir) {
  const outDir = extractDirOf(asarDir)
  if (existsSync(path.join(outDir, 'package.json'))) return false
  mkdirSync(path.dirname(outDir), { recursive: true })
  try {
    execFileSync(process.execPath, [path.join(REPO, '_research', 'asar.cjs'), 'dump', ASAR, asarDir, outDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    return true
  } catch (error) {
    const line = String(error.stderr ?? error.message).trim().split('\n')[0]
    console.error(`extract-harness: could not dump ${asarDir}: ${line}`)
    return false
  }
}

/** Read an extracted package manifest, or null. */
function manifestOf(asarDir) {
  const filename = path.join(extractDirOf(asarDir), 'package.json')
  if (!existsSync(filename)) return null
  try {
    return JSON.parse(readFileSync(filename, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Locate a dependency's asar directory, following npm's nesting.
 *
 * Node resolves upward from the dependent: first `a/node_modules/b`, then the hoisted
 * `node_modules/b`. The same order is applied here against the asar paths.
 */
function resolveDependency(name, fromAsarDir) {
  let cursor = fromAsarDir
  for (;;) {
    const candidate = `${cursor}/node_modules/${name}`
    if (existsSync(path.join(extractDirOf(candidate), 'package.json'))) return candidate
    if (cursor === ROOT_PREFIX) break
    const parent = path.posix.dirname(cursor)
    if (!parent.startsWith('dsh')) break
    cursor = parent
  }
  return `${ROOT_PREFIX}/${name}`
}

const requested = process.argv.slice(2)
if (requested.length === 0) {
  console.error('extract-harness: name at least one package, e.g. @deepseek-ai/dsh-app-boot')
  process.exit(1)
}

const queue = requested.map((name) => `${ROOT_PREFIX}/${name}`)
const seen = new Set()
const failures = []
let dumpedCount = 0

while (queue.length > 0) {
  const asarDir = queue.shift()
  if (seen.has(asarDir)) continue
  seen.add(asarDir)

  if (dump(asarDir)) dumpedCount += 1

  const manifest = manifestOf(asarDir)
  if (manifest === null) {
    failures.push(asarDir)
    continue
  }

  // Runtime dependencies only: dev and peer packages are supplied by the host.
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    queue.push(resolveDependency(dependency, asarDir))
  }
}

const extracted = [...seen].filter((dir) => manifestOf(dir) !== null)
writeFileSync(
  path.join(OUT, '.extracted.json'),
  `${JSON.stringify({ asar: ASAR, extracted: extracted.length, dumpedAt: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
)

console.log(`extract-harness: ${extracted.length}/${seen.size} packages resolved, ${dumpedCount} newly dumped into _research/asar-nm`)
if (failures.length > 0) {
  console.error(`extract-harness: ${failures.length} unresolved (host may not ship them): ${failures.slice(0, 10).join(', ')}`)
  process.exit(1)
}
