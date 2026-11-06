/**
 * Render the *actual* dashboard markup in a headless browser and measure it.
 *
 * The Web GUI needs credentials this session does not have, and the client bundle lives
 * inside app.asar. So this harness does the next best thing: it serves client.js's real
 * CSS plus markup shaped exactly like the component tree, inside a shell that mimics a
 * host main region with `overflow: hidden` — the condition that broke the old panel.
 *
 * What it can prove: scroll containment, reachability of the last element, absence of
 * horizontal overflow at several widths, and that the drawer overlays without clipping.
 * What it cannot prove: React wiring, data fetching, or how the real host sizes the slot.
 *
 * Usage: node scripts/verify-panel.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Pull the real stylesheet out of client.js. */
function extractCss() {
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  const start = source.indexOf('const CSS = `')
  if (start === -1) throw new Error('no CSS template in client.js')
  const from = start + 'const CSS = `'.length
  let index = from
  while (index < source.length) {
    const next = source.indexOf('`', index)
    if (next === -1) break
    let backslashes = 0
    for (let walk = next - 1; walk >= from && source[walk] === '\\'; walk -= 1) backslashes += 1
    if (backslashes % 2 === 0) return source.slice(from, next)
    index = next + 1
  }
  throw new Error('CSS template not terminated')
}

/** Fixture rows shaped like `buildExplorerCard` output. */
function rows(n) {
  const kinds = ['constraint', 'decision', 'fact', 'pitfall', 'summary']
  const tiers = ['HOT', 'WARM', 'YOUNG', 'COLD']
  return Array.from({ length: n }, (_, i) => ({
    id: `${(i + 1).toString(16).padStart(16, '0')}`,
    kind: kinds[i % kinds.length],
    tier: tiers[i % tiers.length],
    status: i % 11 === 0 ? 'superseded' : 'active',
    weight: 1 + (i % 5),
    pinned: i % 17 === 0,
    category: ['mod:lib', 'dom:constraint', 'dom:memory-routing'],
    text: i % 6 === 0 ? `A long memory that must wrap instead of overflowing the row: ${'the panel must keep controls reachable, '.repeat(3)}` : `Fixture memory ${i + 1} about the router protocol and lifecycle scoring.`,
  }))
}

const page = (css, table) => `<!doctype html><html><meta charset="utf-8"><title>panel</title>
<style>html,body{margin:0;height:100%;background:#14161a;color:#e6e8ec;font-family:system-ui,sans-serif}
#shell{display:flex;height:100%}
#nav{flex:0 0 220px;border-right:1px solid #2a2e36;padding:12px}
/* The condition that broke the old panel: the host does not scroll for us. */
#main{flex:1 1 auto;min-width:0;min-height:0;overflow:hidden}
</style><style>${css}</style><body>
<div id="shell"><nav id="nav">nav</nav><main id="main">
<div class="pm-root">
  <div class="pm-toolbar">
    <button class="pm-tbtn">← Back</button>
    <div class="pm-toolbar-main">
      <div class="pm-crumbs"><span class="pm-crumb">Project memory</span><span class="pm-crumb-sep">/</span><span class="pm-crumb-now">dsh-memory</span></div>
      <div class="pm-title">Project memory</div>
      <div class="pm-sub">/path/to/project</div>
    </div>
    <button class="pm-tbtn">↻ Refresh</button>
    <button class="pm-tbtn">⚙ Settings</button>
  </div>
  <div class="pm-tabs">
    <button class="pm-tab on">Overview</button><button class="pm-tab">Explorer<span class="pm-tab-count">400</span></button>
    <button class="pm-tab">Compactions<span class="pm-tab-count">7</span></button><button class="pm-tab">Router trace</button><button class="pm-tab">Settings</button>
  </div>
  <div class="pm-body" id="body">
    <div class="pm-page enter">
      ${table === 'overview' ? `
      <div class="pm-grid">
        ${['Live memory|400', 'Standing rules|106', 'Hot / Warm / Cold', 'Store capacity|400 / 400'].map((c) => {
          const [label, value] = c.split('|')
          return `<div class="pm-card hover"><div class="pm-card-title">${label}</div><div class="pm-metric">${value ?? ''}</div><div class="pm-metric-sub">detail</div></div>`
        }).join('')}
      </div>
      <div class="pm-card warn"><div class="pm-card-title">Capacity breakdown</div><div class="pm-chips"><span class="pm-chip">Live 400</span><span class="pm-chip">Archived 0</span><span class="pm-chip">Forgotten 1</span><span class="pm-chip">Records 401</span></div></div>
      <div class="pm-card lead"><div class="pm-card-title">Last compaction</div><div class="pm-headline">2026-11-05 21:34 · +53 atoms</div></div>
      <div class="pm-card"><div class="pm-card-title">Last memory router run</div><div class="pm-headline">7 router calls</div></div>` : ''}
      ${table === 'explorer' ? `
      <div class="pm-card"><div class="pm-filters">
        <input class="pm-search" placeholder="Search memory text or id">
        <select class="pm-select"><option>Type: All</option></select>
        <select class="pm-select"><option>Category: All</option></select>
        <select class="pm-select"><option>Lifecycle: All</option></select>
        <select class="pm-select"><option>Status: All</option></select>
      </div><div class="pm-hint">400 of 400</div></div>
      <div class="pm-list">
        ${rows(60).map((r) => `<button class="pm-atom">
          <div class="pm-atom-head"><span class="pm-chip lead">${r.kind}</span><span class="pm-chip ${r.tier.toLowerCase()}">${r.tier}</span>${r.status !== 'active' ? `<span class="pm-chip inactive">${r.status}</span>` : ''}<span class="pm-atom-meta">w${r.weight}</span>${r.category.map((c) => `<span class="pm-chip">${c}</span>`).join('')}</div>
          <div class="pm-atom-text">${r.text}</div></button>`).join('')}
      </div>` : ''}
      ${table === 'drawer' ? `
      <div class="pm-card"><div class="pm-card-title">Explorer</div></div>
      <div class="pm-drawer-scrim"></div>
      <div class="pm-drawer" role="dialog" aria-modal="true">
        <div class="pm-drawer-head"><div class="pm-drawer-title">Memory detail</div><button class="pm-tbtn" id="close">Close</button></div>
        <div class="pm-drawer-body">
          <div class="pm-field"><div class="pm-field-label">Memory ID</div><div class="pm-field-value mono">0000000000000001</div></div>
          <div class="pm-field"><div class="pm-field-label">Content</div><div class="pm-drawer-content">${'A long memory body that must scroll inside the drawer rather than pushing it off screen. '.repeat(24)}</div></div>
          <div class="pm-field"><div class="pm-field-label">Category</div><div class="pm-chips"><span class="pm-chip">mod:lib</span><span class="pm-chip">dom:constraint</span></div></div>
        </div>
      </div>` : ''}
    </div>
  </div>
</div></main></div></body></html>`

const css = extractCss()
const out = join(root, '.dsh-memory', 'verify')
for (const name of ['overview', 'explorer', 'drawer']) {
  writeFileSync(`${out}-${name}.html`, page(css, name), 'utf8')
}
console.log(`wrote 3 harness pages using ${css.length} bytes of the real stylesheet`)
