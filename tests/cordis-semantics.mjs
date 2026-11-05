#!/usr/bin/env node
/**
 * Verify the cordis semantics this plugin's optional-service handling depends on.
 *
 * Three facts, measured rather than assumed, because the plugin's structure depends
 * on all three:
 *
 * 1. Reading an unavailable service **inside a plugin body throws**
 *    (`cannot get property "x" without inject`). It does not return undefined. So
 *    `if (ctx.commands !== undefined)` is not a guard — it is a crash. This is why
 *    the optional registrations go through `ctx.inject([...], cb)`.
 * 2. Reading from a bare context outside any plugin returns undefined, which is why
 *    a probe written there would give the wrong answer about behavior #1.
 * 3. `ctx.inject` defers its callback until the service exists, and a missing
 *    service never blocks the rest of the plugin from mounting.
 *
 * SKIPs (exit 0) when the harness packages are unavailable.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const NM = path.join(import.meta.dirname, '..', '_research', 'asar-nm', '@deepseek-ai')
let Context
let Service
try {
  const cordis = await import(pathToFileURL(path.join(NM, 'cordis', 'lib', 'index.js')).href)
  Context = cordis.Context
  Service = cordis.Service
} catch (error) {
  console.log(`SKIP: cordis unavailable (${error.code ?? error.message}); semantic checks not run`)
  process.exit(0)
}

const wait = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms))

// 1. Inside a plugin body, an unavailable service throws rather than reading as undefined.
{
  const ctx = new Context()
  let observed = null
  ctx.plugin({
    name: 'probe-throw',
    apply(inner) {
      try {
        observed = { kind: 'returned', type: typeof inner.commands }
      } catch (error) {
        observed = { kind: 'threw', message: error.message }
      }
    },
  }, {})
  await wait()
  assert.ok(observed !== null, 'the probe ran')
  assert.equal(observed.kind, 'threw', 'reading an unavailable service inside a plugin body must throw')
  assert.match(observed.message, /cannot get property|without inject/, 'the throw names the missing inject')
}

// 2. A bare context is not representative: it returns undefined instead of throwing.
{
  const ctx = new Context()
  assert.equal(ctx.commands, undefined, 'a bare context reads undefined, which is why it is the wrong place to probe behavior #1')
}

// 3. `ctx.inject` defers, then runs once the service appears.
{
  const ctx = new Context()
  let ran = false
  let seen = null
  ctx.plugin({
    name: 'probe-inject',
    apply(inner) {
      inner.inject(['widget'], (scoped) => {
        ran = true
        seen = typeof scoped.widget
      })
    },
  }, {})
  await wait()
  assert.equal(ran, false, 'inject must not run before the service is provided')

  class Widget extends Service {
    constructor(scope) { super(scope, 'widget') }
  }
  ctx.plugin(Widget, {})
  await wait(150)
  assert.equal(ran, true, 'inject runs after the service is provided')
  assert.equal(seen, 'object', 'the injected service is readable inside the callback')
}

// 4. A missing optional service must not block the rest of the plugin.
{
  const ctx = new Context()
  const parts = []
  ctx.plugin({
    name: 'probe-partial',
    apply(inner) {
      inner.effect(() => {
        parts.push('required')
        return () => {}
      })
      inner.inject(['neverProvided'], () => parts.push('optional'))
    },
  }, {})
  await wait(120)
  assert.deepEqual(parts, ['required'], 'the required part mounts while the optional part stays deferred')
}

console.log('CORDIS OK: unavailable services throw inside plugin bodies, ctx.inject defers correctly, and a missing optional service does not block mounting')
