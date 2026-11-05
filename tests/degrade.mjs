#!/usr/bin/env node
/**
 * Prove that the entry survives a host where optional services are missing.
 *
 * This is the regression test for a real bug that shipped into a draft of this
 * plugin: `if (ctx.commands !== undefined) ...` reads as a guard but is not one.
 * Cordis resolves services through a proxy that *throws* for an unprovided service
 * inside a plugin body, so a plugin that touches an optional service eagerly loses
 * everything it registers — including its tools — on any profile that omits that
 * service. `?.` and `try/catch` behave differently here, so both patterns the entry
 * actually uses are exercised against a host with nothing but `tools`.
 *
 * SKIPs when the harness packages are not linked.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const NM = path.join(import.meta.dirname, '..', '_research', 'asar-nm', '@deepseek-ai')
let Context
let ToolRuntime
let SystemPrompt
try {
  // `cordis` and `dsh-system-prompt` export their classes by name; `dsh-tools`
  // exports the runtime as its default. Reading each the wrong way produced a
  // "{...} is not a function" SKIP here, which is why the two are loaded separately
  // rather than through one generic helper.
  ;({ Context } = await import(pathToFileURL(path.join(NM, 'cordis', 'lib', 'index.js')).href))
  ;({ default: ToolRuntime } = await import(pathToFileURL(path.join(NM, 'dsh-tools', 'lib', 'index.js')).href))
  ;({ default: SystemPrompt } = await import(pathToFileURL(path.join(NM, 'dsh-system-prompt', 'lib', 'index.js')).href))
} catch (error) {
  console.log(`SKIP: harness packages unavailable (${error.code ?? error.message}); degradation not tested`)
  process.exit(0)
}
if (typeof Context !== 'function' || typeof ToolRuntime !== 'function' || typeof SystemPrompt !== 'function') {
  console.log(`SKIP: harness packages are not the expected shape (Context=${typeof Context}, ToolRuntime=${typeof ToolRuntime}, SystemPrompt=${typeof SystemPrompt})`)
  process.exit(0)
}

const plugin = await import('../lib/index.js').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') {
    console.log('SKIP: plugin modules unavailable (run `npm run link:harness`)')
    process.exit(0)
  }
  throw error
})

const wait = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Mount a host with exactly the services named, then mount the plugin.
 *
 * `ToolRuntime` declares `static inject = ['systemPrompt']`, so `systemPrompt` is not
 * an optional extra here — it is a prerequisite of the tools service itself. The
 * services this test withholds are the ones the plugin treats as optional:
 * `commands` and `workingDirectory`.
 */
async function mountHost() {
  const ctx = new Context()
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(ToolRuntime, {})
  await wait()
  return ctx
}

// --- A host without `commands` and without `workingDirectory`. ---
{
  const ctx = await mountHost()
  // Prove the services are absent, not merely empty: the whole point is that the
  // plugin tolerates services it never declared a dependency on.
  // A bare context reads an unprovided service as undefined (only a plugin body
  // throws), so this is the correct probe from here — see tests/cordis-semantics.mjs.
  assert.equal(ctx.commands, undefined, 'the test host really has no commands service')
  assert.equal(ctx.workingDirectory, undefined, 'the test host really has no workingDirectory service')

  const fiber = ctx.plugin(plugin, {})
  await fiber
  await wait(200)

  const names = ctx.tools.schemas().map((schema) => schema.name)
  const ours = names.filter((n) => n.startsWith('memory_') || n.startsWith('state_') || n.startsWith('project_') || n.startsWith('docs_') || n === 'architecture_check')
  assert.equal(ours.length, 15, `all 15 tools must register on a host without optional services; got ${ours.length} (${ours.join(', ')})`)

  const status = await ctx.tools.execute({
    name: 'memory_status',
    arguments: {},
    callId: 'bare-1',
    signal: new AbortController().signal,
  })
  assert.equal(Boolean(status.isError), false, 'a tool still works with no optional services present')

  // This is the call that exercises the `workingDirectory` guard: the tool needs a
  // directory, the service is missing, and it must fall back rather than throw.
  const inspect = await ctx.tools.execute({
    name: 'project_inspect',
    arguments: {},
    callId: 'nodir-1',
    signal: new AbortController().signal,
  })
  assert.equal(Boolean(inspect.isError), false, 'project_inspect works without a workingDirectory service')

  await fiber.dispose()
  await wait()
  assert.equal(ctx.tools.schemas().filter((s) => s.name === 'memory_status').length, 0, 'disposal still unregisters')
}

// --- Configuration that turns features off must not break the rest. ---
{
  const ctx = await mountHost()
  const fiber = ctx.plugin(plugin, { registerCommands: false, announceToAgent: false })
  await fiber
  await wait(150)
  assert.equal(ctx.tools.schemas().filter((s) => s.name === 'memory_status').length, 1, 'disabling commands and prompt sections still registers tools')
  await fiber.dispose()
  await wait()
}

// --- `enabled: false` must register nothing at all. ---
{
  const ctx = await mountHost()
  const before = ctx.tools.schemas().length
  const fiber = ctx.plugin(plugin, { enabled: false })
  await fiber
  await wait(150)
  assert.equal(ctx.tools.schemas().length, before, 'a disabled plugin registers no tools')
  await fiber.dispose()
  await wait()
}

console.log('DEGRADE OK: the plugin registers all 15 tools and stays functional when optional services are absent')