#!/usr/bin/env node
/**
 * The Client half, checked without a browser.
 *
 * `client.js` is the one file here that no other test touches, and it has two
 * failure modes that a passing Host test cannot see:
 *
 * 1. **A dictionary key the panel uses but never defines.** The panel renders the raw
 *    key instead of a sentence, in the user's own sidebar. Static because it must be:
 *    the strings only appear when a particular branch renders.
 * 2. **A slot registration that does not line up.** A sidebar entry whose id no main
 *    panel answers opens an empty column, and the Loader does not complain.
 *
 * Both are checked by evaluating the real module against a stub loader, so the file
 * under test is the shipped file rather than a copy of its structure.
 *
 * Also checks the manifest wiring, because a panel that is not declared as a Client
 * bundle is never loaded however correct the code is.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.join(import.meta.dirname, '..')
const source = readFileSync(path.join(root, 'client.js'), 'utf8')
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

// --- 1. The manifest declares a Client half that resolves to this file. ---
{
  assert.equal(manifest.dsh?.client?.platform, 'web', 'package.json declares a web Client half')
  assert.equal(manifest.exports?.['./client'], './client.js', 'the ./client export points at client.js')
  assert.equal(manifest.exports?.['./icon'], './icon.svg', 'and an icon export exists')
  assert.equal(manifest.files?.includes('client.js'), true, 'client.js is published, not just present')
  assert.equal(manifest.files?.includes('icon.svg'), true, 'the icon is published')
  assert.equal(manifest.name, '@dsh-external/dsh-project-memory', 'the package name the loader keys on')
}

// --- 2. The module loads and registers a matching sidebar entry and main panel. ---
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
      return definition
    },
  },
}

/** A React stub: enough for module evaluation, not for rendering. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  useMemo: (fn) => fn(),
}

const moduleUrl = pathToFileURL(path.join(root, 'client.js')).href
await import(moduleUrl)

assert.notEqual(loaded, null, 'client.js calls __ModuleLoader__.load')
assert.equal(loaded.id, manifest.name, 'the module id is the package name, which is how the loader keys it')

const exported = loaded.factory((specifier) => {
  assert.equal(specifier, 'react', 'the factory only requires react')
  return reactStub
})
assert.equal(typeof exported.apply, 'function', 'the Client half exports apply')
assert.deepEqual(exported.inject.slice().sort(), ['locale', 'slots'], 'it injects exactly the services it uses')

// --- 3. Registration: one sidebar row and one answered main panel. ---
{
  const sidebarRegistrations = []
  const mainRegistrations = []
  const dictionaryRegistrations = []

  const fakeCtx = {
    effect: (fn) => {
      fn()
      return () => {}
    },
    locale: {
      register: (ns, dicts) => {
        dictionaryRegistrations.push({ ns, dicts })
        return () => {}
      },
      bind: (ns) => (key) => `[[${ns}:${key}]]`,
    },
    slots: {
      inject: (key, callback) => callback(),
      register: (spec, component) => {
        if (spec.name === 'sidebar.panellist') sidebarRegistrations.push({ spec, component })
        if (spec.name === 'main') mainRegistrations.push({ spec, component })
        return () => {}
      },
    },
  }

  exported.apply(fakeCtx)

  assert.equal(dictionaryRegistrations.length, 1, 'one dictionary namespace is registered')
  assert.equal(sidebarRegistrations.length, 1, 'exactly one sidebar entry is added')
  assert.equal(mainRegistrations.length, 1, 'exactly one main panel is added')

  const sidebar = sidebarRegistrations[0].spec
  const main = mainRegistrations[0].spec
  assert.equal(sidebar.id, main.key, 'the sidebar id is the key the main panel answers, so the button opens something')
  assert.equal(typeof sidebar.label, 'function', 'the label is a thunk, so it follows the active locale')
  assert.equal(typeof sidebar.order, 'number', 'the entry declares a position')
  assert.equal(typeof sidebarRegistrations[0].component, 'function', 'the entry renders an icon component')
  assert.equal(typeof mainRegistrations[0].component, 'function', 'the panel is a component')
  assert.equal(typeof main.inject, 'function', 'the panel receives its dictionary through inject')

  // The label must resolve through the dictionary rather than a literal, or the
  // sidebar shows one language forever.
  const label = sidebar.label()
  assert.match(label, /^\[\[project-memory:/, 'the sidebar label comes from the dictionary')
}

// --- 4. Every key the panel asks for is defined in both dictionaries. ---
{
  const used = new Set()
  // `t('key')` plus the `fill(t('key'), {...})` form, which is the same call.
  for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'\s*\)/g)) used.add(match[1])
  assert.ok(used.size >= 20, `the panel asks for a substantial number of strings (found ${used.size})`)

  const dictionaries = source
  // Reuse the module rather than re-parsing: the dictionaries are registered above.
  const registered = (() => {
    let captured = null
    const ctx = {
      effect: (fn) => {
        fn()
        return () => {}
      },
      locale: {
        register: (ns, dicts) => {
          captured = dicts
          return () => {}
        },
        bind: () => (key) => key,
      },
      slots: { inject: (key, callback) => callback(), register: () => () => {} },
    }
    exported.apply(ctx)
    return captured
  })()

  assert.notEqual(registered, null, 'the dictionaries were registered')
  assert.deepEqual(Object.keys(registered).sort(), ['en', 'zh'], 'there is one dictionary per supported language')

  for (const language of Object.keys(registered)) {
    const dictionary = registered[language]
    const missing = [...used].filter((key) => typeof dictionary[key] !== 'string')
    assert.deepEqual(missing, [], `${language} defines every key the panel uses`)
    const extra = Object.keys(dictionary).filter((key) => !used.has(key))
    assert.deepEqual(extra, [], `${language} defines no unused key, so the dictionary cannot rot`)
  }

  // Placeholders must match across languages: a translator dropping `{count}` turns a
  // warning with a number in it into a warning with no number in it.
  for (const key of used) {
    const pattern = (text) => (text.match(/\{(\w+)\}/g) ?? []).slice().sort().join(',')
    assert.equal(
      pattern(registered.zh[key]),
      pattern(registered.en[key]),
      `${key} uses the same placeholders in zh and en`,
    )
  }
  void dictionaries
}

// --- 5. The panel's routes match the Host's. ---
{
  const hostPanel = await import('../lib/panel.js')
  assert.equal(source.includes(hostPanel.STATUS_PATH), true, 'the Client asks the status route the Host serves')
  assert.equal(source.includes(hostPanel.CONFIG_PATH), true, 'the Client posts to the config route the Host serves')
  assert.equal(hostPanel.STATUS_PATH.startsWith('/project-memory/'), true, 'the route is namespaced to this plugin')
}

// --- 6. The panel offers exactly the values the Host validator accepts. ---
{
  const config = await import('../core/config.js')
  for (const tier of config.ROUTER_TIERS) {
    assert.equal(source.includes(`${tier}:`), true, `the panel describes the "${tier}" tier`)
  }
  for (const strategy of config.ROUTER_STRATEGIES) {
    assert.equal(source.includes(`${strategy}:`), true, `the panel describes the "${strategy}" strategy`)
  }
}

delete globalThis.window
console.log('CLIENT OK: the panel registers a matching sidebar entry and main panel, every string it asks for exists in both languages with the same placeholders, and its routes and choices match the Host')
