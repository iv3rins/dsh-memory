/**
 * Apply the dashboard rewrite to client.js in one controlled step.
 *
 * Three edits, matched by content rather than line numbers so they cannot silently land
 * in the wrong place:
 *
 *   1. append the new dictionary keys after `router.empty` (both languages),
 *   2. replace the stylesheet template literal,
 *   3. replace the `MemoryPanel` component body.
 *
 * Everything else — data loading, saving, project picker, scope switch — is preserved by
 * transplanting the existing helpers rather than rewriting them.
 *
 * Usage: node scripts/apply-dashboard.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, '..', 'client.js')

const read = () => readFileSync(file, 'utf8')

/** True when every marker is present exactly once. */
function assertUnique(source, marker, label) {
  const count = source.split(marker).length - 1
  if (count !== 1) throw new Error(`${label}: expected exactly one match, found ${count}`)
}

// ------------------------------------------------------------------ step 1: css

const CSS_START = 'const CSS = `'
const CSS_END_AFTER = '`\n'

/**
 * Replace the `const CSS = \`…\`` block.
 *
 * Deliberately avoids backticks inside the replacement: a stray one terminates the
 * template literal and produces a syntax error that looks like a CSS problem.
 *
 * @param {string} source - client.js.
 * @returns {string} updated source.
 */
function replaceCss(source) {
  const start = source.indexOf(CSS_START)
  if (start === -1) throw new Error('css: const CSS marker not found')
  const from = start + CSS_START.length
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
  if (end === -1) throw new Error('css: template literal not terminated')
  return `${source.slice(0, from)}${NEW_CSS}${source.slice(end)}`
}

const NEW_CSS = `
/* ------------------------------------------------------------------ shell
   The page owns its own scroll container.

   A host main region may be overflow:hidden. Verified in a real browser against such a
   shell: the panel rendered 3548px of content into an 889px box and 2659px of it could
   not be reached by wheel, trackpad or keyboard, because nothing in the tree was
   scrollable. So the root is a full-height flex column, the toolbar does not shrink, and
   the body is the single scrolling element.

   min-height:0 is the load-bearing part. A flex item refuses to shrink below its content
   height by default, so without it the child grows to 3548px and never overflows. */
.pm-root { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; position: relative; }
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

/* The single scroll container. min-height:0 lets it shrink; overscroll-behavior stops a
   scroll that reaches the end from chaining into whatever is behind the page. */
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
.pm-page.enter { animation: pm-fade 190ms ease both; }
@keyframes pm-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .pm-page.enter { animation: none; }
}

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
.pm-chip.inactive { background: rgba(127,127,127,0.16); opacity: 0.75; }

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

.pm-projects { display: flex; flex-direction: column; gap: 4px; max-height: 210px; overflow-y: auto; overscroll-behavior: contain; }
.pm-project { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 7px; cursor: pointer; border: 1px solid transparent; }
.pm-project:hover { background: var(--dsh-surface, rgba(127,127,127,0.09)); }
.pm-project.on { border-color: var(--dsh-accent, rgba(90,140,255,0.55)); background: var(--dsh-surface, rgba(127,127,127,0.09)); }
.pm-project:focus-visible { outline: 2px solid var(--dsh-accent, rgba(90,140,255,0.9)); outline-offset: 1px; }
.pm-project-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1 1 auto; }
.pm-project-name { font-size: 12.5px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-project-path { font-size: 10.5px; opacity: 0.5; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-project-meta { font-size: 10.5px; opacity: 0.6; flex: 0 0 auto; font-variant-numeric: tabular-nums; }

.pm-collapse { border: 1px solid var(--dsh-border, rgba(127,127,127,0.22)); border-radius: 10px; overflow: hidden; }
.pm-collapse-head { display: flex; align-items: baseline; gap: 8px; padding: 10px 13px; cursor: pointer; background: var(--dsh-surface, rgba(127,127,127,0.05)); border: 0; width: 100%; font: inherit; color: inherit; text-align: left; }
.pm-collapse-head:hover { background: var(--dsh-surface, rgba(127,127,127,0.1)); }
.pm-collapse-head:focus-visible { outline: 2px solid var(--dsh-accent, rgba(90,140,255,0.9)); outline-offset: -2px; }
.pm-caret { font-size: 10px; opacity: 0.6; flex: 0 0 auto; }
.pm-collapse-title { font-size: 12px; font-weight: 600; flex: 0 0 auto; }
.pm-collapse-summary { font-size: 11.5px; opacity: 0.6; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; }
.pm-collapse-body { padding: 12px 13px; display: flex; flex-direction: column; gap: 10px; animation: pm-fade 170ms ease both; }
@media (prefers-reduced-motion: reduce) { .pm-collapse-body { animation: none; } }

.pm-skel { border-radius: 6px; background: var(--dsh-surface, rgba(127,127,127,0.12)); animation: pm-pulse 1.2s ease-in-out infinite; }
@keyframes pm-pulse { 0%,100% { opacity: 0.5; } 50% { opacity: 0.9; } }
@media (prefers-reduced-motion: reduce) { .pm-skel { animation: none; opacity: 0.7; } }

@media (max-width: 640px) {
  .pm-toolbar { padding: 10px 12px; flex-wrap: wrap; }
  .pm-tabs { padding: 0 12px; }
  .pm-body { padding: 12px 12px 24px; }
  .pm-drawer { width: 100%; }
  .pm-grid { grid-template-columns: 1fr; }
}
`

