/**
 * Structural UI tests for the dashboard that run without a browser.
 *
 * These do not replace the real-browser measurements (scripts/verify-panel.mjs); they
 * guard the properties that can be checked by reading the source, so a later edit cannot
 * quietly reintroduce the two bugs this rewrite fixed:
 *
 *   - the page must own a scroll container, with `min-height: 0` on the flex child,
 *   - the toolbar and tabs must not be inside that scroll container.
 *
 * Run: node tests/ui.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/** One passing section. */
function line(text) {
  console.log(`UI: ${text}`)
}

/** Extract the stylesheet. */
function css() {
  const start = source.indexOf('const CSS = `')
  assert.notEqual(start, -1, 'the panel ships a stylesheet')
  const from = start + 'const CSS = `'.length
  const end = source.indexOf('`', from)
  assert.notEqual(end, -1, 'the stylesheet is terminated')
  return source.slice(from, end)
}

// ------------------------------------------------------------ scroll contract
{
  const styles = css()

  const rule = (selector) => {
    const index = styles.indexOf(`${selector} {`)
    assert.notEqual(index, -1, `${selector} is defined`)
    const end = styles.indexOf('}', index)
    return styles.slice(index, end)
  }

  // The root is a full-height column that does not scroll itself.
  const root = rule('.pm-root')
  assert.match(root, /height:\s*100%/, '.pm-root fills its parent')
  assert.match(root, /min-height:\s*0/, '.pm-root can shrink below its content')
  assert.match(root, /overflow:\s*hidden/, '.pm-root does not scroll; the body does')
  assert.match(root, /flex-direction:\s*column/, '.pm-root stacks toolbar over body')

  // The body is the one scroll container, and it is allowed to shrink.
  const body = rule('.pm-body')
  assert.match(body, /min-height:\s*0/, '.pm-body may shrink: this is what makes it scrollable')
  assert.match(body, /overflow-y:\s*auto/, '.pm-body is the scroll container')
  assert.match(body, /flex:\s*1 1 auto/, '.pm-body takes the remaining height')
  assert.match(body, /overscroll-behavior:\s*contain/, 'a scroll that ends does not chain to the app')

  // The chrome must not shrink, or it scrolls away with the content.
  assert.match(rule('.pm-toolbar'), /flex:\s*0 0 auto/, 'the toolbar keeps its height')
  assert.match(rule('.pm-tabs'), /flex:\s*0 0 auto/, 'the tab bar keeps its height')

  // The drawer is bounded and scrolls internally.
  assert.match(rule('.pm-drawer-body'), /overflow-y:\s*auto/, 'the drawer body scrolls')
  assert.match(rule('.pm-drawer-body'), /min-height:\s*0/, 'the drawer body may shrink')
  assert.match(rule('.pm-drawer'), /position:\s*absolute/, 'the drawer overlays the page')

  line('the page owns the scroll container and the chrome cannot shrink into it')
}

