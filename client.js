/**
 * Client half: one left-sidebar panel that shows what this project's memory is,
 * and lets the user choose how routing works.
 *
 * Two constraints shape it:
 *
 * - **It cannot read Host services.** A static Client bundle has no Host service
 *   access, so every number here comes from `/project-memory/status`, served by
 *   `lib/panel.js` out of the same files the tools read. There is no second source of
 *   truth and no cached copy that could disagree with `/memory-status`.
 * - **It does not cache what it reports.** Memory changes on every compaction and
 *   every `memory_remember`, so a panel that loaded once would confidently show
 *   yesterday's counts. The panel refetches on open and on demand.
 *
 * The panel deliberately offers no way to edit atoms. Memory is written by
 * compaction and by tools that carry provenance and honour tombstones; a browser
 * button that deleted an atom would bypass both. Removal stays `memory_forget`,
 * which writes a tombstone rather than dropping the evidence.
 *
 * @module @dsh-external/dsh-project-memory/client
 */

window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-project-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** Client dictionary namespace owned by this bundle. */
    const NS = 'project-memory'
    /** Panel id: also the key of the main panel it opens. */
    const PANEL_ID = 'project-memory'
    /** Host route that serves the snapshot. */
    const STATUS_PATH = '/project-memory/status'
    /** Host route that reads and writes the router settings. */
    const CONFIG_PATH = '/project-memory/config'

    /**
     * The routing tiers and strategies are driven by `data.choices`, which the Host fills
     * from the same validator that rejects a bad save. Only their display text lives here,
     * keyed by value, so a new tier needs one dictionary entry and no change on this side.
     */

    // ---------------------------------------------------------------- dictionary

    const zh = {
      'tier.always': 'always',
      'tier.smart': 'smart',
      'tier.off': 'off',
      'tier.always.desc': '每一步都问一次副模型。需要下面填好提供方和模型。',
      'tier.smart.desc': '只在确定性打分没结果或很弱时才问副模型。',
      'tier.off.desc': '只做确定性打分，永远不调用模型。',
      'strategy.task': 'task',
      'strategy.compliance': 'compliance',
      'strategy.orient': 'orient',
      'strategy.task.desc': '优先「这一步要做什么」：涉及的文件，以及关于这些文件已经做过的决定。',
      'strategy.compliance.desc': '优先管着这些文件的规则与更正，即使字面看起来无关。',
      'strategy.orient.desc': '优先「这个子系统怎么运作、为什么」，适合想弄懂而不是想动手的请求。',
      'scope.hint.project': '改动只写进这个项目的 .dsh-memory，别的项目不受影响。',
      'router.status.unconfigured': '未配置副模型，当前只做确定性选择。',
      'router.status.noservice': '宿主没装 subagent provider，即使填了模型也不会调用。',
      'panel.title': '项目记忆',
      'panel.open': '打开项目记忆',
      'panel.loading': '正在读取…',
      'panel.retry': '重新读取',
      'panel.noRoot': '无法确定项目根目录。设置 projectRoot，或在一个会话里打开本面板。',
      'panel.error': '读取失败',
      'panel.empty': '这个项目还没有任何记忆。压实发生时会自动写入，也可以用 memory_remember 主动写入。',
      'atoms.live': '生效',
      'atoms.forgotten': '已遗忘',
      'atoms.standing': '常驻硬约束',
      'atoms.invalid': '{count} 行记忆无法解析，已跳过。其余记录仍然可用。',
      'compactions.title': '压缩记录',
      'compactions.reasons': '未产出的原因',
      'compactions.headline.none': '还没有压实记录。插件安装之后发生的压实才会被记录。',
      'compactions.headline.first': '最近一次压实写入 {added} 条原子（{when}）。',
      'compactions.headline.empty': '最近一次压实没有写入任何原子：{reason}。',
      'compactions.timeline': '每次压实写了什么',
      'compactions.row.added': '+{added}',
      'compactions.row.updated': '{updated} 更新',
      'compactions.row.unchanged': '{unchanged} 未变',
      'compactions.row.skipped': '{reason}',
      'compactions.row.timeNoTurn': '{when} · 摘要 {chars} 字',
      'compactions.row.noTime': '时间未知',
      'compactions.total': '累计 {total} 次，{atoms} 条原子',
      'atoms.limit': '已达上限 {limit} 条：更新的原子会挤掉较弱的旧原子。',
      'router.title': '记忆路由',
      'router.provider': '副模型提供方',
      'router.model': '副模型',
      'router.provider.hint': '留空则完全不做模型调用。',
      'router.strategy.hint': '策略不同，发给副模型的提示词也不同。',
      'router.save': '保存',
      'router.saving': '保存中…',
      'router.saved': '已保存',
      'router.failed': '保存失败',
      'router.readonly': '这个 profile 不支持保存设置。',
      'recall.line': '每次最多 {budget} tokens、{limit} 条',
      'project.title': '项目',
      'project.current': '当前会话',
      'project.none': '还没有登记任何项目。在某个项目里开始一次会话后，它就会出现在这里。',
      'project.atoms': '{count} 条原子',
      'project.noMemory': '尚未建立记忆',
      'scope.global': '全局（所有项目）',
      'scope.project': '仅本项目',
      'scope.global.hint': '改动写进 profile 配置，对所有项目生效。',
      'scope.project.unavailable': '没有选中项目，无法设置项目级配置。',
      'scope.reset': '恢复跟随全局',

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
      'trace.title': '路由轨迹',
      'trace.none': '还没有路由记录。开启 always 触发策略后，每一步都会留下轨迹。',
      'trace.intent': 'Task Intent',
      'trace.intentNone': '未提供（主模型尚未调用 memory_intent）',
      'trace.candidates': '候选数量',
      'trace.routerOk': '副模型调用',
      'trace.categories': '选中分类',
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
      'settings.readOnly': '这些开关写在 profile 配置里，面板只读展示；请在 profile 配置文件中修改。'
    }

    const en = {
      'tier.always': 'always',
      'tier.smart': 'smart',
      'tier.off': 'off',
      'tier.always.desc': 'Asks the router model on every step. Needs a provider and a model below.',
      'tier.smart.desc': 'Asks the router model only when deterministic scoring comes back empty or weak.',
      'tier.off.desc': 'Deterministic scoring only. No model call, ever.',
      'strategy.task': 'task',
      'strategy.compliance': 'compliance',
      'strategy.orient': 'orient',
      'strategy.task.desc': 'Prioritise what this step is about to do: the files in play and the decisions already made about them.',
      'strategy.compliance.desc': 'Prioritise the rules and corrections that govern the files in play, even when their wording looks unrelated.',
      'strategy.orient.desc': 'Prioritise how the subsystem works and why, for requests that ask to understand rather than to act.',
      'scope.hint.project': 'Writes only to this project\'s .dsh-memory; other projects are unaffected.',
      'router.status.unconfigured': 'No router model configured, so only deterministic selection runs.',
      'router.status.noservice': 'The host has no subagent provider mounted, so a model would not be called even if set.',
      'panel.title': 'Project memory',
      'panel.open': 'Open project memory',
      'panel.loading': 'Reading…',
      'panel.retry': 'Read again',
      'panel.noRoot': 'No project root could be determined. Set projectRoot, or open this panel from a session.',
      'panel.error': 'Could not read',
      'panel.empty': 'No memory for this project yet. Compaction writes it automatically, and memory_remember writes it on demand.',
      'atoms.live': 'live',
      'atoms.forgotten': 'forgotten',
      'atoms.standing': 'standing hard rules',
      'atoms.invalid': '{count} stored line(s) could not be parsed and were skipped. The remaining records are still used.',
      'compactions.title': 'Compactions',
      'compactions.reasons': 'Why nothing was produced',
      'compactions.headline.none': 'No compaction recorded yet. Only compactions after this plugin was installed are recorded.',
      'compactions.headline.first': 'The last compaction wrote {added} atoms ({when}).',
      'compactions.headline.empty': 'The last compaction wrote no atoms: {reason}.',
      'compactions.timeline': 'What each compaction wrote',
      'compactions.row.added': '+{added}',
      'compactions.row.updated': '{updated} updated',
      'compactions.row.unchanged': '{unchanged} unchanged',
      'compactions.row.skipped': '{reason}',
      'compactions.row.timeNoTurn': '{when} \u00b7 {chars} chars summarized',
      'compactions.row.noTime': 'time unknown',
      'compactions.total': '{total} compactions, {atoms} atoms in total',
      'atoms.limit': 'At the {limit}-atom ceiling: newer atoms displace weaker older ones.',
      'router.title': 'Memory routing',
      'router.provider': 'Router provider',
      'router.model': 'Router model',
      'router.provider.hint': 'Leave both empty and no model is ever called.',
      'router.strategy.hint': 'The strategy changes the instructions the router model receives.',
      'router.save': 'Save',
      'router.saving': 'Saving…',
      'router.saved': 'Saved',
      'router.failed': 'Save failed',
      'router.readonly': 'This profile cannot persist settings.',
      'recall.line': 'At most {budget} tokens and {limit} atoms per step',
      'project.title': 'Project',
      'project.current': 'current session',
      'project.none': 'No project registered yet. Start a session inside one and it appears here.',
      'project.atoms': '{count} atoms',
      'project.noMemory': 'no memory yet',
      'scope.global': 'Global (every project)',
      'scope.project': 'This project only',
      'scope.global.hint': 'Writes to the profile config, so every project follows it.',
      'scope.project.unavailable': 'No project selected, so nothing can be set per project.',
      'scope.reset': 'Stop overriding',

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
      'trace.title': 'Router trace',
      'trace.none': 'No router run recorded yet. With the always tier, every step leaves a trace.',
      'trace.intent': 'Task intent',
      'trace.intentNone': 'Not supplied (the main model has not called memory_intent)',
      'trace.candidates': 'Candidates',
      'trace.routerOk': 'Router call',
      'trace.categories': 'Selected categories',
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
      'settings.readOnly': 'These switches live in the profile config; the panel shows them read-only. Edit them in the profile configuration file.'
    }

    // --------------------------------------------------------------------- icon

    /**
     * Sidebar icon: a small stack of records, matching the panel's subject.
     * @param {{ size: number, active: boolean }} props - owner props.
     */
    function MemoryIcon(props) {
      const size = props?.size ?? 18
      const color = props?.active ? 'currentColor' : 'currentColor'
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 3, y: 4, width: 14, height: 2.6, rx: 1.1, fill: color, opacity: 0.95 }),
        h('rect', { x: 3, y: 8.7, width: 14, height: 2.6, rx: 1.1, fill: color, opacity: 0.7 }),
        h('rect', { x: 3, y: 13.4, width: 9, height: 2.6, rx: 1.1, fill: color, opacity: 0.45 })
      )
    }

    // ------------------------------------------------------------------ helpers

    /** Replace `{name}` placeholders without pulling in a formatting library. */
    const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_match, key) => String(values[key] ?? ''))

    /**
     * Fetch JSON, turning any failure into a message rather than a throw.
     * A panel that throws renders an empty screen and tells the user nothing.
     */
    const getJson = async (path) => {
      try {
        const response = await fetch(path, { headers: { accept: 'application/json' } })
        if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
        return { ok: true, data: await response.json() }
      } catch (error) {
        return { ok: false, reason: error && error.message ? error.message : String(error) }
      }
    }

    // ------------------------------------------------------------------- styles

    const CSS = `
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
.pm-tag { margin-left: 6px; font-size: 10px; padding: 1px 6px; border-radius: 999px; background: var(--dsh-accent, rgba(90,140,255,0.2)); }

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

    // -------------------------------------------------------------------- panel

    /**
     * One row in the project picker.
     * @param {{ row: object, selected: boolean, onPick: () => void, t: Function }} props - row data.
     */
    function ProjectRow(props) {
      const { row, selected, onPick, t } = props
      const meta = row.hasMemory === false ? t('project.noMemory') : fill(t('project.atoms'), { count: row.atoms })
      return h(
        'div',
        {
          className: selected ? 'pm-project on' : 'pm-project',
          role: 'button',
          tabIndex: 0,
          onClick: onPick,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') onPick()
          }
        },
        h(
          'div',
          { className: 'pm-project-main' },
          h(
            'div',
            { className: 'pm-project-name' },
            String(row.name),
            row.current === true ? h('span', { className: 'pm-tag' }, t('project.current')) : null
          ),
          h('div', { className: 'pm-project-path' }, String(row.root))
        ),
        h('div', { className: 'pm-project-meta' }, meta)
      )
    }

    /**
     * The main panel.
     * @param {{ t: (key: string) => string, close?: () => void }} props - slot props.
     */
/**
 * The dashboard rewrite of the client panel.
 *
 * Split from the existing client.js so the new page structure can be reasoned about on
 * its own; `scripts/apply-dashboard.mjs` splices it in. Two rules shaped every decision
 * here:
 *
 * 1. **The page owns its scroll container.** A host main region may be `overflow: hidden`
 *    (verified in a real browser: 3548px of content, 889px viewport, 2659px unreachable),
 *    so the root is `height:100%` with a non-shrinking toolbar and one scrolling body.
 * 2. **Nothing is claimed that is not measured.** Router latency, task intent and token
 *    numbers are shown when the backend supplies them and rendered as "not collected"
 *    when it does not — never as a zero or a guess.
 */

// --------------------------------------------------------------------- helpers

/** Format an ISO stamp for display, or mark it unknown. */
function fmtTime(value, t) {
  if (typeof value !== 'string' || value === '') return t('compactions.row.noTime')
  const stamp = Date.parse(value)
  if (!Number.isFinite(stamp)) return value
  const date = new Date(stamp)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Relative age in words, for the "last compaction" line. */
function fmtAge(value, now) {
  if (typeof value !== 'string') return null
  const stamp = Date.parse(value)
  if (!Number.isFinite(stamp)) return null
  const minutes = Math.max(0, Math.round((now - stamp) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** A lifecycle tier chip. The word is always present, so colour is never the only cue. */
function TierChip({ tier }) {
  const lower = String(tier ?? '').toLowerCase()
  const cls = lower === 'hot' ? 'pm-chip hot' : lower === 'warm' ? 'pm-chip warm' : lower === 'cold' ? 'pm-chip cold' : 'pm-chip young'
  return h('span', { className: cls }, tier)
}

/** A labelled field for the drawer. */
function Field({ label, children, mono }) {
  return h(
    'div',
    { className: 'pm-field' },
    h('div', { className: 'pm-field-label' }, label),
    h('div', { className: mono === true ? 'pm-field-value mono' : 'pm-field-value' }, children),
  )
}

// ------------------------------------------------------------------ components

/**
 * The detail drawer.
 *
 * Implements the interactions a drawer must have: Escape closes it, focus moves into the
 * panel on open and returns to the trigger on close, and the scrim is clickable.
 */
function MemoryDrawer(props) {
  const { row, t, onClose } = props
  const panelRef = React.useRef(null)
  const closeRef = React.useRef(null)

  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      // A minimal focus trap: Tab from the last control wraps to the first.
      if (event.key !== 'Tab' || panelRef.current === null) return
      const focusable = panelRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    // Focus the close button rather than the panel: a screen reader announces the dialog
    // either way, and a focused button is immediately operable.
    if (closeRef.current !== null) closeRef.current.focus()
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const hasSession = row.source !== null && typeof row.source?.sessionId === 'string'
  const hasCompaction = row.source !== null && typeof row.source?.compactionId === 'string'

  return h(
    React.Fragment,
    null,
    h('div', { className: 'pm-drawer-scrim', onClick: onClose, 'aria-hidden': true }),
    h(
      'div',
      {
        className: 'pm-drawer',
        ref: panelRef,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('detail.title'),
      },
      h(
        'div',
        { className: 'pm-drawer-head' },
        h('div', { className: 'pm-drawer-title' }, t('detail.title')),
        h('button', { className: 'pm-tbtn', ref: closeRef, onClick: onClose }, t('detail.close')),
      ),
      h(
        'div',
        { className: 'pm-drawer-body' },
        h(Field, { label: t('detail.id'), mono: true }, row.id),
        h('div', { className: 'pm-field' }, h('div', { className: 'pm-field-label' }, t('detail.content')), h('div', { className: 'pm-drawer-content' }, row.text)),
        h(Field, { label: t('detail.type') }, row.kind),
        h(
          'div',
          { className: 'pm-field' },
          h('div', { className: 'pm-field-label' }, t('detail.category')),
          h('div', { className: 'pm-chips' }, (row.category ?? []).map((id) => h('span', { key: id, className: 'pm-chip' }, id))),
        ),
        h('div', { className: 'pm-field' }, h('div', { className: 'pm-field-label' }, t('detail.tier')), h('div', null, h(TierChip, { tier: row.tier }))),
        h(Field, { label: t('detail.status') }, row.status),
        h(Field, { label: t('detail.priority') }, `${row.weight} / 5${row.pinned === true ? ` · ${t('detail.pinned')}` : ''}`),
        h(Field, { label: t('detail.counts') }, `${row.retrieved ?? 0} / ${row.delivered ?? 0} / ${row.used ?? 0}`),
        h(Field, { label: t('detail.created') }, fmtTime(row.createdAt, t)),
        h(Field, { label: t('detail.updated') }, `${fmtTime(row.updatedAt, t)}${row.lastUsedAt === null ? '' : ` · used ${fmtTime(row.lastUsedAt, t)}`}`),
        Array.isArray(row.files) && row.files.length > 0
          ? h('div', { className: 'pm-field' }, h('div', { className: 'pm-field-label' }, t('detail.files')), h('div', { className: 'pm-chips' }, row.files.map((f) => h('span', { key: f, className: 'pm-chip' }, f))))
          : null,
        Array.isArray(row.tags) && row.tags.length > 0
          ? h('div', { className: 'pm-field' }, h('div', { className: 'pm-field-label' }, t('detail.tags')), h('div', { className: 'pm-chips' }, row.tags.map((tag) => h('span', { key: tag, className: 'pm-chip' }, tag))))
          : null,
        // The source is either named or explicitly unavailable. An empty row here would
        // look like "no source", which is a different and wrong statement.
        h(
          'div',
          { className: 'pm-field' },
          h('div', { className: 'pm-field-label' }, t('detail.source')),
          h(
            'div',
            { className: hasSession || hasCompaction ? 'pm-field-value' : 'pm-field-value' },
            hasSession || hasCompaction
              ? fill(t('detail.sourceAvailable'), {
                  session: hasSession ? row.source.sessionId : '—',
                  compaction: hasCompaction ? row.source.compactionId : '—',
                })
              : h('span', { className: 'pm-muted' }, t('detail.sourceUnavailable')),
          ),
        ),
      ),
    ),
  )
}

/** One memory row in the explorer. A button, so keyboard and focus work for free. */
function AtomRow(props) {
  const { row, t, onOpen } = props
  return h(
    'button',
    { className: 'pm-atom', onClick: () => onOpen(row), 'aria-label': `${row.kind}: ${row.text.slice(0, 60)}` },
    h(
      'div',
      { className: 'pm-atom-head' },
      h('span', { className: 'pm-chip lead' }, row.kind),
      h(TierChip, { tier: row.tier }),
      row.status !== 'active' ? h('span', { className: 'pm-chip inactive' }, row.status) : null,
      row.pinned === true ? h('span', { className: 'pm-chip' }, `\u25cf ${t('detail.pinned')}`) : null,
      h('span', { className: 'pm-atom-meta' }, `w${row.weight}`),
      ...(row.category ?? []).slice(0, 3).map((id) => h('span', { key: id, className: 'pm-chip' }, id)),
    ),
    h('div', { className: 'pm-atom-text' }, row.text),
  )
}


// ------------------------------------------------------------------- pages

/**
 * Overview: the six numbers the tab exists to answer, plus the project picker.
 *
 * The picker lives here rather than in its own tab because "which project am I looking at"
 * is context, not a setting: it changes what every other number on the page means.
 */
function OverviewPage(props) {
  const { data, t, now, projects, selectedRoot, onPick } = props
  const atoms = data.atoms
  const semantic = data.semantic
  const capacity = data.capacity
  const recent = data.compactions?.recent ?? []
  const last = recent.length > 0 ? recent[0] : null
  const tiers = semantic?.tiers ?? null
  const metrics = semantic?.metrics ?? null

  return h(
    'div',
    { className: 'pm-page enter' },
    projects.length > 1
      ? h(
          'div',
          { className: 'pm-card' },
          h('div', { className: 'pm-card-title' }, t('project.title')),
          h(
            'div',
            { className: 'pm-projects' },
            ...projects.map((row) =>
              h(ProjectRow, {
                key: row.key ?? row.root,
                row,
                t,
                selected: selectedRoot !== null && row.root === selectedRoot,
                onPick: () => onPick(row.root),
              }),
            ),
          ),
        )
      : null,
    h(
      'div',
      { className: 'pm-grid' },
      h(
        'div',
        { className: 'pm-card hover' },
        h('div', { className: 'pm-card-title' }, t('overview.live')),
        h('div', { className: 'pm-metric' }, atoms?.live ?? '—'),
        h('div', { className: 'pm-metric-sub' }, atoms?.readable === false ? atoms.reason : `${atoms?.forgotten ?? 0} ${t('atoms.forgotten')}`),
      ),
      h(
        'div',
        { className: 'pm-card hover' },
        h('div', { className: 'pm-card-title' }, t('overview.standing')),
        h('div', { className: 'pm-metric' }, atoms?.standing ?? '—'),
        h('div', { className: 'pm-metric-sub' }, t('atoms.standing')),
      ),
      h(
        'div',
        { className: 'pm-card hover' },
        h('div', { className: 'pm-card-title' }, t('overview.tiers')),
        tiers === null
          ? h('div', { className: 'pm-metric-sub' }, t('overview.tierNone'))
          : h(
              'div',
              null,
              h('div', { className: 'pm-chips' }, h(TierChip, { tier: `HOT ${tiers.HOT}` }), h(TierChip, { tier: `WARM ${tiers.WARM}` }), h(TierChip, { tier: `COLD ${tiers.COLD}` })),
              h('div', { className: 'pm-metric-sub' }, `${tiers.YOUNG} young${tiers.pinned > 0 ? ` · ${tiers.pinned} pinned` : ''}`),
            ),
      ),
      h(
        'div',
        { className: 'pm-card hover' },
        h('div', { className: 'pm-card-title' }, t('overview.capacity')),
        h('div', { className: 'pm-metric' }, `${capacity?.live ?? 0}\u2009/\u2009${capacity?.limit ?? 0}`),
        h('div', { className: 'pm-metric-sub' }, capacity?.atLimit === true ? t('overview.capacityFull') : fill(t('overview.capacityOk'), { headroom: capacity?.headroom ?? 0 })),
      ),
    ),
    h(
      'div',
      { className: capacity?.atLimit === true ? 'pm-card warn' : 'pm-card' },
      h('div', { className: 'pm-card-title' }, t('capacity.title')),
      h(
        'div',
        { className: 'pm-chips' },
        h('span', { className: 'pm-chip' }, `${t('capacity.live')} ${capacity?.live ?? 0}`),
        h('span', { className: 'pm-chip' }, `${t('capacity.archived')} ${capacity?.archived ?? 0}`),
        h('span', { className: 'pm-chip' }, `${t('capacity.forgotten')} ${capacity?.forgotten ?? 0}`),
        h('span', { className: 'pm-chip' }, `${t('capacity.records')} ${capacity?.records ?? 0}`),
      ),
      h('div', { className: 'pm-hint' }, t('capacity.coldHint')),
      // Which fate is which, spelled out: a full store is not a store that lost memory.
      atoms?.atLimit === true ? h('div', { className: 'pm-warn' }, fill(t('atoms.limit'), { limit: atoms.limit })) : null,
      atoms?.invalid > 0 ? h('div', { className: 'pm-warn' }, fill(t('atoms.invalid'), { count: atoms.invalid })) : null,
    ),
    h(
      'div',
      { className: 'pm-card lead' },
      h('div', { className: 'pm-card-title' }, t('overview.lastCompact')),
      last === null
        ? h('div', { className: 'pm-muted' }, t('overview.lastCompactNone'))
        : h(
            'div',
            null,
            h(
              'div',
              { className: 'pm-headline' },
              last.skipReason !== null
                ? `${fmtTime(last.at, t)} · ${last.skipReason}`
                : `${fmtTime(last.at, t)} · +${last.added} atoms`,
            ),
            h('div', { className: 'pm-hint' }, `${fmtAge(last.at, now) ?? ''}${last.turn === null ? '' : ` · turn ${last.turn}`}`),
          ),
    ),
    h(
      'div',
      { className: 'pm-card' },
      h('div', { className: 'pm-card-title' }, t('overview.lastRouter')),
      metrics === null
        ? h('div', { className: 'pm-muted' }, t('overview.lastRouterNone'))
        : h(
            'div',
            null,
            h('div', { className: 'pm-headline' }, `${metrics.routerCalls} ${t('trace.routerOk')}`),
            h(
              'div',
              { className: 'pm-hint' },
              [
                metrics.routerSuccessRate === null ? null : `ok ${Math.round(metrics.routerSuccessRate * 100)}%`,
                metrics.routerLatencyMsMean === null ? null : `\u2248${metrics.routerLatencyMsMean}ms`,
                metrics.categoryHitRate === null ? null : `category ${Math.round(metrics.categoryHitRate * 100)}%`,
              ]
                .filter((part) => part !== null)
                .join(' · ') || t('trace.notCollected'),
            ),
          ),
    ),
  )
}

/** Explorer: filter, search, paginate, open a drawer. */
function ExplorerPage(props) {
  const { data, t, onOpen } = props
  const explorer = data.explorer
  const all = Array.isArray(explorer?.rows) ? explorer.rows : []

  const [query, setQuery] = React.useState('')
  const [debounced, setDebounced] = React.useState('')
  const [kind, setKind] = React.useState('')
  const [category, setCategory] = React.useState('')
  const [tier, setTier] = React.useState('')
  const [status, setStatus] = React.useState('')
  const [sort, setSort] = React.useState('weight')
  const [shown, setShown] = React.useState(40)

  // Debounced so typing does not re-filter 400 rows on every keystroke.
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim().toLowerCase()), 160)
    return () => clearTimeout(timer)
  }, [query])

  const kinds = React.useMemo(() => [...new Set(all.map((row) => row.kind))].sort(), [all])
  const categories = React.useMemo(() => [...new Set(all.flatMap((row) => row.category ?? []))].sort(), [all])
  const tiers = React.useMemo(() => [...new Set(all.map((row) => row.tier))], [all])
  const statuses = React.useMemo(() => [...new Set(all.map((row) => row.status))], [all])

  const filtered = React.useMemo(() => {
    const rows = all.filter((row) => {
      if (kind !== '' && row.kind !== kind) return false
      if (category !== '' && !(row.category ?? []).includes(category)) return false
      if (tier !== '' && row.tier !== tier) return false
      if (status !== '' && row.status !== status) return false
      if (debounced !== '' && !`${row.text} ${row.id}`.toLowerCase().includes(debounced)) return false
      return true
    })
    const sorted = [...rows]
    if (sort === 'recent') sorted.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    else sorted.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    return sorted
  }, [all, kind, category, tier, status, debounced, sort])

  const visible = filtered.slice(0, shown)
  const hasFilters = kind !== '' || category !== '' || tier !== '' || status !== '' || query !== ''

  const select = (value, setter, options, label, allLabel) =>
    h(
      'select',
      { className: 'pm-select', value, onChange: (event) => setter(event.target.value), 'aria-label': label },
      h('option', { value: '' }, `${label}: ${allLabel}`),
      ...options.map((option) => h('option', { key: option, value: option }, option)),
    )

  if (all.length === 0) {
    return h('div', { className: 'pm-page enter' }, h('div', { className: 'pm-card' }, h('div', { className: 'pm-empty' }, t('explorer.emptyStore'))))
  }

  return h(
    'div',
    { className: 'pm-page enter' },
    h(
      'div',
      { className: 'pm-card' },
      h(
        'div',
        { className: 'pm-filters' },
        h('input', {
          className: 'pm-search',
          type: 'search',
          value: query,
          placeholder: t('explorer.search'),
          'aria-label': t('explorer.search'),
          onChange: (event) => setQuery(event.target.value),
        }),
        select(kind, setKind, kinds, t('explorer.kind'), t('explorer.all')),
        select(category, setCategory, categories, t('explorer.category'), t('explorer.all')),
        select(tier, setTier, tiers, t('explorer.tier'), t('explorer.all')),
        select(status, setStatus, statuses, t('explorer.status'), t('explorer.all')),
        h(
          'select',
          { className: 'pm-select', value: sort, onChange: (event) => setSort(event.target.value), 'aria-label': 'sort' },
          h('option', { value: 'weight' }, t('explorer.sortWeight')),
          h('option', { value: 'recent' }, t('explorer.sortRecent')),
        ),
        hasFilters
          ? h(
              'button',
              {
                className: 'pm-tbtn',
                onClick: () => {
                  setQuery('')
                  setKind('')
                  setCategory('')
                  setTier('')
                  setStatus('')
                },
              },
              t('explorer.clear'),
            )
          : null,
      ),
      h('div', { className: 'pm-hint' }, fill(t('explorer.count'), { shown: filtered.length, total: explorer.total })),
    ),
    visible.length === 0
      ? h('div', { className: 'pm-card' }, h('div', { className: 'pm-empty' }, t('explorer.none')))
      : h('div', { className: 'pm-list' }, visible.map((row) => h(AtomRow, { key: row.id, row, t, onOpen }))),
    filtered.length > visible.length
      ? h('button', { className: 'pm-btn', onClick: () => setShown((n) => n + 40) }, t('explorer.loadMore'))
      : null,
  )
}

/** Compactions: the timeline, each row expandable. */
function CompactionsPage(props) {
  const { data, t } = props
  const recent = data.compactions?.recent ?? []
  const [open, setOpen] = React.useState(null)
  if (recent.length === 0) {
    return h('div', { className: 'pm-page enter' }, h('div', { className: 'pm-card' }, h('div', { className: 'pm-empty' }, t('overview.lastCompactNone'))))
  }
  return h(
    'div',
    { className: 'pm-page enter' },
    h(
      'div',
      { className: 'pm-card' },
      h(
        'div',
        { className: 'pm-card-title' },
        t('compactions.title'),
        ` · ${fill(t('compactions.total'), { total: data.compactions.total, atoms: data.compactions.atoms })}`,
      ),
      data.compactions?.lastAt === null || data.compactions?.lastAt === undefined
        ? h('div', { className: 'pm-hint' }, t('compactions.headline.none'))
        : h(
            'div',
            { className: 'pm-hint' },
            data.compactions.recent[0]?.skipReason !== null
              ? fill(t('compactions.headline.empty'), { reason: data.compactions.recent[0]?.skipReason ?? '' })
              : fill(t('compactions.headline.first'), { added: data.compactions.recent[0]?.added ?? 0, when: fmtTime(data.compactions.lastAt, t) }),
          ),
    ),
    h(
      'div',
      { className: 'pm-list' },
      ...recent.map((row) => {
        const key = row.compactionId ?? `${row.at}-${row.turn}`
        const isOpen = open === key
        return h(
          'div',
          { key },
          h(
            'button',
            { className: row.added === 0 ? 'pm-tl-row silent' : 'pm-tl-row', onClick: () => setOpen(isOpen ? null : key), 'aria-expanded': isOpen },
            h('span', null, row.skipReason !== null ? row.skipReason : `+${row.added}`),
            h('span', { className: 'pm-atom-meta' }, `${fmtTime(row.at, t)}${row.turn === null ? '' : ` · ${row.turn}`}`),
          ),
          isOpen
            ? h(
                'div',
                { className: 'pm-tl-detail' },
                h(Field, { label: t('compactions.row.added') }, `${row.added} ${t('compactions.row.added')} · ${fill(t('compactions.row.updated'), { updated: row.updated })} · ${fill(t('compactions.row.unchanged'), { unchanged: row.unchanged })}`),
                h(Field, { label: t('compactions.timeline') }, fill(t('compactions.row.timeNoTurn'), { when: fmtTime(row.at, t), chars: row.summaryChars })),
                h(Field, { label: t('compactions.reasons') }, row.skipReason === null ? '—' : fill(t('compactions.row.skipped'), { reason: row.skipReason })),
                h(Field, { label: t('detail.source') }, key),
              )
            : null,
        )
      }),
    ),
  )
}

/** Router trace: only what the backend actually recorded. */
function RouterTracePage(props) {
  const { data, t } = props
  const metrics = data.semantic?.metrics
  const notCollected = h('span', { className: 'pm-muted' }, t('trace.notCollected'))
  const router = data.router ?? {}

  // The readiness line from the old panel, kept because it is the answer to "why is
  // nothing being routed": a filled-in model with no subagent provider looks identical
  // to a working one until you check this.
  const readiness =
    router.serviceAvailable === false
      ? t('router.status.noservice')
      : router.provider === '' || router.model === ''
        ? t('router.status.unconfigured')
        : null

  // The backend records aggregate counters, not per-run traces. Saying so is the honest
  // rendering: inventing a plausible task intent for each row would be fabrication.
  return h(
    'div',
    { className: 'pm-page enter' },
    readiness === null
      ? null
      : h('div', { className: 'pm-card' }, h('div', { className: 'pm-card-title' }, t('router.title')), h('div', { className: 'pm-warn' }, readiness)),
    h(
      'div',
      { className: 'pm-card' },
      h('div', { className: 'pm-card-title' }, t('trace.title')),
      metrics === null
        ? h('div', { className: 'pm-empty' }, t('trace.none'))
        : h(
            'div',
            null,
            h(Field, { label: t('trace.intent') }, t('trace.intentNone')),
            h(Field, { label: t('trace.candidates') }, metrics.retrievalsAtomsMean === null ? notCollected : `\u2248${metrics.retrievalsAtomsMean}`),
            h(Field, { label: t('trace.routerOk') }, `${metrics.routerCalls} (${metrics.routerFailures} failed)`),
            h(Field, { label: t('trace.categories') }, metrics.categoryHitRate === null ? notCollected : `${Math.round(metrics.categoryHitRate * 100)}% hit`),
            h(Field, { label: t('trace.hot') }, data.semantic?.tiers === null || data.semantic?.tiers === undefined ? notCollected : `${data.semantic.tiers.HOT} hot`),
            h(Field, { label: t('trace.cold') }, data.semantic?.tiers === null || data.semantic?.tiers === undefined ? notCollected : `${data.semantic.tiers.COLD} cold`),
            h(Field, { label: t('trace.packageTokens') }, metrics.deliveredTokensMean === null ? notCollected : `\u2248${metrics.deliveredTokensMean}`),
            h(Field, { label: t('trace.delivery') }, metrics.deliveries === 0 ? t('trace.notDelivered') : `${metrics.deliveries} \u00d7 ${t('trace.delivered')}`),
            h(Field, { label: t('trace.latency') }, metrics.routerLatencyMsMean === null ? notCollected : `${metrics.routerLatencyMsMean}ms (p50 ${metrics.routerLatencyMsP50 ?? '—'})`),
            h(Field, { label: t('trace.error') }, metrics.routerFailures === 0 ? '—' : `${metrics.routerFailures}`),
          ),
    ),
    h(
      'div',
      { className: 'pm-card' },
      h('div', { className: 'pm-card-title' }, t('compactions.title')),
      h('div', { className: 'pm-hint' }, `${(data.compactions?.recent ?? []).length} ${t('tab.compactions')}`),
    ),
  )
}

/** Settings: the router controls (editable) plus the read-only upgrade switches. */
function SettingsPage(props) {
  const { data, t, choice, setChoice, saving, saveReason, onSave, scope, setScope, canOverride, resetOverride, overridden } = props
  const settings = data.settings
  const base = data.base ?? settings
  const semantic = data.semantic
  const switches = semantic?.switches ?? {}

  const tierOption = (tier) =>
    h(
      'label',
      { key: tier, className: choice?.routerTier === tier ? 'pm-choice on' : 'pm-choice' },
      h(
        'div',
        { className: 'pm-choice-head' },
        h('span', { className: choice?.routerTier === tier ? 'pm-radio on' : 'pm-radio' }, choice?.routerTier === tier ? '\u25cf' : '\u25cb'),
        h('span', { className: 'pm-choice-title' }, t(`tier.${tier}`)),
        h('span', { className: 'pm-choice-desc' }, t(`tier.${tier}.desc`)),
      ),
      h('input', { type: 'radio', name: 'pm-tier', checked: choice?.routerTier === tier, onChange: () => setChoice({ ...choice, routerTier: tier }), className: 'pm-sr-only' }),
    )

  const strategyOption = (strategy) =>
    h(
      'label',
      { key: strategy, className: choice?.routerStrategy === strategy ? 'pm-choice on' : 'pm-choice' },
      h(
        'div',
        { className: 'pm-choice-head' },
        h('span', { className: choice?.routerStrategy === strategy ? 'pm-radio on' : 'pm-radio' }, choice?.routerStrategy === strategy ? '\u25cf' : '\u25cb'),
        h('span', { className: 'pm-choice-title' }, t(`strategy.${strategy}`)),
        h('span', { className: 'pm-choice-desc' }, t(`strategy.${strategy}.desc`)),
      ),
      h('input', { type: 'radio', name: 'pm-strategy', checked: choice?.routerStrategy === strategy, onChange: () => setChoice({ ...choice, routerStrategy: strategy }), className: 'pm-sr-only' }),
    )

  const switchRow = (key, label) =>
    h(
      'div',
      { className: 'pm-row' },
      h('span', null, label),
      h('span', { className: switches[key] === true ? 'pm-chip lead' : 'pm-chip' }, switches[key] === true ? t('settings.on') : t('settings.off')),
    )

  return h(
    'div',
    { className: 'pm-page enter' },
    // --- router model, editable -------------------------------------------------
    h(
      'div',
      { className: 'pm-card' },
      h(
        'div',
        { className: 'pm-head' },
        h('div', { className: 'pm-card-title' }, t('settings.router')),
        canOverride
          ? h(
              'div',
              { className: 'pm-chips' },
              h('button', { className: scope === 'project' ? 'pm-tbtn on' : 'pm-tbtn', onClick: () => setScope('project') }, t('scope.project')),
              h('button', { className: scope === 'global' ? 'pm-tbtn on' : 'pm-tbtn', onClick: () => setScope('global') }, t('scope.global')),
            )
          : null,
      ),
      h('div', { className: 'pm-group' }, ...['always', 'smart', 'off'].map(tierOption)),
      h('div', { className: 'pm-group' }, ...['task', 'compliance', 'orient'].map(strategyOption)),
      h(Field, { label: t('router.provider') }, h('input', { className: 'pm-input', value: choice?.routerProvider ?? '', onChange: (event) => setChoice({ ...choice, routerProvider: event.target.value }), placeholder: base.routerProvider || '' })),
      h('div', { className: 'pm-hint' }, t('router.provider.hint')),
      h(Field, { label: t('router.model') }, h('input', { className: 'pm-input', value: choice?.routerModel ?? '', onChange: (event) => setChoice({ ...choice, routerModel: event.target.value }), placeholder: base.routerModel || '' })),
      h('div', { className: 'pm-hint' }, t('router.strategy.hint')),
      // Which layer the next save writes to, said in the place the button is.
      h('div', { className: 'pm-hint' }, canOverride === false ? t('scope.project.unavailable') : scope === 'project' ? t('scope.hint.project') : t('scope.global.hint')),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        h('button', { className: 'pm-btn', disabled: saving === true, onClick: onSave }, saving === true ? t('router.saving') : t('router.save')),
        saveReason === null ? null : h('span', { className: saveReason.ok ? 'pm-ok' : 'pm-warn' }, saveReason.text),
      ),
      overridden.length > 0
        ? h(
            'div',
            { className: 'pm-chips' },
            ...overridden.map((key) =>
              h(
                'span',
                { key, className: 'pm-chip own' },
                key,
                h('button', { className: 'pm-btn small', style: { marginLeft: '6px' }, onClick: () => resetOverride(key) }, t('scope.reset')),
              ),
            ),
          )
        : null,
    ),
    // --- upgrade switches, read-only -------------------------------------------
    h(
      'div',
      { className: 'pm-card' },
      h('div', { className: 'pm-card-title' }, t('settings.semantic')),
      switchRow('semanticRouting', t('settings.semantic')),
      switchRow('lifecycleEnabled', t('settings.lifecycle')),
      switchRow('lifecycleAutoSweep', t('settings.lifecycleSweep')),
      switchRow('taskIntentEnabled', t('settings.taskIntent')),
      switchRow('intentCacheEnabled', t('settings.intentCache')),
      switchRow('metricsEnabled', t('settings.metrics')),
      h('div', { className: 'pm-hint' }, t('settings.readOnly')),
    ),
    // --- capacity ---------------------------------------------------------------
    h(
      'div',
      { className: 'pm-card' },
      h('div', { className: 'pm-card-title' }, t('settings.capacity')),
      h('div', { className: 'pm-row' }, h('span', null, t('atoms.live')), h('span', { className: 'pm-num' }, `${data.capacity?.live ?? 0} / ${data.capacity?.limit ?? 0}`)),
      h('div', { className: 'pm-hint' }, fill(t('recall.line'), { budget: settings.recallBudget, limit: settings.recallLimit })),
      // The breakdown, so "400 live" is not a single unexplained number.
      h('div', { className: 'pm-chips' }, ...Object.entries(data.atoms?.byKind ?? {}).map(([k, n]) => h('span', { key: k, className: 'pm-chip' }, `${k} ${n}`))),
      h('div', { className: 'pm-hint' }, t('capacity.coldHint')),
    ),
  )
}


// --------------------------------------------------------------------- shell

/**
 * The dashboard shell: toolbar, tabs, scrolling body, drawer.
 *
 * The toolbar is where navigation lives. `props.close` is the host's own way out of a
 * main panel — using it, rather than `history.back()`, is what keeps the Back button from
 * closing the Electron window when the panel is the first thing the user opened.
 */
function MemoryDashboard(props) {
  const { t } = props
  const [state, setState] = React.useState({ phase: 'loading', data: null, reason: null, refreshing: false })
  const [tab, setTab] = React.useState('overview')
  const [selected, setSelected] = React.useState(null)
  const [scope, setScope] = React.useState('project')
  const [choice, setChoice] = React.useState(null)
  const [saving, setSaving] = React.useState(false)
  const [saveReason, setSaveReason] = React.useState(null)
  const [drawer, setDrawer] = React.useState(null)
  const bodyRef = React.useRef(null)
  const now = Date.now()

  const load = React.useCallback(async (root) => {
    setState((current) => ({ phase: current.data === null ? 'loading' : 'ready', data: current.data, reason: null, refreshing: true }))
    const path = root === null || root === undefined ? STATUS_PATH : `${STATUS_PATH}?project=${encodeURIComponent(root)}`
    const result = await getJson(path)
    if (result.ok) setState({ phase: 'ready', data: result.data, reason: null, refreshing: false })
    else setState({ phase: 'error', data: null, reason: result.reason, refreshing: false })
    return result
  }, [])

  React.useEffect(() => {
    void load(selected)
  }, [load, selected])

  // Mirror the saved settings into the editor until the layer being edited changes.
  React.useEffect(() => {
    if (state.data === null) return
    const shown = scope === 'project' ? state.data.settings : state.data.base ?? state.data.settings
    setChoice({ routerTier: shown.routerTier, routerStrategy: shown.routerStrategy, routerProvider: shown.routerProvider, routerModel: shown.routerModel })
  }, [state.data, scope])

  // Scroll to the top when the page changes: landing halfway down a 400-row list is
  // disorienting, and the previous scroll offset belongs to the previous page.
  React.useEffect(() => {
    if (bodyRef.current !== null) bodyRef.current.scrollTop = 0
  }, [tab])

  const save = React.useCallback(async () => {
    if (choice === null || state.data === null) return
    const shown = scope === 'project' ? state.data.settings : state.data.base ?? state.data.settings
    const pending = [
      ['routerTier', choice.routerTier],
      ['routerStrategy', choice.routerStrategy],
      ['routerProvider', choice.routerProvider],
      ['routerModel', choice.routerModel],
    ].filter(([key]) => choice[key] !== shown[key])
    setSaving(true)
    setSaveReason(null)
    if (pending.length === 0) {
      setSaving(false)
      setSaveReason({ ok: true, text: t('router.saved') })
      return
    }
    for (const [key, value] of pending) {
      try {
        const response = await fetch(CONFIG_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key, value, scope, ...(state.data.root === null ? {} : { project: state.data.root }) }),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) {
          setSaving(false)
          const text = String(body.error ?? '')
          setSaveReason({ ok: false, text: `${t('router.failed')}: ${text.includes('configEditor') ? t('router.readonly') : text || `HTTP ${response.status}`}` })
          return
        }
      } catch (error) {
        setSaving(false)
        setSaveReason({ ok: false, text: `${t('router.failed')}: ${error && error.message ? error.message : String(error)}` })
        return
      }
    }
    setSaving(false)
    setSaveReason({ ok: true, text: t('router.saved') })
    await load(selected)
  }, [choice, state.data, scope, selected, t, load])

  const resetOverride = React.useCallback(
    async (key) => {
      if (state.data === null || state.data.root === null) return
      setSaving(true)
      try {
        const response = await fetch(`${CONFIG_PATH}?project=${encodeURIComponent(state.data.root)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key, value: null, scope: 'project' }),
        })
        if (!response.ok) {
          const body = await response.json().catch(() => ({}))
          setSaving(false)
          setSaveReason({ ok: false, text: `${t('router.failed')}: ${String(body.error ?? `HTTP ${response.status}`)}` })
          return
        }
        setSaving(false)
        setSaveReason({ ok: true, text: t('router.saved') })
        await load(selected)
      } catch (error) {
        setSaving(false)
        setSaveReason({ ok: false, text: `${t('router.failed')}: ${error && error.message ? error.message : String(error)}` })
      }
    },
    [state.data, selected, t, load],
  )

  // --- chrome ---------------------------------------------------------------
  const data = state.data
  const projectLabel = data?.root ?? (data === null ? '' : t('page.noProject'))
  const shortRoot = typeof data?.root === 'string' ? data.root.split(/[\\/]/).filter(Boolean).slice(-2).join('/') : t('page.noProject')

  const tabs = [
    ['overview', t('tab.overview')],
    ['explorer', t('tab.explorer')],
    ['compactions', t('tab.compactions')],
    ['router', t('tab.router')],
    ['settings', t('tab.settings')],
  ]

  const toolbar = h(
    'div',
    { className: 'pm-toolbar' },
    // The host passes `close` for a main panel. Falling back to nothing (rather than to
    // history.back) is deliberate: history.back in an Electron shell can leave the app.
    props.close === undefined
      ? null
      : h('button', { className: 'pm-tbtn', onClick: () => props.close(), title: t('nav.back') }, `\u2190 ${t('nav.back')}`),
    h(
      'div',
      { className: 'pm-toolbar-main' },
      h('div', { className: 'pm-crumbs' }, h('span', { className: 'pm-crumb' }, t('nav.crumbRoot')), h('span', { className: 'pm-crumb-sep' }, '/'), h('span', { className: 'pm-crumb-now' }, shortRoot)),
      h('div', { className: 'pm-title' }, t('panel.title')),
      data?.root === null ? h('div', { className: 'pm-sub' }, t('page.noProject')) : h('div', { className: 'pm-sub' }, projectLabel),
    ),
    h('button', { className: 'pm-tbtn', disabled: state.refreshing === true, onClick: () => void load(selected), title: t('nav.refresh') }, state.refreshing === true ? t('page.refreshing') : `\u21bb ${t('nav.refresh')}`),
    h('button', { className: 'pm-tbtn', onClick: () => setTab('settings'), title: t('nav.settings') }, `\u2699 ${t('nav.settings')}`),
  )

  const tabbar = h(
    'div',
    { className: 'pm-tabs', role: 'tablist' },
    ...tabs.map(([id, label]) =>
      h(
        'button',
        {
          key: id,
          className: tab === id ? 'pm-tab on' : 'pm-tab',
          role: 'tab',
          'aria-selected': tab === id,
          onClick: () => setTab(id),
        },
        label,
        id === 'explorer' && data?.explorer ? h('span', { className: 'pm-tab-count' }, data.explorer.total) : null,
        id === 'compactions' && data?.compactions ? h('span', { className: 'pm-tab-count' }, data.compactions.total) : null,
      ),
    ),
  )

  // --- body -----------------------------------------------------------------
  let body
  if (state.phase === 'loading' && data === null) {
    body = h(
      'div',
      { className: 'pm-page' },
      h('div', { className: 'pm-muted' }, t('panel.loading')),
      h('div', { className: 'pm-skel', style: { height: '18px', width: '40%' } }),
      h('div', { className: 'pm-skel', style: { height: '90px' } }),
      h('div', { className: 'pm-skel', style: { height: '120px' } }),
    )
  } else if (state.phase === 'error') {
    body = h(
      'div',
      { className: 'pm-page' },
      h('div', { className: 'pm-banner bad' }, `${t('panel.error')}: ${state.reason}`),
      h('button', { className: 'pm-btn', onClick: () => void load(selected) }, t('panel.retry')),
    )
  } else if (data !== null && data.atoms?.readable === true && data.atoms.live === 0 && tab !== 'settings') {
    // An empty store is not a failure, and it is not the same as an unreadable one: the
    // sentence has to tell the user how memory gets written.
    body = h('div', { className: 'pm-page' }, h('div', { className: 'pm-card' }, h('div', { className: 'pm-empty' }, t('panel.empty'))))
  } else if (data !== null) {
    if (data.root === null && tab !== 'settings') {
      // "No project root" is a different statement from "this project has no memory".
      body = h(
        'div',
        { className: 'pm-page' },
        h(
          'div',
          { className: 'pm-card' },
          h('div', { className: 'pm-banner warn' }, t('panel.noRoot')),
          h(
            'div',
            { className: 'pm-projects' },
            ...(Array.isArray(data.projects) && data.projects.length > 0
              ? data.projects.map((row) =>
                  h(ProjectRow, {
                    key: row.key ?? row.root,
                    row,
                    t,
                    selected: false,
                    onPick: () => {
                      setSelected(row.root)
                      setScope('project')
                    },
                  }),
                )
              : [h('div', { className: 'pm-muted' }, t('project.none'))]),
          ),
        ),
      )
    } else if (tab === 'overview') {
      // Picking a project is a statement about which project you are configuring, so the
      // editor follows it into project scope rather than staying on a layer the user did
      // not mean.
      body = h(OverviewPage, {
        data,
        t,
        now,
        projects: Array.isArray(data.projects) ? data.projects : [],
        selectedRoot: data.root,
        onPick: (root) => {
          setSelected(root)
          setScope('project')
          setSaveReason(null)
        },
      })
    }
    else if (tab === 'explorer') body = h(ExplorerPage, { data, t, onOpen: (row) => setDrawer(row) })
    else if (tab === 'compactions') body = h(CompactionsPage, { data, t })
    else if (tab === 'router') body = h(RouterTracePage, { data, t })
    else body = h(SettingsPage, {
      data,
      t,
      choice,
      setChoice,
      saving,
      saveReason,
      onSave: () => void save(),
      scope,
      setScope,
      canOverride: data.root !== null && Array.isArray(data.overridable) && data.overridable.length > 0,
      resetOverride: (key) => void resetOverride(key),
      overridden: Array.isArray(data.overridden) ? data.overridden : [],
    })
  }

  return h(
    'div',
    { className: 'pm-root' },
    h('style', { key: 'pm-css' }, CSS),
    toolbar,
    tabbar,
    h('div', { className: 'pm-body', ref: bodyRef }, body),
    drawer === null ? null : h(MemoryDrawer, { row: drawer, t, onClose: () => setDrawer(null) }),
  )
}


// --------------------------------------------------------------------- apply

    /**
     * Register the dictionary, the sidebar row, and the main panel.
     * @param ctx - the Client context this bundle was given.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'project-memory: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 25, locale: NS, label: () => t('panel.open') },
          MemoryIcon
        )
      )

      ctx.slots.inject('main', () =>
        // The dashboard receives the slot props untouched: `close` is the host's own way
        // out of a main panel, and using it keeps Back from reaching for history.
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }) }, MemoryDashboard)
      )
    }

    // `CSS` is deliberately not returned: the host reads only `inject` and `apply`, and
    // an extra field is silently dropped. The stylesheet is rendered by the panel
    // component instead (see the `<style>` node in the render tree).
    return { inject: ['slots', 'locale'], apply }
  }
})
