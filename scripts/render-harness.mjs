/**
 * Build a static page that reproduces the panel's layout inside a simulated host shell.
 *
 * Why this exists: the real Web GUI needs credentials this session does not have
 * (127.0.0.1:52525 answers 401) and the client bundle lives inside app.asar, which is not
 * readable from here. Without a real browser the layout claims would be guesses.
 *
 * So instead of guessing, this writes the panel's *actual CSS* — extracted from
 * client.js at run time, not copied — into a page whose surrounding shell mimics what a
 * main-slot host provides: a fixed sidebar, a scrollable column, and a `main` region.
 * A headless browser can then answer the questions that matter with a real layout engine:
 * does the page scroll, is content clipped, does the wheel reach the bottom.
 *
 * The shell is an approximation of the host, and the report says so.
 *
 * Usage: node scripts/render-harness.mjs [outFile]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/**
 * Extract the panel's CSS template literal from client.js.
 *
 * Matched by its own delimiters rather than by copying, so the harness can never drift
 * from the stylesheet the plugin actually ships.
 *
 * @param {string} source - client.js contents.
 * @returns {string} the CSS.
 */
export function extractCss(source) {
  const start = source.indexOf('const CSS = `')
  if (start === -1) throw new Error('client.js no longer defines a `const CSS = ` template literal')
  const from = start + 'const CSS = `'.length
  let index = from
  while (index < source.length) {
    const next = source.indexOf('`', index)
    if (next === -1) break
    // Skip an escaped backtick.
    let backslashes = 0
    for (let walk = next - 1; walk >= from && source[walk] === '\\'; walk -= 1) backslashes += 1
    if (backslashes % 2 === 0) return source.slice(from, next)
    index = next + 1
  }
  throw new Error('the CSS template literal was not terminated')
}

/**
 * Build fixture atoms that look like the real store: long text, several categories, a
 * mix of kinds and lifecycle tiers.
 * @param {number} count - how many.
 * @returns {object[]} fixture rows.
 */
export function fixtureAtoms(count) {
  const kinds = ['constraint', 'decision', 'fact', 'pitfall', 'summary', 'preference']
  const tiers = ['HOT', 'WARM', 'YOUNG', 'COLD']
  const categories = ['mod:lib', 'dom:constraint', 'task:bugfix', 'dom:memory-routing', 'mod:tests']
  const rows = []
  for (let index = 0; index < count; index += 1) {
    rows.push({
      id: `${(index + 1).toString(16).padStart(16, '0')}`,
      kind: kinds[index % kinds.length],
      tier: tiers[index % tiers.length],
      category: [categories[index % categories.length], categories[(index + 2) % categories.length]],
      weight: 1 + (index % 5),
      text:
        index % 7 === 0
          ? `A deliberately long memory that has to wrap rather than overflow: ${'the panel must not let long content push controls off screen, '.repeat(3)}`
          : `Fixture memory statement number ${index + 1} about the router protocol and lifecycle scoring.`,
    })
  }
  return rows
}

/**
 * Render the harness page.
 *
 * @param {{ css: string, atoms: object[], shell: 'scroll' | 'fixed' }} input - page inputs.
 * @returns {string} HTML.
 */
export function renderPage(input) {
  const rows = input.atoms
    .map(
      (atom) => `
      <div class="pm-atom" data-id="${atom.id}" tabindex="0">
        <div class="pm-atom-head">
          <span class="pm-chip lead">${atom.kind}</span>
          <span class="pm-chip">${atom.tier}</span>
          ${atom.category.map((id) => `<span class="pm-chip">${id}</span>`).join('')}
          <span class="pm-num">w${atom.weight}</span>
        </div>
        <div class="pm-atom-text">${atom.text}</div>
      </div>`,
    )
    .join('')

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>project memory — render harness</title>
<style>
  /* The host shell, approximated: a fixed sidebar and a main region that scrolls. */
  html, body { margin: 0; height: 100%; background: #14161a; color: #e6e8ec; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  #shell { display: flex; height: 100%; min-height: 0; }
  #nav { flex: 0 0 220px; border-right: 1px solid #2a2e36; padding: 12px; overflow-y: auto; }
  #nav .brand { font-weight: 600; margin-bottom: 12px; }
  #nav .item { padding: 6px 8px; border-radius: 6px; opacity: 0.7; font-size: 13px; }
  #nav .item.on { background: #232833; opacity: 1; }
  /* The scroll region: this is what a host main slot usually provides. */
  #main { flex: 1 1 auto; min-width: 0; min-height: 0; overflow-y: auto; }
  ${input.shell === 'fixed' ? '#main { overflow: hidden; }' : ''}
</style>
<style>${input.css}</style>
<body>
<div id="shell">
  <nav id="nav">
    <div class="brand">DeepSeek Harness</div>
    <div class="item">session</div>
    <div class="item">files</div>
    <div class="item on">project memory</div>
    <div class="item">goals</div>
  </nav>
  <main id="main">
    <div class="pm-panel">
      <div class="pm-head">
        <div>
          <div class="pm-title">Project memory</div>
          <div class="pm-sub">/path/to/project</div>
        </div>
      </div>
      <div class="pm-card lead">
        <div class="pm-card-title">last compaction</div>
        <div class="pm-headline">21:34 wrote 53 atoms</div>
      </div>
      <div class="pm-card">
        <div class="pm-card-title">totals</div>
        <div class="pm-row"><span>live</span><span class="pm-num">400</span></div>
        <div class="pm-row"><span>standing</span><span class="pm-num">106</span></div>
        <div class="pm-chips">${['HOT 12', 'WARM 88', 'COLD 300', 'YOUNG 0'].map((c) => `<span class="pm-chip">${c}</span>`).join('')}</div>
      </div>
      <div class="pm-card">
        <div class="pm-card-title">memory explorer</div>
        <input class="pm-input" placeholder="search memory">
        <div class="pm-group">${rows}</div>
      </div>
      <div class="pm-card">
        <div class="pm-card-title">router trace</div>
        <div class="pm-muted">route subagent · 7 atom(s) · ~399 tokens</div>
      </div>
      <div class="pm-card">
        <div class="pm-card-title">settings</div>
        <div class="pm-row"><span>semanticRouting</span><span class="pm-num">off</span></div>
      </div>
      <div style="height: 40px"></div>
    </div>
  </main>
</div>
</body>
</html>`
}

/** Whether this file is the entry point, tolerant of Windows path separators. */
function isMain() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  const normalized = entry.replace(/\\/g, '/')
  return import.meta.url === `file:///${normalized}` || import.meta.url === `file://${normalized}`
}

if (isMain()) {
  const css = extractCss(readFileSync(join(root, 'client.js'), 'utf8'))
  const out = process.argv[2] ?? join(root, '.dsh-memory', 'render-harness.html')
  const atoms = fixtureAtoms(60)
  writeFileSync(`${out}.scroll.html`, renderPage({ css, atoms, shell: 'scroll' }), 'utf8')
  writeFileSync(`${out}.fixed.html`, renderPage({ css, atoms, shell: 'fixed' }), 'utf8')
  console.log(`wrote ${out}.scroll.html and ${out}.fixed.html (${css.length} bytes of panel CSS, ${atoms.length} fixture atoms)`)
}
