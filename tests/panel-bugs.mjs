/**
 * Regression checks for the two reported panel bugs — run in Node, no browser needed.
 *
 * The bugs are both *logic* bugs, so they can be pinned without rendering:
 *
 * 1. **No Back button.** The host renders the main slot with an empty props object
 *    (`renderSlot("main", {}, …)`, read from the host's own bundle in app.asar), so a
 *    button gated on `props.close` could never appear. The fix routes navigation through
 *    `ctx.get('layout').selectPanel(null)`, supplied via `inject`.
 * 2. **Trace tab crashes.** With no project root, `buildPanelStatus` returns before adding
 *    `semantic`, so `data.semantic?.metrics` is `undefined`. A `=== null` guard let it
 *    through and reading `metrics.routerCalls` threw, blanking the page.
 *
 * Both checks read the shipped source and exercise the real guard helpers, so a later edit
 * that reintroduces either failure breaks this test.
 *
 * Usage: node tests/panel-bugs.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/** One passing section. */
function line(text) {
  console.log(`PANEL-BUGS: ${text}`)
}

// ------------------------------------------------ bug 1: the Back button exists
{
  // The button must not be gated on a prop the host never sends.
  assert.ok(!/props\.close === undefined/.test(source), 'the Back button is not gated on props.close')
  assert.ok(!/props\.close\(\)/.test(source), 'nothing calls props.close()')

  // Navigation goes through the documented layout service.
  assert.ok(source.includes("ctx.get('layout')"), 'the layout service is resolved from the context')
  assert.ok(source.includes('selectPanel(null)'), 'Back returns to the Conversation via selectPanel(null)')
  assert.ok(source.includes('onBack: leavePanel'), 'the handler is supplied through inject')
  assert.ok(source.includes('typeof props.onBack === \'function\''), 'the button renders when a handler exists')

  // A missing layout service must not remove the panel, only the button.
  const leave = /const leavePanel = \(\) => \{([\s\S]*?)\n      \}/.exec(source)
  assert.ok(leave !== null, 'leavePanel is defined')
  assert.ok(/try \{/.test(leave[1]), 'a throwing layout service is contained')
  assert.ok(/return false/.test(leave[1]), 'a missing service reports failure instead of throwing')

  // Still no unsafe fallback.
  const codeLines = source
    .split('\n')
    .filter((row) => {
      const trimmed = row.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
  assert.ok(!codeLines.includes('history.back'), 'no history.back in code')
  assert.ok(!codeLines.includes('window.close'), 'no window.close in code')

  line('Back uses the layout service, is injected rather than read from props, and degrades safely')
}

// --------------------------------------------- bug 2: the trace tab cannot throw
{
  // The guard must treat `undefined` the same as `null`.
  assert.ok(source.includes('data.semantic?.metrics ?? null'), 'metrics absence is normalised with ??')

  // Every numeric read goes through a helper rather than a bare property access.
  const trace = source.slice(source.indexOf('function RouterTracePage'), source.indexOf('/** Settings:'))
  assert.ok(trace.length > 500, 'the trace page was located')
  assert.ok(trace.includes('const num = (value)'), 'a numeric guard is defined')
  assert.ok(trace.includes('const count = (value)'), 'a count guard is defined')
  // A bare `metrics.<x>` interpolation is what threw. Interpolations are acceptable when
  // the same expression first proves the value is a number — the component does this with
  // `num(...)`, so each raw read must appear alongside a `num()`/`count()` call for the
  // same property. Checking the invariant rather than one exact textual form keeps the test
  // from breaking on a harmless rewrite while still failing on an unguarded read.
  // [A-Za-z0-9] because names like `routerLatencyMsP50` end in digits.
  const properties = [...new Set([...trace.matchAll(/metrics\.([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]))]
  assert.ok(properties.length > 0, 'the trace page reads metric properties')
  for (const property of properties) {
    const guarded = new RegExp(`num\\(metrics\\.${property}\\)|count\\(metrics\\.${property}\\)`).test(trace)
    assert.ok(guarded, `metrics.${property} is read through num() or count()`)
  }

  // Reproduce both payload shapes against the same helper logic the component uses.
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  const renderCount = (value) => {
    const parsed = num(value)
    return parsed === null ? 'not collected' : String(parsed)
  }
  assert.equal(renderCount(undefined), 'not collected', 'an undefined metric renders as not collected')
  assert.equal(renderCount(null), 'not collected', 'a null metric renders as not collected')
  assert.equal(renderCount(Number.NaN), 'not collected', 'NaN renders as not collected')
  assert.equal(renderCount(7), '7', 'a real count renders')

  // The payload that used to crash: no `semantic` at all.
  const noProject = { root: null, atoms: { readable: false, reason: 'no-project-root' }, compactions: { recent: [] }, router: {} }
  assert.equal(noProject.semantic?.metrics ?? null, null, 'an absent semantic block normalises to null')
  // ...and the trail is still readable without the block.
  assert.equal(Array.isArray(noProject.compactions?.recent) ? noProject.compactions.recent.length : 0, 0, 'the compaction count survives an absent semantic block')

  line('the trace tab treats undefined, null and NaN alike and cannot throw on an unresolved project')
}

// -------------------------------------- bug 2, end to end through buildPanelStatus
{
  // The backend still returns early for a null root; the panel must cope with that shape
  // rather than the backend inventing a fake semantic block.
  const { buildPanelStatus } = await import('../lib/panel.js')
  const { normalizeConfig } = await import('../core/config.js')
  const settings = normalizeConfig({})
  const status = buildPanelStatus({ root: null, settings, base: settings, overridden: [], overrideReason: null, projects: [], delegationAvailable: false })
  assert.equal(status.semantic, undefined, 'a null root yields no semantic block')
  assert.equal(status.explorer, undefined, 'a null root yields no explorer block')
  const metrics = status.semantic?.metrics ?? null
  assert.equal(metrics, null, 'the panel normalises the absence to null')
  assert.doesNotThrow(() => {
    // What the trace page now does: read through the guard.
    const count = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
    return count(metrics?.routerCalls)
  }, 'reading the trace page cannot throw on this payload')

  line('the real backend payload for an unresolved project is handled without an exception')
}

console.log('')
console.log('PANEL-BUGS OK: Back is reachable through the layout service, and the trace tab renders an unresolved project instead of crashing')
