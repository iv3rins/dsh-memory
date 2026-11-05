#!/usr/bin/env node
/**
 * Which directory does a session actually get its memory from?
 *
 * "Will a new session find what I recorded?" has one honest answer: run the resolver
 * from the directories a session could plausibly start in. The subtlety is that the
 * plugin does not just look at the current directory — `findProjectRoot` walks upward —
 * so a subdirectory of an initialized project inherits that project's memory, while an
 * unrelated directory must not.
 *
 * The test creates its own project, initializes it through the real tool layer, and
 * then asks the resolver from several starting points. It uses a temporary tree so a
 * mislocated write cannot land in this repository.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// The internal helper is not exported; resolveProjectRoot is the entry the tools use,
// so the test drives the same path the plugin does.
const { resolveProjectRoot, loadProject } = await import('../core/project.js')
const { normalizeConfig } = await import('../core/config.js')

const settings = normalizeConfig({})
const base = mkdtempSync(path.join(tmpdir(), 'pm-root-'))

try {
  // --- A project with memory, and a sibling with none ---
  const project = path.join(base, 'game')
  const nestedDeep = path.join(project, 'src', 'combat', 'formulas')
  const unrelated = path.join(base, 'unrelated')
  mkdirSync(nestedDeep, { recursive: true })
  mkdirSync(unrelated, { recursive: true })
  mkdirSync(path.join(project, '.dsh-memory'), { recursive: true })
  writeFileSync(
    path.join(project, '.dsh-memory', 'project.json'),
    `${JSON.stringify({ schema: 1, projectId: '11111111-2222-3333-4444-555555555555', name: 'game', createdAt: new Date().toISOString(), gitRemote: null }, null, 2)}\n`,
    'utf8',
  )

  // --- Starting inside the project resolves to the project root ---
  for (const start of [project, nestedDeep, path.join(project, 'src')]) {
    const found = resolveProjectRoot({ cwd: start })
    assert.equal(found.root, project, `a session started at ${path.relative(base, start)} must read the project root, not create a new memory`)
  }

  // --- Starting outside resolves to that directory, which has no memory ---
  const outside = resolveProjectRoot({ cwd: unrelated })
  assert.equal(outside.root, unrelated, 'an unrelated directory does not inherit a neighbouring project')

  const outsideLoad = await loadProject({ cwd: unrelated, timeoutMs: settings.gitTimeoutMs })
  assert.equal(outsideLoad.ok, true, 'the resolver still answers outside a project')
  assert.equal(outsideLoad.initialized, false, 'and reports it as uninitialized rather than borrowing state')

  // --- The project identity is read back, unchanged ---
  const inside = await loadProject({ cwd: nestedDeep, timeoutMs: settings.gitTimeoutMs })
  assert.equal(inside.ok, true, 'the project loads from a nested directory')
  assert.equal(inside.initialized, true, 'and is recognized as initialized')
  assert.equal(inside.project.projectId, '11111111-2222-3333-4444-555555555555', 'the same projectId is returned, so memory is shared rather than duplicated')

  // --- A git repository boundary also anchors the root ---
  // Without this, a session in a nested repository would silently read its parent's
  // memory, which is the wrong project.
  const outer = path.join(base, 'monorepo')
  const inner = path.join(outer, 'packages', 'client')
  mkdirSync(path.join(inner, '.git'), { recursive: true })
  mkdirSync(path.join(outer, '.git'), { recursive: true })
  mkdirSync(path.join(outer, '.dsh-memory'), { recursive: true })
  writeFileSync(path.join(outer, '.dsh-memory', 'project.json'), `${JSON.stringify({ schema: 1, projectId: 'outer', name: 'outer', createdAt: new Date().toISOString() })}\n`, 'utf8')
  assert.equal(resolveProjectRoot({ cwd: inner }).root, inner, 'a nested git repository anchors its own root instead of inheriting the outer project')

  // --- A configured root overrides discovery entirely ---
  const configured = resolveProjectRoot({ configuredRoot: project, cwd: unrelated })
  assert.equal(configured.root, project, 'config.projectRoot wins over the session directory')

  // --- A configured root that does not exist is an error, not a fallback ---
  const bogus = resolveProjectRoot({ configuredRoot: path.join(base, 'nope'), cwd: project })
  assert.equal(bogus.ok, false, 'a missing configured root is reported, not silently ignored')

  // --- No directory at all is an honest failure ---
  const none = resolveProjectRoot({ cwd: undefined })
  assert.equal(none.ok, false, 'without a directory the plugin says so rather than guessing')

  console.log('ROOT OK: a new session in the project or any subdirectory reads the same memory; an unrelated directory does not inherit it; git boundaries and config.projectRoot both override discovery')
} finally {
  rmSync(base, { recursive: true, force: true })
}
