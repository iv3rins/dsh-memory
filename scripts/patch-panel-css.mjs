/**
 * Replace the panel's stylesheet inside client.js with the dashboard stylesheet.
 *
 * Done by locating the `const CSS = \`` … closing backtick pair rather than by line
 * numbers, so the edit cannot silently hit the wrong block if the file shifts.
 *
 * Usage: node scripts/patch-panel-css.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, '..', 'client.js')

/** The new stylesheet. Old class names are kept so existing render code still works. */
export const NEW_CSS = `
/* ------------------------------------------------------------------ shell
   The page owns its own scroll container.

   Why: a host main region may be overflow:hidden — verified in a real browser: with that
   shell the panel rendered 3548px of content into an 889px box, and 2659px of it could
   not be reached by wheel, trackpad or keyboard because nothing in the tree was
   scrollable. So the root becomes a full-height flex column, the toolbar does not shrink,
   and the body is the one element that scrolls. min-height:0 on the flex child is the part
   that actually makes it scrollable: without it a flex item refuses to shrink below its
   content height and the overflow never happens. */
.pm-root { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; }
.pm-toolbar {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 10px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--dsh-border, rgba(127,127,127,0.22));
  background: var(--dsh-bg, transparent);
}
.pm-toolbar-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
.pm-crumbs { display: flex; align-items: center; gap: 6px; font-size: 11px; opacity: 0.6; min-width: 0; }
.pm-crumb { white-space: nowrap; }
.pm-crumb-sep { opacity: 0.45; }
.pm-crumb-now { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.85; }
.pm-title { font-size: 15px; font-weight: 600; letter-spacing: 0.01em; }
.pm-sub { font-size: 11px; opacity: 0.55; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }

/* Buttons in the toolbar. Real buttons so focus and keyboard work by default. */
.pm-tbtn {
  flex: 0 0 auto;
  display: inline-flex; align-items: center; gap: 5px;
  font: inherit; font-size: 12px;
  padding: 5px 10px; border-radius: 7px;
  border: 1px solid var(--dsh-border, rgba(127,127,127,0.3));
  background: var(--dsh-surface, rgba(127,127,127,0.1));
  color: inherit; cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.pm-tbtn:hover { background: var(--dsh-surface, rgba(127,127,127,0.18)); }
.pm-tbtn:focus-visible { outline: 2px solid var(--dsh-accent, rgba(90,140,255,0.9)); outline-offset: 2px; }
.pm-tbtn:disabled { opacity: 0.45; cursor: default; }
.pm-tbtn.icon { padding: 5px 8px; }

/* ------------------------------------------------------------------ tabs */
.pm-tabs {
  flex: 0 0 auto;
  display: flex; align-items: stretch; gap: 2px;
  padding: 0 20px;
  border-bottom: 1px solid var(--dsh-border, rgba(127,127,127,0.18));
  overflow-x: auto;
  scrollbar-width: none;
}
.pm-tabs::-webkit-scrollbar { display: none; }
.pm-tab {
  font: inherit; font-size: 12.5px;
  padding: 9px 12px;
  border: 0; border-bottom: 2px solid transparent;
  background: transparent; color: inherit; opacity: 0.66;
  cursor: pointer; white-space: nowrap;
  transition: opacity 120ms ease, border-color 150ms ease;
}
.pm-tab:hover { opacity: 0.9; }
.pm-tab.on { opacity: 1; border-bottom-color: var(--dsh-accent, rgba(90,140,255,0.9)); }
.pm-tab:focus-visible { outline: 2px solid var(--dsh-accent, rgba(90,140,255,0.9)); outline-offset: -2px; }
.pm-tab-count { font-size: 10.5px; opacity: 0.6; margin-left: 5px; font-variant-numeric: tabular-nums; }

/* -------------------------------------------------------------- scroll body
   The single scroll container. \`min-height: 0\` lets it shrink; \`overflow-y: auto\`
   gives it the scrollbar; \`overscroll-behavior: contain\` keeps a scroll that reaches the
   end from chaining into the page behind it. */
.pm-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 16px 20px 28px;
  scroll-behavior: smooth;
}
@media (prefers-reduced-motion: reduce) {
  .pm-body { scroll-behavior: auto; }
}
.pm-page { display: flex; flex-direction: column; gap: 14px; max-width: 1100px; }
/* Page transitions: a short fade-and-lift, disabled under reduced motion. */
.pm-page.enter { animation: pm-fade 180ms ease both; }
@keyframes pm-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .pm-page.enter { animation: none; }
}

/* --------------------------------------------------------------- cards */
.pm-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
.pm-card {
  border: 1px solid var(--dsh-border, rgba(127,127,127,0.22));
  border-radius: 10px; padding: 13px 15px;
  display: flex; flex-direction: column; gap: 8px;
  min-width: 0;
  transition: border-color 130ms ease, background 130ms ease;
}
.pm-card.hover:hover { background: var(--dsh-surface, rgba(127,127,127,0.06)); border-color: var(--dsh-border, rgba(127,127,127,0.34)); }
.pm-card.lead { border-color: var(--dsh-accent, rgba(90,140,255,0.45)); }
.pm-card.warn { border-color: rgba(200,150,40,0.5); background: rgba(200,150,40,0.07); }
.pm-card-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; opacity: 0.6; }
.pm-metric { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.15; }
.pm-metric-sub { font-size: 11.5px; opacity: 0.62; line-height: 1.45; }
.pm-headline { font-size: 13.5px; line-height: 1.5; font-weight: 550; }

.pm-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.pm-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; }
.pm-num { font-variant-numeric: tabular-nums; font-weight: 600; }
.pm-muted { opacity: 0.6; font-size: 12px; line-height: 1.55; }
.pm-hint { opacity: 0.55; font-size: 11.5px; line-height: 1.5; }
.pm-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.pm-chip { font-size: 11.5px; padding: 2px 8px; border-radius: 999px; background: var(--dsh-surface, rgba(127,127,127,0.12)); font-variant-numeric: tabular-nums; }
.pm-chip.lead { background: var(--dsh-accent, rgba(90,140,255,0.18)); }
.pm-chip.own { background: var(--dsh-accent, rgba(90,140,255,0.18)); }
.pm-chip.hot { background: rgba(220,110,90,0.18); }
.pm-chip.warm { background: rgba(200,150,40,0.18); }
.pm-chip.cold { background: rgba(90,140,255,0.16); }
.pm-chip.young { background: rgba(127,127,127,0.16); }
/* Status is never colour-only: the chip always carries its word. */
.pm-chip.inactive { background: rgba(127,127,127,0.16); opacity: 0.75; }

/* ------------------------------------------------------------- explorer */
.pm-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.pm-search {
  flex: 1 1 240px; min-width: 160px;
  font: inherit; font-size: 12.5px;
  padding: 7px 10px; border-radius: 7px;
  border: 1px solid var(--dsh-border, rgba(127,127,127,0.3));
  background: transparent; color: inherit;
}
.pm-search:focus-visible { outline: 2px solid var(--dsh-accent, rgba(90,140,255,0.9)); outline-offset: 1px; }
.pm-select {
  font: inherit; font-size: 12px;
  padding: 6px 8px; border-radius: 7px;
  border: 1px solid var(--dsh-border, rgba(127,127,127,0.3));
  background: transparent; color: inherit;
}
.pm-select:focus-visible { outline: 2px solid var(--dsh-accent, rgba(90,140,255,0.9)); outline-offset: 1px; }
/* The list scrolls inside a bounded box only when it is long; the page still scrolls. */
.pm-list { display: flex; flex-direction: column; gap: 6px; }
.pm-atom {
  display: flex; flex-direction: column; gap: 5px;
  padding: 9px 11px; border-radius: 8px;
  border: 1px solid transparent;
  background: var(--dsh-surface, rgba(127,127,127,0.06));
  cursor: pointer; text-align: left; font: inherit; color: inherit; width: 100%;
  transition: background 120ms ease, border-color 120ms ease;
}
.pm-atom:hover { background: var(--dsh-surface, rgba(127,127,127,0.12)); border-color: var(--dsh-border, rgba(127,127,127,0.3)); }
.pm-atom:focus-visible { outline: 2px solid var(--dsh-accent, rgba(90,140,255,0.9)); outline-offset: 1px; }
.pm-atom-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.pm-atom-text { font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }
.pm-atom-meta { font-size: 11px; opacity: 0.55; font-variant-numeric: tabular-nums; }
.pm-empty { padding: 18px; text-align: center; font-size: 12.5px; opacity: 0.6; }

/* --------------------------------------------------------- detail drawer */
.pm-drawer-scrim {
  position: absolute; inset: 0; z-index: 20;
  background: rgba(0,0,0,0.34);
  animation: pm-scrim 150ms ease both;
}
@keyframes pm-scrim { from { opacity: 0; } to { opacity: 1; } }
.pm-drawer {
  position: absolute; top: 0; right: 0; bottom: 0; z-index: 21;
  width: min(430px, 92%);
  display: flex; flex-direction: column;
  background: var(--dsh-bg-elevated, var(--dsh-bg, #1b1d22));
  border-left: 1px solid var(--dsh-border, rgba(127,127,127,0.3));
  box-shadow: -12px 0 32px rgba(0,0,0,0.28);
  animation: pm-slide 190ms cubic-bezier(0.22, 0.61, 0.36, 1) both;
}
@keyframes pm-slide { from { transform: translateX(16px); opacity: 0.6; } to { transform: none; opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .pm-drawer, .pm-drawer-scrim { animation: none; }
}
.pm-drawer-head {
  flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 13px 15px; border-bottom: 1px solid var(--dsh-border, rgba(127,127,127,0.22));
}
.pm-drawer-title { font-size: 13.5px; font-weight: 600; }
.pm-drawer-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 14px 15px 24px; display: flex; flex-direction: column; gap: 12px; }
.pm-field { display: flex; flex-direction: column; gap: 3px; }
.pm-field-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.55; }
.pm-field-value { font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }
.pm-field-value.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.pm-drawer-content {
  font-size: 13px; line-height: 1.6;
  padding: 10px 12px; border-radius: 8px;
  background: var(--dsh-surface, rgba(127,127,127,0.08));
  max-height: 240px; overflow-y: auto;
  overflow-wrap: anywhere; white-space: pre-wrap;
}

/* ------------------------------------------------------------- compactions */
.pm-tl-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
  font-size: 12px; padding: 7px 10px; border-radius: 7px;
  background: var(--dsh-surface, rgba(127,127,127,0.07));
  width: 100%; border: 0; font-family: inherit; color: inherit; text-align: left; cursor: pointer;
  transition: background 120ms ease;
}
.pm-tl-row:hover { background: var(--dsh-surface, rgba(127,127,127,0.13)); }
.pm-tl-row:focus-visible { outline: 2px solid var(--dsh-accent, rgba(90,140,255,0.9)); outline-offset: 1px; }
.pm-tl-row.silent { opacity: 0.62; }
.pm-tl-detail {
  padding: 9px 12px; margin-top: 2px;
  border-left: 2px solid var(--dsh-border, rgba(127,127,127,0.3));
  display: flex; flex-direction: column; gap: 4px;
  animation: pm-fade 170ms ease both;
}
@media (prefers-reduced-motion: reduce) { .pm-tl-detail { animation: none; } }

/* ---------------------------------------------------------------- forms */
.pm-group { display: flex; flex-direction: column; gap: 2px; }
.pm-choice { display: flex; align-items: baseline; gap: 7px; padding: 4px 6px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
.pm-choice:hover { background: var(--dsh-surface, rgba(127,127,127,0.09)); }
.pm-choice.on { border-color: var(--dsh-accent, rgba(90,140,255,0.55)); background: var(--dsh-surface, rgba(127,127,127,0.09)); }
.pm-choice-head { display: flex; align-items: baseline; gap: 7px; min-width: 0; flex: 1 1 auto; }
.pm-radio { font-size: 10px; line-height: 1; opacity: 0.45; flex: 0 0 auto; }
.pm-radio.on { opacity: 1; color: var(--dsh-accent, rgba(90,140,255,0.9)); }
.pm-choice-title { font-size: 12px; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; flex: 0 0 auto; }
.pm-choice-desc { font-size: 11.5px; opacity: 0.62; line-height: 1.45; min-width: 0; flex: 1 1 auto; }
.pm-ok, .pm-warn { font-size: 11.5px; line-height: 1.5; padding: 6px 9px; border-radius: 6px; }
.pm-ok { background: var(--dsh-surface, rgba(127,127,127,0.1)); opacity: 0.85; }
.pm-warn { background: rgba(200,150,40,0.14); border: 1px solid rgba(200,150,40,0.35); }
.pm-input { width: 100%; font-size: 12.5px; padding: 7px 9px; border-radius: 7px; border: 1px solid var(--dsh-border, rgba(127,127,127,0.3)); background: transparent; color: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.pm-input:focus-visible { outline: 2px solid var(--dsh-accent, rgba(90,140,255,0.9)); outline-offset: 1px; }
.pm-btn { align-self: flex-start; font-size: 12.5px; padding: 6px 14px; border-radius: 7px; border: 1px solid var(--dsh-border, rgba(127,127,127,0.32)); background: var(--dsh-surface, rgba(127,127,127,0.1)); color: inherit; cursor: pointer; }
.pm-btn:focus-visible { outline: 2px solid var(--dsh-accent, rgba(90,140,255,0.9)); outline-offset: 2px; }
.pm-btn:disabled { opacity: 0.45; cursor: default; }
.pm-btn.small { padding: 3px 9px; font-size: 11.5px; align-self: auto; }
.pm-banner { font-size: 12.5px; padding: 9px 12px; border-radius: 8px; background: var(--dsh-surface, rgba(127,127,127,0.12)); line-height: 1.5; }
.pm-banner.bad { border: 1px solid var(--dsh-danger, rgba(220,90,90,0.5)); }
.pm-banner.warn { border: 1px solid rgba(200,150,40,0.4); background: rgba(200,150,40,0.12); }

/* --------------------------------------------------------------- projects */
.pm-projects { display: flex; flex-direction: column; gap: 4px; max-height: 210px; overflow-y: auto; overscroll-behavior: contain; }
.pm-project { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 7px; cursor: pointer; border: 1px solid transparent; }
.pm-project:hover { background: var(--dsh-surface, rgba(127,127,127,0.09)); }
.pm-project.on { border-color: var(--dsh-accent, rgba(90,140,255,0.55)); background: var(--dsh-surface, rgba(127,127,127,0.09)); }
.pm-project:focus-visible { outline: 2px solid var(--dsh-accent, rgba(90,140,255,0.9)); outline-offset: 1px; }
.pm-project-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1 1 auto; }
.pm-project-name { font-size: 12.5px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-project-path { font-size: 10.5px; opacity: 0.5; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-project-meta { font-size: 10.5px; opacity: 0.6; flex: 0 0 auto; font-variant-numeric: tabular-nums; }

/* --------------------------------------------------------------- collapse */
.pm-collapse { border: 1px solid var(--dsh-border, rgba(127,127,127,0.22)); border-radius: 10px; overflow: hidden; }
.pm-collapse-head { display: flex; align-items: baseline; gap: 8px; padding: 10px 13px; cursor: pointer; background: var(--dsh-surface, rgba(127,127,127,0.05)); border: 0; width: 100%; font: inherit; color: inherit; text-align: left; }
.pm-collapse-head:hover { background: var(--dsh-surface, rgba(127,127,127,0.1)); }
.pm-collapse-head:focus-visible { outline: 2px solid var(--dsh-accent, rgba(90,140,255,0.9)); outline-offset: -2px; }
.pm-caret { font-size: 10px; opacity: 0.6; flex: 0 0 auto; }
.pm-collapse-title { font-size: 12px; font-weight: 600; flex: 0 0 auto; }
.pm-collapse-summary { font-size: 11.5px; opacity: 0.6; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; }
.pm-collapse-body { padding: 12px 13px; display: flex; flex-direction: column; gap: 10px; animation: pm-fade 170ms ease both; }
@media (prefers-reduced-motion: reduce) { .pm-collapse-body { animation: none; } }

/* ----------------------------------------------------------- skeletons */
.pm-skel { border-radius: 6px; background: var(--dsh-surface, rgba(127,127,127,0.12)); animation: pm-pulse 1.2s ease-in-out infinite; }
@keyframes pm-pulse { 0%,100% { opacity: 0.5; } 50% { opacity: 0.9; } }
@media (prefers-reduced-motion: reduce) { .pm-skel { animation: none; opacity: 0.7; } }

/* -------------------------------------------------------------- narrow */
@media (max-width: 640px) {
  .pm-toolbar { padding: 10px 12px; flex-wrap: wrap; }
  .pm-tabs { padding: 0 12px; }
  .pm-body { padding: 12px 12px 24px; }
  .pm-drawer { width: 100%; }
  .pm-grid { grid-template-columns: 1fr; }
}
`

const source = readFileSync(file, 'utf8')
const start = source.indexOf('const CSS = `')
if (start === -1) throw new Error('could not find `const CSS = ` in client.js')
const from = start + 'const CSS = `'.length
let end = -1
let index = from
while (index < source.length) {
  const next = source.indexOf('`', index)
  if (next === -1) break
  let backslashes = 0
  for (let walk = next - 1; walk >= from && source[walk] === '\\'; walk -= 1) backslashes += 1
  if (backslashes % 2 === 0) { end = next; break }
  index = next + 1
}
if (end === -1) throw new Error('could not find the end of the CSS template literal')

const next = `${source.slice(0, from)}${NEW_CSS}${source.slice(end)}`
writeFileSync(file, next, 'utf8')
console.log(`replaced panel CSS: ${end - from} bytes → ${NEW_CSS.length} bytes`)