// ------------------------------------------------------------- step 2: strings

const NEW_ZH = `
      'nav.back': '返回',
      'nav.refresh': '刷新',
      'nav.settings': '设置',
      'nav.crumbRoot': '项目记忆',
      'page.noProject': '未确定项目',
      'page.refreshing': '正在刷新…',
      'tab.overview': '概览',
      'tab.explorer': '记忆浏览',
      'tab.compactions': '压实记录',
      'tab.router': '路由轨迹',
      'tab.settings': '设置',
      'overview.live': '有效记忆',
      'overview.standing': '常驻约束',
      'overview.tiers': 'Hot / Warm / Cold',
      'overview.tierNone': '生命周期未启用',
      'overview.lastCompact': '最近一次压实',
      'overview.lastCompactNone': '还没有压实记录',
      'overview.lastRouter': '最近一次记忆路由',
      'overview.lastRouterNone': '还没有路由记录',
      'overview.capacity': '存储容量',
      'overview.capacityLine': '有效 {live} / 上限 {limit}',
      'overview.capacityFull': '已达到上限：新原子会挤掉较弱的旧原子，旧原子不会从磁盘删除。',
      'overview.capacityOk': '还有 {headroom} 条余量。',
      'explorer.search': '搜索记忆内容或 ID',
      'explorer.kind': '类型',
      'explorer.category': '分类',
      'explorer.tier': '生命周期',
      'explorer.status': '状态',
      'explorer.all': '全部',
      'explorer.count': '{shown} / {total} 条',
      'explorer.none': '没有符合筛选条件的记忆。',
      'explorer.emptyStore': '这个项目还没有记忆。',
      'explorer.loadMore': '加载更多',
      'explorer.sortWeight': '按重要性',
      'explorer.sortRecent': '按更新时间',
      'explorer.clear': '清除筛选',
      'detail.title': '记忆详情',
      'detail.id': 'Memory ID',
      'detail.content': '内容',
      'detail.type': '类型',
      'detail.category': '分类',
      'detail.tier': '生命周期',
      'detail.status': '状态',
      'detail.priority': '优先级',
      'detail.pinned': '已固定',
      'detail.source': '来源',
      'detail.created': '创建时间',
      'detail.updated': '更新时间',
      'detail.counts': '检索 / 交付 / 使用',
      'detail.files': '关联文件',
      'detail.tags': '标签',
      'detail.close': '关闭',
      'detail.sourceUnavailable': '原始来源不可用：产生这条记忆的会话或压实记录已不在本地。',
      'detail.sourceAvailable': '会话 {session} · 压实 {compaction}',
      'capacity.title': '容量明细',
      'capacity.live': '有效记忆',
      'capacity.archived': '已归档',
      'capacity.forgotten': '已遗忘',
      'capacity.records': '总记录',
      'capacity.coldHint': 'Cold 记忆仍在存储中，只是默认不注入上下文，并未删除。',
      'compactions.expand': '展开详情',
      'compactions.collapse': '收起',
      'compactions.tokens': 'Token：压实前 {before} → 摘要 {after}',
      'trace.title': '路由轨迹',
      'trace.none': '还没有路由记录。开启 always 触发策略后，每一步都会留下轨迹。',
      'trace.intent': 'Task Intent',
      'trace.intentNone': '未提供（主模型尚未调用 memory_intent）',
      'trace.candidates': '候选数量',
      'trace.routerOk': '副模型调用',
      'trace.hot': 'Hot 记忆',
      'trace.cold': 'Cold 引用',
      'trace.packageTokens': 'Memory Package Token',
      'trace.delivery': '交付状态',
      'trace.delivered': '已交付到主模型请求',
      'trace.notDelivered': '未交付',
      'trace.latency': '耗时',
      'trace.error': '错误',
      'trace.notCollected': '未采集',
      'settings.semantic': '语义路由',
      'settings.lifecycle': '生命周期管理',
      'settings.lifecycleSweep': '自动升降级',
      'settings.taskIntent': 'Task Intent 协议',
      'settings.intentCache': '意图缓存',
      'settings.metrics': '指标采集',
      'settings.router': '副模型路由',
      'settings.capacity': '记忆容量',
      'settings.on': '已开启',
      'settings.off': '已关闭',
      'settings.readOnly': '这些开关写在 profile 配置里，面板只读展示；请在 profile 配置文件中修改。',
`

