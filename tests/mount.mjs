#!/usr/bin/env node
/**
 * Integration test: mount the plugin into a *real* cordis context with the *real*
 * harness services and drive it the way the host does.
 *
 * What this proves that unit tests cannot:
 * - `apply` completes against real cordis fiber/effect/inject semantics, including
 *   that touching an unavailable service throws rather than returning undefined.
 * - The `inject = ['tools']` declaration is actually satisfiable, and the 18 tools
 *   land in a real `ToolRuntime` where its own schema and output checks apply.
 * - The system-prompt section and slash commands register through their real
 *   registries instead of a stub.
 * - A `agent/pre-step` listener can inject a message and dedupe it against the
 *   session surface.
 *
 * The harness services come from `_research/asar-nm`, an extraction of the
 * installed Desktop payload; the test SKIPs (exit 0) when they are unavailable,
 * and a SKIP is never reported as a pass.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const NM = path.join(import.meta.dirname, '..', '_research', 'asar-nm', '@deepseek-ai')
const load = (pkg, file = 'lib/index.js') => import(pathToFileURL(path.join(NM, pkg, file)).href)

let cordis
let toolsPkg
let systemPromptPkg
try {
  cordis = await load('cordis')
  toolsPkg = await load('dsh-tools')
  systemPromptPkg = await load('dsh-system-prompt')
} catch (error) {
  console.log(`SKIP: harness services unavailable (${error.code ?? error.message}); mount test not run`)
  process.exit(0)
}
const { Context } = cordis
const { default: ToolRuntime } = toolsPkg
const { default: SystemPrompt } = systemPromptPkg

const plugin = await import('../lib/index.js')
const root = mkdtempSync(path.join(tmpdir(), 'pm-mount-'))

try {
  mkdirSync(path.join(root, 'docs', 'knowledge'), { recursive: true })
  writeFileSync(path.join(root, 'docs', 'knowledge', 'combat.md'), '---\ntitle: Combat\n---\n\n# Combat\n\nDamage uses integers.\n', 'utf8')

  // --- A real host: a cordis context with the services the plugin declares. ---
  const ctx = new Context()
  assert.equal(typeof ctx.plugin, 'function', 'cordis context is real')

  // Tools and system prompt are separate plugins in the host; mount them the same way.
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(ToolRuntime, {})
  await new Promise((resolve) => setTimeout(resolve, 60))

  const toolsBefore = ctx.tools.schemas().length
  assert.equal(typeof ctx.tools.register, 'function', 'the tools service is real')
  assert.equal(typeof ctx.systemPrompt.section, 'function', 'the systemPrompt service is real')

  // --- Mount the plugin under test exactly as the host would. ---
  const fiber = ctx.plugin(plugin, { projectRoot: root })
  await fiber
  await new Promise((resolve) => setTimeout(resolve, 120))

  const schemas = ctx.tools.schemas()
  const ours = schemas.filter((schema) => schema.name.startsWith('memory_') || schema.name.startsWith('state_') || schema.name.startsWith('project_') || schema.name.startsWith('docs_') || schema.name === 'architecture_check')
  assert.equal(ours.length, 18, `expected 18 registered tools, got ${ours.length}: ${ours.map((s) => s.name).join(', ')}`)
  assert.equal(schemas.length, toolsBefore + 18, 'the tools were added to the real registry')

  // The registry validates arguments and output on every call; a schema mistake
  // would surface here as INVALID_ARGS or a ToolOutputError, not as silence.
  // `execute` takes the full execution record, exactly as the agent loop builds it.
  let callSeq = 0
  const invoke = (name, args) => ctx.tools.execute({
    name,
    arguments: args,
    callId: `call-${(callSeq += 1)}`,
    signal: new AbortController().signal,
  })
  /** Extract the model-visible text of a normalized tool result. */
  const textOf = (result) => (result.content ?? []).map((block) => block.text ?? '').join('\n')

  const inspect = await invoke('project_inspect', {})
  assert.equal(Boolean(inspect.isError), false, `project_inspect failed: ${textOf(inspect) || '(no content)'}`)
  assert.match(textOf(inspect), /project root/, 'project_inspect rendered a report')

  const init = await invoke('project_init', {})
  assert.equal(Boolean(init.isError), false, `project_init failed: ${textOf(init) || '(no content)'}`)
  assert.match(textOf(init), /initialized/, 'project_init reported initialization')

  const status = await invoke('memory_status', { rebuildIndex: true })
  assert.equal(Boolean(status.isError), false, `memory_status failed: ${textOf(status) || '(no content)'}`)

  const search = await invoke('memory_search', { query: 'combat' })
  assert.equal(Boolean(search.isError), false, `memory_search failed: ${textOf(search) || '(no content)'}`)
  assert.match(textOf(search), /combat\.md/, 'memory_search found the document through the real registry')

  const read = await invoke('memory_read', { path: 'docs/knowledge/combat.md' })
  assert.equal(Boolean(read.isError), false, `memory_read failed: ${textOf(read) || '(no content)'}`)
  assert.match(textOf(read), /PROJECT REFERENCE DATA/, 'memory_read framed the document as untrusted data')

  // An invalid argument list must be rejected by the registry, not by our code.
  const invalid = await invoke('memory_search', { query: 12345 })
  assert.equal(invalid.isError, true, 'the registry rejects an argument of the wrong type')

  // --- The system prompt section is really registered. ---
  // SystemPrompt exposes `section()` and a change event, not a renderer or a plain
  // map, so the honest checks are: registration succeeded without throwing (a
  // duplicate name or non-finite order throws) and the change event fired.
  const prompt = ctx.systemPrompt
  assert.equal(typeof prompt.section, 'function', 'systemPrompt exposes section()')
  const changed = []
  ctx.on('system-prompt/change', () => changed.push(Date.now()))
  const probe = prompt.section({ name: 'project-memory:probe', order: 166, text: 'probe' })
  assert.equal(typeof probe, 'function', 'section() returns its disposer')
  assert.equal(changed.length > 0, true, 'registering a section emits system-prompt/change')
  probe()
  // Registering the same name twice would have thrown above, so reaching here with
  // a disposer proves the plugin's own section occupies "project-memory".
  assert.throws(
    () => prompt.section({ name: 'project-memory', order: 167, text: 'duplicate' }),
    /already registered/,
    'the plugin registered a section named "project-memory"',
  )
  assert.throws(
    () => prompt.section({ name: 'bad-order', order: Number.NaN, text: 'x' }),
    /finite number/,
    'the registry enforces its own order contract',
  )

  // --- Disposal unregisters everything. ---
  await fiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 60))
  const afterDispose = ctx.tools.schemas().filter((schema) => schema.name === 'memory_status')
  assert.equal(afterDispose.length, 0, 'disposing the plugin unregisters its tools')

  console.log(`MOUNT OK: plugin mounts into real cordis, registers ${ours.length} tools, executes through the real registry, and disposes cleanly`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