// ---------------------------------------------------------- reduced motion
{
  const styles = css()
  const mediaBlocks = [...styles.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((match) => match[1])
  assert.ok(mediaBlocks.length >= 3, 'every animation has a reduced-motion escape')
  const joined = mediaBlocks.join('\n')
  for (const property of ['animation: none', 'scroll-behavior: auto']) {
    assert.ok(joined.includes(property), `reduced motion disables ${property}`)
  }
  // No transition may be long enough to feel like lag.
  const durations = [...styles.matchAll(/transition:[^;]*?(\d+)ms/g)].map((match) => Number(match[1]))
  assert.ok(durations.length > 0, 'transitions are declared')
  for (const value of durations) {
    assert.ok(value <= 220, `transition of ${value}ms is within the 100-220ms budget`)
  }
  line('motion is bounded and every animation honours prefers-reduced-motion')
}

// ---------------------------------------------------------------- structure
{
  // The shell must render the stylesheet element, not return CSS from the factory.
  assert.ok(source.includes("h('style', { key: 'pm-css' }, CSS)"), 'the stylesheet is rendered as an element')
  assert.ok(!/return \{ inject: \[[^\]]*\], apply, CSS \}/.test(source), 'CSS is not returned from the factory')

  // The dashboard is what the slot registers. The statement spans lines, so it is matched
  // with `[\s\S]` rather than `.` — and the registration is checked by its two halves,
  // because a stricter regex would test formatting instead of behaviour.
  assert.ok(source.includes("slots.register({ name: 'main'"), 'the main slot is registered')
  assert.ok(source.includes('}, MemoryDashboard)'), 'the dashboard is the registered main panel')

  // Navigation uses the host's close prop rather than history.
  assert.ok(source.includes('props.close()'), 'Back calls the host close handler')
  // Comments legitimately mention history.back() while explaining why it is avoided, so
  // the check runs on code lines only.
  const codeLines = source
    .split('\n')
    .filter((row) => {
      const trimmed = row.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
  assert.ok(!codeLines.includes('history.back'), 'Back never reaches for browser history')
  assert.ok(!codeLines.includes('window.close'), 'Back never closes the window')

  // The five tabs exist.
  for (const tab of ['overview', 'explorer', 'compactions', 'router', 'settings']) {
    assert.ok(source.includes(`['${tab}',`), `the ${tab} tab is declared`)
  }

  line('the stylesheet is rendered, the dashboard is registered, and Back is safe')
}

// ---------------------------------------------------------------- explorer
{
  // Filtering is by category id, never by colour.
  assert.ok(source.includes('row.category ?? []).includes(category)'), 'the category filter compares ids')
  assert.ok(!/includes\(\s*(color|colour|hex)\s*\)/.test(source), 'no filter compares colours')

  // Search is debounced rather than applied per keystroke.
  assert.match(source, /setTimeout\(\(\) => setDebounced/, 'search is debounced')
  assert.match(source, /clearTimeout\(timer\)/, 'the debounce timer is cleaned up')

  // The list paginates instead of rendering everything.
  assert.match(source, /filtered\.slice\(0, shown\)/, 'the list is paged')
  assert.match(source, /setShown\(\(n\) => n \+ 40\)/, 'a load-more control extends it')

  // Rows are buttons, so keyboard access is inherent.
  assert.match(source, /className: 'pm-atom',[\s\S]{0,80}onClick:/, 'a memory row is a clickable button')

  line('filters use ids, search is debounced, and the list is paged')
}

// ------------------------------------------------------------------ drawer
{
  assert.ok(source.includes("if (event.key === 'Escape')"), 'Escape closes the drawer')
  assert.ok(source.includes("document.addEventListener('keydown', onKey, true)"), 'the drawer listens for keys')
  assert.ok(source.includes("removeEventListener('keydown', onKey, true)"), 'the listener is removed on close')
  assert.ok(source.includes("role: 'dialog'"), 'the drawer announces itself as a dialog')
  assert.ok(source.includes("'aria-modal': 'true'"), 'the drawer is modal to assistive tech')
  assert.ok(source.includes('closeRef.current.focus()'), 'focus moves into the drawer')
  assert.ok(source.includes('detail.sourceUnavailable'), 'an unavailable source is stated, not omitted')

  line('the drawer traps focus, closes on Escape, and labels itself')
}

// -------------------------------------------------------------- honesty
{
  // Metrics the backend cannot supply must be rendered as "not collected".
  assert.ok(source.includes("t('trace.notCollected')"), 'unmeasured values say so')
  assert.ok(source.includes("t('trace.intentNone')"), 'a missing task intent is stated, not invented')
  // Capacity must not describe cold memory as deleted.
  assert.ok(source.includes("t('capacity.coldHint')"), 'the panel explains that cold memory is retained')
  assert.ok(!/t\('capacity\.cold(Deleted|Removed)'\)/.test(source), 'cold memory is never called deleted')

  line('unmeasured metrics and retained cold memory are described honestly')
}

console.log('')
console.log(
  'UI OK: the page owns a shrinkable scroll container with fixed chrome, motion honours reduced-motion, ' +
  'Back uses the host handler, the explorer filters by id and pages its list, the drawer is modal and escapable, ' +
  'and nothing claims a number the backend did not measure',
)