const NEW_EN = `
      'nav.back': 'Back',
      'nav.refresh': 'Refresh',
      'nav.settings': 'Settings',
      'nav.crumbRoot': 'Project memory',
      'page.noProject': 'No project selected',
      'page.refreshing': 'Refreshing…',
      'tab.overview': 'Overview',
      'tab.explorer': 'Explorer',
      'tab.compactions': 'Compactions',
      'tab.router': 'Router trace',
      'tab.settings': 'Settings',
      'overview.live': 'Live memory',
      'overview.standing': 'Standing rules',
      'overview.tiers': 'Hot / Warm / Cold',
      'overview.tierNone': 'Lifecycle is off',
      'overview.lastCompact': 'Last compaction',
      'overview.lastCompactNone': 'No compaction recorded yet',
      'overview.lastRouter': 'Last memory router run',
      'overview.lastRouterNone': 'No router run recorded yet',
      'overview.capacity': 'Store capacity',
      'overview.capacityLine': '{live} live of {limit}',
      'overview.capacityFull': 'At the ceiling: new atoms displace weaker old ones. The old rows stay on disk; they are not deleted.',
      'overview.capacityOk': '{headroom} slots free.',
      'explorer.search': 'Search memory text or id',
      'explorer.kind': 'Type',
      'explorer.category': 'Category',
      'explorer.tier': 'Lifecycle',
      'explorer.status': 'Status',
      'explorer.all': 'All',
      'explorer.count': '{shown} of {total}',
      'explorer.none': 'No memory matches these filters.',
      'explorer.emptyStore': 'This project has no memory yet.',
      'explorer.loadMore': 'Load more',
      'explorer.sortWeight': 'By importance',
      'explorer.sortRecent': 'By updated',
      'explorer.clear': 'Clear filters',
      'detail.title': 'Memory detail',
      'detail.id': 'Memory ID',
      'detail.content': 'Content',
      'detail.type': 'Type',
      'detail.category': 'Category',
      'detail.tier': 'Lifecycle',
      'detail.status': 'Status',
      'detail.priority': 'Priority',
      'detail.pinned': 'Pinned',
      'detail.source': 'Source',
      'detail.created': 'Created',
      'detail.updated': 'Updated',
      'detail.counts': 'Retrieved / delivered / used',
      'detail.files': 'Related files',
      'detail.tags': 'Tags',
      'detail.close': 'Close',
      'detail.sourceUnavailable': 'Original source unavailable: the session or compaction that produced this memory is no longer on this machine.',
      'detail.sourceAvailable': 'session {session} · compaction {compaction}',
      'capacity.title': 'Capacity breakdown',
      'capacity.live': 'Live',
      'capacity.archived': 'Archived',
      'capacity.forgotten': 'Forgotten',
      'capacity.records': 'Records',
      'capacity.coldHint': 'Cold memory is still stored; it is withheld from context by default, not deleted.',
      'compactions.expand': 'Show details',
      'compactions.collapse': 'Hide details',
      'compactions.tokens': 'Tokens: before {before} → summary {after}',
      'trace.title': 'Router trace',
      'trace.none': 'No router run recorded yet. With the always tier, every step leaves a trace.',
      'trace.intent': 'Task intent',
      'trace.intentNone': 'Not supplied (the main model has not called memory_intent)',
      'trace.candidates': 'Candidates',
      'trace.routerOk': 'Router call',
      'trace.hot': 'Hot memory',
      'trace.cold': 'Cold references',
      'trace.packageTokens': 'Memory package tokens',
      'trace.delivery': 'Delivery',
      'trace.delivered': 'Delivered into the model request',
      'trace.notDelivered': 'Not delivered',
      'trace.latency': 'Latency',
      'trace.error': 'Error',
      'trace.notCollected': 'not collected',
      'settings.semantic': 'Semantic routing',
      'settings.lifecycle': 'Lifecycle management',
      'settings.lifecycleSweep': 'Automatic promotion',
      'settings.taskIntent': 'Task intent protocol',
      'settings.intentCache': 'Intent cache',
      'settings.metrics': 'Metrics collection',
      'settings.router': 'Router model',
      'settings.capacity': 'Memory capacity',
      'settings.on': 'on',
      'settings.off': 'off',
      'settings.readOnly': 'These switches live in the profile config; the panel shows them read-only. Edit them in the profile configuration file.',
`

/**
 * Replace the `MemoryPanel` component with the dashboard and its sub-components.
 *
 * The component is located by its definition and its terminator (`// ---- apply`), so the
 * splice cannot land in the middle of unrelated code. Everything before the component —
 * `getJson`, `fill`, `MemoryIcon` — and everything after (`apply`) is preserved.
 *
 * @param {string} source - client.js.
 * @returns {string} updated source.
 */
function replacePanel(source) {
  const marker = '    function MemoryPanel(props) {'
  const start = source.indexOf(marker)
  if (start === -1) throw new Error('panel: MemoryPanel definition not found')
  const afterMarker = source.indexOf('// --------------------------------------------------------------------- apply', start)
  if (afterMarker === -1) throw new Error('panel: apply marker not found after MemoryPanel')

  const parts = [readPart('panel-ui.mjs'), readPart('panel-pages.mjs'), readPart('panel-shell.mjs')]
  const replacement = `${parts.join('\n')}\n\n`
  return `${source.slice(0, start)}${replacement}${source.slice(afterMarker)}`
}

/** Read one fragment from scripts/. */
function readPart(name) {
  return readFileSync(join(here, name), 'utf8').replace(/^\uFEFF/, '')
}

function addStrings(source) {
  const zhAnchor = "'router.empty': '留空表示跟随全局（{value}）。'"
  assertUnique(source, zhAnchor, 'zh router.empty')
  // Each fragment already ends with a comma; the anchor supplies the separator before it.
  const zhBlock = NEW_ZH.trimEnd().replace(/,$/, '')
  let next = source.replace(zhAnchor, `${zhAnchor},\n${zhBlock}`)

  const enAnchor = "'router.empty': 'Leave empty to follow global ({value}).'"
  assertUnique(next, enAnchor, 'en router.empty')
  const enBlock = NEW_EN.trimEnd().replace(/,$/, '')
  next = next.replace(enAnchor, `${enAnchor},\n${enBlock}`)
  return next
}

let source = read()
source = replaceCss(source)
source = addStrings(source)
source = replacePanel(source)
writeFileSync(file, source, 'utf8')
console.log('applied: stylesheet + dictionary keys + dashboard component')
