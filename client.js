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
     * Human labels for the routing strategies.
     *
     * The keys are the values the Host validator accepts. The descriptions say what
     * changes, not what the strategy is called: "compliance" is a name, "keeps rules
     * that govern the files you are editing" is the thing the user is choosing.
     */
    const STRATEGY_TEXT = {
      task: { title: 'task', desc: 'Prioritise what this step is about to do: the files in play and the decisions already made about them.' },
      compliance: { title: 'compliance', desc: 'Prioritise the rules and corrections that govern the files in play, even when their wording looks unrelated.' },
      orient: { title: 'orient', desc: 'Prioritise how the subsystem works and why, for requests that ask to understand rather than to act.' }
    }

    /** What each routing tier costs, stated in model calls rather than adjectives. */
    const TIER_TEXT = {
      off: { title: 'off', desc: 'Deterministic scoring only. No model call, ever.' },
      smart: { title: 'smart', desc: 'Asks the router model only when deterministic scoring comes back empty or weak.' },
      always: { title: 'always', desc: 'Asks the router model on every step. Needs a provider and a model below.' }
    }

    // ---------------------------------------------------------------- dictionary

    const zh = {
      'panel.title': '项目记忆',
      'panel.open': '打开项目记忆',
      'panel.loading': '正在读取…',
      'panel.retry': '重新读取',
      'panel.noRoot': '无法确定项目根目录。设置 projectRoot，或在一个会话里打开本面板。',
      'panel.error': '读取失败',
      'panel.empty': '这个项目还没有任何记忆。压实发生时会自动写入，也可以用 memory_remember 主动写入。',
      'atoms.title': '记忆原子',
      'atoms.live': '生效',
      'atoms.forgotten': '已遗忘',
      'atoms.standing': '常驻硬约束',
      'atoms.standing.hint': '这些约束即使与当前请求无关也会被保留。资格由类型决定，与重要性无关。',
      'atoms.invalid': '{count} 行记忆无法解析，已跳过。其余记录仍然可用。',
      'atoms.byKind': '按类型',
      'atoms.byWeight': '按重要性',
      'compactions.title': '压缩记录',
      'compactions.none': '还没有观测到压实。插件安装之后发生的压实才会被记录。',
      'compactions.line': '共 {total} 次：{produced} 次写入原子，{skipped} 次没有产出',
      'compactions.reasons': '未产出的原因',
      'compactions.last': '最近一次',
      'router.title': '记忆路由',
      'router.tier': '触发策略',
      'router.strategy': '关注重点',
      'router.provider': '副模型提供方',
      'router.model': '副模型',
      'router.provider.hint': '留空则完全不做模型调用。',
      'router.strategy.hint': '策略不同，发给副模型的提示词也不同。',
      'router.save': '保存',
      'router.saving': '保存中…',
      'router.saved': '已保存',
      'router.failed': '保存失败',
      'router.readonly': '这个 profile 不支持保存设置。',
      'router.notConfigured': '未配置副模型，当前只做确定性选择。',
      'recall.title': '召回预算',
      'recall.line': '每次最多 {budget} tokens、{limit} 条',
      'project.title': '项目',
      'project.select': '查看哪个项目',
      'project.current': '当前会话',
      'project.unknown': '这个路径不是已登记的项目，无法显示。回到列表里选一个。',
      'project.none': '还没有登记任何项目。在某个项目里开始一次会话后，它就会出现在这里。',
      'project.atoms': '{count} 条原子',
      'project.noMemory': '尚未建立记忆',
      'scope.title': '设置作用范围',
      'scope.global': '全局（所有项目）',
      'scope.project': '仅本项目',
      'scope.global.hint': '改动写进 profile 配置，对所有项目生效。',
      'scope.project.hint': '改动只写进这个项目的 .dsh-memory，其他项目不受影响。',
      'scope.project.unavailable': '没有选中项目，无法设置项目级配置。',
      'scope.overridden': '这些设置由本项目覆盖：',
      'scope.inherit': '跟随全局',
      'scope.reset': '恢复跟随全局',
      'router.overrideOn': '本项目已覆盖',
      'router.empty': '留空表示跟随全局（{value}）。'
    }

    const en = {
      'panel.title': 'Project memory',
      'panel.open': 'Open project memory',
      'panel.loading': 'Reading…',
      'panel.retry': 'Read again',
      'panel.noRoot': 'No project root could be determined. Set projectRoot, or open this panel from a session.',
      'panel.error': 'Could not read',
      'panel.empty': 'No memory for this project yet. Compaction writes it automatically, and memory_remember writes it on demand.',
      'atoms.title': 'Memory atoms',
      'atoms.live': 'live',
      'atoms.forgotten': 'forgotten',
      'atoms.standing': 'standing hard rules',
      'atoms.standing.hint': 'These are kept even when the current request is unrelated. Eligibility comes from the kind, not from importance.',
      'atoms.invalid': '{count} stored line(s) could not be parsed and were skipped. The remaining records are still used.',
      'atoms.byKind': 'By kind',
      'atoms.byWeight': 'By weight',
      'compactions.title': 'Compactions',
      'compactions.none': 'No compaction observed yet. Only compactions after this plugin was installed are recorded.',
      'compactions.line': '{total} total: {produced} wrote atoms, {skipped} produced nothing',
      'compactions.reasons': 'Why nothing was produced',
      'compactions.last': 'Last',
      'router.title': 'Memory routing',
      'router.tier': 'When to route',
      'router.strategy': 'What to prioritise',
      'router.provider': 'Router provider',
      'router.model': 'Router model',
      'router.provider.hint': 'Leave both empty and no model is ever called.',
      'router.strategy.hint': 'The strategy changes the instructions the router model receives.',
      'router.save': 'Save',
      'router.saving': 'Saving…',
      'router.saved': 'Saved',
      'router.failed': 'Save failed',
      'router.readonly': 'This profile cannot persist settings.',
      'router.notConfigured': 'No router model configured, so only deterministic selection runs.',
      'recall.title': 'Recall budget',
      'recall.line': 'At most {budget} tokens and {limit} atoms per step',
      'project.title': 'Project',
      'project.select': 'Which project to show',
      'project.current': 'current session',
      'project.unknown': 'That path is not a registered project, so there is nothing to show. Pick one from the list.',
      'project.none': 'No project registered yet. Start a session inside one and it appears here.',
      'project.atoms': '{count} atoms',
      'project.noMemory': 'no memory yet',
      'scope.title': 'Where changes apply',
      'scope.global': 'Global (every project)',
      'scope.project': 'This project only',
      'scope.global.hint': 'Writes to the profile config, so every project follows it.',
      'scope.project.hint': 'Writes into this project\u2019s .dsh-memory; other projects are untouched.',
      'scope.project.unavailable': 'No project selected, so nothing can be set per project.',
      'scope.overridden': 'This project overrides:',
      'scope.inherit': 'Follow global',
      'scope.reset': 'Stop overriding',
      'router.overrideOn': 'Overridden here',
      'router.empty': 'Leave empty to follow global ({value}).'
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
.pm-panel { display: flex; flex-direction: column; gap: 18px; padding: 20px 22px 28px; max-width: 760px; }
.pm-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.pm-title { font-size: 15px; font-weight: 600; letter-spacing: 0.01em; }
.pm-sub { font-size: 11px; opacity: 0.55; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
.pm-card { border: 1px solid var(--dsh-border, rgba(127,127,127,0.22)); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.pm-card-title { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; opacity: 0.62; }
.pm-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; }
.pm-num { font-variant-numeric: tabular-nums; font-weight: 600; }
.pm-muted { opacity: 0.6; font-size: 12px; line-height: 1.55; }
.pm-hint { opacity: 0.55; font-size: 11.5px; line-height: 1.5; }
.pm-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.pm-chip { font-size: 11.5px; padding: 2px 8px; border-radius: 999px; background: var(--dsh-surface, rgba(127,127,127,0.12)); font-variant-numeric: tabular-nums; }
.pm-chip.lead { background: var(--dsh-accent, rgba(90,140,255,0.18)); }
.pm-choice { display: flex; flex-direction: column; gap: 3px; padding: 9px 11px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; }
.pm-choice:hover { background: var(--dsh-surface, rgba(127,127,127,0.09)); }
.pm-choice.on { border-color: var(--dsh-accent, rgba(90,140,255,0.55)); background: var(--dsh-surface, rgba(127,127,127,0.09)); }
.pm-choice-title { font-size: 12.5px; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.pm-choice-desc { font-size: 11.5px; opacity: 0.66; line-height: 1.45; }
.pm-input { width: 100%; font-size: 12.5px; padding: 7px 9px; border-radius: 7px; border: 1px solid var(--dsh-border, rgba(127,127,127,0.3)); background: transparent; color: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.pm-btn { align-self: flex-start; font-size: 12.5px; padding: 6px 14px; border-radius: 7px; border: 1px solid var(--dsh-border, rgba(127,127,127,0.32)); background: var(--dsh-surface, rgba(127,127,127,0.1)); color: inherit; cursor: pointer; }
.pm-btn:disabled { opacity: 0.45; cursor: default; }
.pm-banner { font-size: 12.5px; padding: 9px 12px; border-radius: 8px; background: var(--dsh-surface, rgba(127,127,127,0.12)); line-height: 1.5; }
.pm-banner.bad { border: 1px solid var(--dsh-danger, rgba(220,90,90,0.5)); }
.pm-field { display: flex; flex-direction: column; gap: 4px; }
.pm-label { font-size: 11.5px; font-weight: 600; opacity: 0.72; }
.pm-btn.small { font-size: 11.5px; padding: 4px 10px; }
.pm-chip.own { background: var(--dsh-accent, rgba(90,140,255,0.18)); font-weight: 600; }
.pm-scope { display: flex; gap: 8px; flex-wrap: wrap; }
.pm-scope-item { flex: 1 1 190px; display: flex; flex-direction: column; gap: 3px; padding: 9px 11px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; }
.pm-scope-item:hover { background: var(--dsh-surface, rgba(127,127,127,0.09)); }
.pm-scope-item.on { border-color: var(--dsh-accent, rgba(90,140,255,0.55)); background: var(--dsh-surface, rgba(127,127,127,0.09)); }
.pm-scope-item.dim { opacity: 0.45; cursor: default; }
.pm-projects { display: flex; flex-direction: column; gap: 4px; max-height: 210px; overflow-y: auto; }
.pm-project { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; }
.pm-project:hover { background: var(--dsh-surface, rgba(127,127,127,0.09)); }
.pm-project.on { border-color: var(--dsh-accent, rgba(90,140,255,0.55)); background: var(--dsh-surface, rgba(127,127,127,0.09)); }
.pm-project-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pm-project-name { font-size: 12.5px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.pm-project-path { font-size: 10.5px; opacity: 0.5; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-project-meta { font-size: 11px; opacity: 0.62; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pm-tag { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: var(--dsh-accent, rgba(90,140,255,0.18)); font-weight: 600; }
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
    function MemoryPanel(props) {
      const t = props.t
      const [state, setState] = useState({ phase: 'loading', data: null, reason: null })
      const [choice, setChoice] = useState(null)
      const [saving, setSaving] = useState(null)
      const [saveReason, setSaveReason] = useState(null)
      // Which project the panel is showing. `null` means "whatever the Host says is
      // current", which is the right default: opening the panel from a session should not
      // make the user pick the project they are already in.
      const [selected, setSelected] = useState(null)
      // Where a save goes. Defaults to `project` when a project is selected, because that
      // is the narrower and more reversible of the two: it cannot silently change every
      // other repository the user has open.
      const [scope, setScope] = useState('project')

      const load = useCallback(async (root) => {
        setState((current) => ({ phase: 'loading', data: current.data, reason: null }))
        const path = root === null || root === undefined ? STATUS_PATH : `${STATUS_PATH}?project=${encodeURIComponent(root)}`
        const result = await getJson(path)
        if (result.ok) setState({ phase: 'ready', data: result.data, reason: null })
        else setState({ phase: 'error', data: null, reason: result.reason })
        return result
      }, [])

      useEffect(() => {
        void load(selected)
      }, [load, selected])

      // The editor mirrors the saved settings until the project or the scope changes, so
      // a refetch after saving does not fight the control the user is using.
      useEffect(() => {
        if (state.phase !== 'ready' || state.data === null) return
        const shown = scope === 'project' ? state.data.settings : state.data.base
        setChoice({
          routerTier: shown.routerTier,
          routerStrategy: shown.routerStrategy,
          routerProvider: shown.routerProvider,
          routerModel: shown.routerModel
        })
      }, [state, scope])

      const save = useCallback(async () => {
        if (choice === null || state.data === null) return
        setSaving(true)
        setSaveReason(null)

        // Comparing against the layer being edited, not against the effective value: in
        // `project` scope a field equal to the profile value is still a change worth
        // saving, and in `global` scope a field that merely shows a project override is not.
        const shown = scope === 'project' ? state.data.settings : state.data.base
        const pending = [
          ['routerTier', choice.routerTier],
          ['routerStrategy', choice.routerStrategy],
          ['routerProvider', choice.routerProvider],
          ['routerModel', choice.routerModel]
        ].filter(([key]) => choice[key] !== shown[key])

        if (pending.length === 0) {
          setSaving(null)
          setSaveReason({ ok: true, text: t('router.saved') })
          return
        }
        const root = state.data.root
        for (const [key, value] of pending) {
          try {
            const response = await fetch(CONFIG_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                key,
                value,
                scope,
                ...(root === null || root === undefined ? {} : { project: root })
              })
            })
            const body = await response.json().catch(() => ({}))
            if (!response.ok) {
              setSaving(null)
              // "This profile cannot save" is not the same problem as "the write was
              // rejected", and it is not fixable by retrying. Saying so is the
              // difference between a user who knows to change their profile and one who
              // presses Save until they give up.
              const text = String(body.error ?? '')
              const reason = text.includes('configEditor') ? t('router.readonly') : text || `HTTP ${response.status}`
              setSaveReason({ ok: false, text: `${t('router.failed')}: ${reason}` })
              return
            }
          } catch (error) {
            setSaving(null)
            setSaveReason({ ok: false, text: `${t('router.failed')}: ${error && error.message ? error.message : String(error)}` })
            return
          }
        }
        setSaving(null)
        setSaveReason({ ok: true, text: t('router.saved') })
        await load(selected)
      }, [choice, state, scope, selected, t, load])

      /**
       * Stop overriding one key for the selected project.
       * @param {string} key - the setting to release back to the profile value.
       */
      const resetOverride = useCallback(
        async (key) => {
          if (state.data === null || state.data.root === null) return
          setSaving(true)
          setSaveReason(null)
          try {
            const response = await fetch(`${CONFIG_PATH}?project=${encodeURIComponent(state.data.root)}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ key, value: null, scope: 'project' })
            })
            const body = await response.json().catch(() => ({}))
            if (!response.ok) {
              setSaving(null)
              setSaveReason({ ok: false, text: `${t('router.failed')}: ${String(body.error ?? `HTTP ${response.status}`)}` })
              return
            }
            setSaving(null)
            setSaveReason({ ok: true, text: t('router.saved') })
            await load(selected)
          } catch (error) {
            setSaving(null)
            setSaveReason({ ok: false, text: `${t('router.failed')}: ${error && error.message ? error.message : String(error)}` })
          }
        },
        [state, selected, t, load]
      )

      // Keep the loading placeholder only on the very first read. Later reads happen while
      // the user is switching project or scope, and blanking the whole panel for them
      // makes it flash and lose their place.
      if (state.phase === 'loading' && state.data === null) {
        return h('div', { className: 'pm-panel' }, h('div', { className: 'pm-muted' }, t('panel.loading')))
      }
      if (state.phase === 'error') {
        return h(
          'div',
          { className: 'pm-panel' },
          h('div', { className: 'pm-banner bad' }, `${t('panel.error')}: ${state.reason}`),
          h('button', { className: 'pm-btn', onClick: () => void load(selected) }, t('panel.retry'))
        )
      }

      const data = state.data
      const atoms = data.atoms
      const compactions = data.compactions
      const settings = data.settings
      const base = data.base ?? data.settings
      const projects = Array.isArray(data.projects) ? data.projects : []
      const overridden = Array.isArray(data.overridden) ? data.overridden : []
      const overridable = Array.isArray(data.overridable) ? data.overridable : []
      const hasProject = data.root !== null && data.root !== undefined
      // A scope the current state cannot honour is not offered: with no project selected
      // there is nothing to override, and showing the option anyway would promise a save
      // that the Host will refuse.
      const canOverride = hasProject && overridable.length > 0
      const activeScope = canOverride ? scope : 'global'

      const projectSection = h(
        'div',
        { className: 'pm-card' },
        h(
          'div',
          { className: 'pm-head' },
          h('div', { className: 'pm-card-title' }, t('project.title')),
          h(
            'button',
            { className: 'pm-btn small', onClick: () => void load(selected) },
            t('panel.retry')
          )
        ),
        h('div', { className: 'pm-hint' }, t('project.select')),
        projects.length === 0
          ? h('div', { className: 'pm-muted' }, t('project.none'))
          : h(
              'div',
              { className: 'pm-projects' },
              projects.map((row) =>
                h(ProjectRow, {
                  key: row.key ?? row.root,
                  row,
                  t,
                  selected: data.root !== null && row.root === data.root,
                  onPick: () => {
                    setSelected(row.root)
                    // Picking a project is a statement about which project you are
                    // configuring, so the panel follows it into project scope rather than
                    // leaving the scope on a layer the user did not mean.
                    setScope('project')
                    setSaveReason(null)
                  }
                })
              )
            ),
        data.root === null || data.root === undefined
          ? h('div', { className: 'pm-banner' }, t('project.unknown'))
          : h('div', { className: 'pm-hint' }, String(data.root))
      )

      const atomSection =
        atoms === null || atoms.readable !== true
          ? h(
              'div',
              { className: 'pm-card' },
              h('div', { className: 'pm-card-title' }, t('atoms.title')),
              h('div', { className: 'pm-muted' }, atoms === null ? '—' : atoms.reason === 'no-project-root' ? t('panel.noRoot') : String(atoms.reason))
            )
          : atoms.live === 0
            ? h('div', { className: 'pm-card' }, h('div', { className: 'pm-card-title' }, t('atoms.title')), h('div', { className: 'pm-muted' }, t('panel.empty')))
            : h(
                'div',
                { className: 'pm-card' },
                h('div', { className: 'pm-card-title' }, t('atoms.title')),
                h(
                  'div',
                  { className: 'pm-row' },
                  h('span', { className: 'pm-muted' }, t('atoms.live')),
                  h('span', { className: 'pm-num' }, String(atoms.live))
                ),
                atoms.forgotten > 0
                  ? h('div', { className: 'pm-row' }, h('span', { className: 'pm-muted' }, t('atoms.forgotten')), h('span', { className: 'pm-num' }, String(atoms.forgotten)))
                  : null,
                atoms.invalid > 0
                  ? h(
                      'div',
                      { className: 'pm-banner bad' },
                      fill(t('atoms.invalid'), { count: atoms.invalid })
                    )
                  : null,
                h(
                  'div',
                  { className: 'pm-row' },
                  h('span', { className: 'pm-muted' }, t('atoms.standing')),
                  h('span', { className: 'pm-num' }, String(atoms.standing))
                ),
                h('div', { className: 'pm-hint' }, t('atoms.standing.hint')),
                h('div', { className: 'pm-muted' }, t('atoms.byKind')),
                h(
                  'div',
                  { className: 'pm-chips' },
                  Object.entries(atoms.byKind)
                    .sort((left, right) => right[1] - left[1])
                    .map(([kind, count]) => h('span', { className: 'pm-chip', key: kind }, `${kind} ${count}`))
                ),
                // Weight is importance, and it is deliberately shown next to standing so
                // the two are never confused: a weight-2 atom can be a hard rule, and a
                // weight-5 atom can be a note.
                h('div', { className: 'pm-muted' }, t('atoms.byWeight')),
                h(
                  'div',
                  { className: 'pm-chips' },
                  Object.entries(atoms.byWeight)
                    .sort((left, right) => Number(left[0]) - Number(right[0]))
                    .map(([weight, count]) => h('span', { className: 'pm-chip', key: weight }, `${weight} \u00b7 ${count}`))
                )
              )

      const compactionSection = h(
        'div',
        { className: 'pm-card' },
        h('div', { className: 'pm-card-title' }, t('compactions.title')),
        compactions.readable !== true
          ? h('div', { className: 'pm-muted' }, String(compactions.reason))
          : compactions.total === 0
            ? h('div', { className: 'pm-muted' }, t('compactions.none'))
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                h('div', { className: 'pm-muted' }, fill(t('compactions.line'), compactions)),
                Object.keys(compactions.byReason).length > 0
                  ? h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                      h('div', { className: 'pm-hint' }, t('compactions.reasons')),
                      h(
                        'div',
                        { className: 'pm-chips' },
                        Object.entries(compactions.byReason).map(([reason, count]) =>
                          h('span', { className: 'pm-chip', key: reason }, `${reason} ${count}`)
                        )
                      )
                    )
                  : null,
                compactions.lastAt === null
                  ? null
                  : h('div', { className: 'pm-hint' }, `${t('compactions.last')}: ${compactions.lastAt}`)
              )
      )

      const tierChoices = data.choices.routerTier.map((tier) => {
        const desc = TIER_TEXT[tier]
        const on = choice !== null && choice.routerTier === tier
        return h(
          'div',
          {
            key: tier,
            className: on ? 'pm-choice on' : 'pm-choice',
            role: 'button',
            tabIndex: 0,
            onClick: () => setChoice((current) => ({ ...(current ?? {}), routerTier: tier })),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') setChoice((current) => ({ ...(current ?? {}), routerTier: tier }))
            }
          },
          h('div', { className: 'pm-choice-title' }, desc ? desc.title : tier),
          desc ? h('div', { className: 'pm-choice-desc' }, desc.desc) : null
        )
      })

      const strategyChoices = data.choices.routerStrategy.map((strategy) => {
        const desc = STRATEGY_TEXT[strategy]
        const on = choice !== null && choice.routerStrategy === strategy
        return h(
          'div',
          {
            key: strategy,
            className: on ? 'pm-choice on' : 'pm-choice',
            role: 'button',
            tabIndex: 0,
            onClick: () => setChoice((current) => ({ ...(current ?? {}), routerStrategy: strategy })),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') setChoice((current) => ({ ...(current ?? {}), routerStrategy: strategy }))
            }
          },
          h('div', { className: 'pm-choice-title' }, desc ? desc.title : strategy),
          desc ? h('div', { className: 'pm-choice-desc' }, desc.desc) : null
        )
      })

      const configured = String(settings.routerProvider) !== '' && String(settings.routerModel) !== ''

      // Which of the four router keys this project currently owns. Shown next to the field
      // so a user can tell "this is what I set here" from "this is what I inherited",
      // which is otherwise invisible and makes a stale override very confusing.
      const isOwn = (key) => overridden.includes(key)

      // One scope tab. Clicking an unavailable scope is ignored rather than disabled in
      // markup only, so a keyboard user gets the same behaviour as a mouse user.
      const scopeTab = (value, label, hint) => {
        const on = activeScope === value
        const usable = value === 'global' || canOverride
        return h(
          'div',
          {
            key: value,
            className: on ? 'pm-scope-item on' : usable ? 'pm-scope-item' : 'pm-scope-item dim',
            role: 'button',
            tabIndex: usable ? 0 : -1,
            'aria-disabled': usable ? undefined : 'true',
            onClick: () => {
              if (usable !== true) return
              setScope(value)
              setSaveReason(null)
            },
            onKeyDown: (event) => {
              if (usable !== true) return
              if (event.key === 'Enter' || event.key === ' ') {
                setScope(value)
                setSaveReason(null)
              }
            }
          },
          h('div', { className: 'pm-choice-title' }, label),
          h('div', { className: 'pm-choice-desc' }, hint)
        )
      }

      const scopeSection = h(
        'div',
        { className: 'pm-card' },
        h('div', { className: 'pm-card-title' }, t('scope.title')),
        h(
          'div',
          { className: 'pm-scope' },
          scopeTab('global', t('scope.global'), t('scope.global.hint')),
          scopeTab(
            'project',
            t('scope.project'),
            canOverride ? t('scope.project.hint') : t('scope.project.unavailable')
          )
        ),
        overridden.length === 0
          ? null
          : h(
              'div',
              { className: 'pm-row' },
              h('div', { className: 'pm-hint' }, t('scope.overridden')),
              h(
                'div',
                { className: 'pm-chips' },
                overridden.map((key) =>
                  h('span', { className: 'pm-chip own', key }, String(key))
                )
              )
            ),
        overridden.length === 0
          ? null
          : h(
              'div',
              { className: 'pm-row' },
              h('div', { className: 'pm-hint' }, t('scope.inherit')),
              h(
                'button',
                {
                  className: 'pm-btn small',
                  disabled: saving !== null,
                  onClick: () => void resetOverride(overridden[0])
                },
                `${t('scope.reset')}: ${overridden[0]}`
              )
            )
      )

      const routerSection = h(
        'div',
        { className: 'pm-card' },
        h('div', { className: 'pm-card-title' }, t('router.title')),
        // Which layer these four controls edit, restated where the editing happens: the
        // scope card can be scrolled out of view, and saving into the wrong layer is the
        // one mistake this panel can make that has consequences outside the panel.
        h(
          'div',
          { className: 'pm-hint' },
          activeScope === 'project' ? t('scope.project.hint') : t('scope.global.hint')
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h(
            'div',
            { className: 'pm-row' },
            h('div', { className: 'pm-label' }, t('router.tier')),
            isOwn('routerTier') ? h('span', { className: 'pm-chip own' }, t('router.overrideOn')) : null
          ),
          tierChoices
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h(
            'div',
            { className: 'pm-row' },
            h('div', { className: 'pm-label' }, t('router.strategy')),
            isOwn('routerStrategy') ? h('span', { className: 'pm-chip own' }, t('router.overrideOn')) : null
          ),
          h('div', { className: 'pm-hint' }, t('router.strategy.hint')),
          strategyChoices
        ),
        h(
          'div',
          { className: 'pm-field' },
          h(
            'div',
            { className: 'pm-row' },
            h('div', { className: 'pm-label' }, t('router.provider')),
            isOwn('routerProvider') ? h('span', { className: 'pm-chip own' }, t('router.overrideOn')) : null
          ),
          h('input', {
            className: 'pm-input',
            value: choice === null ? '' : choice.routerProvider,
            placeholder: 'deepseek',
            onChange: (event) => setChoice((current) => ({ ...(current ?? {}), routerProvider: event.target.value }))
          }),
          // In project scope an empty field means "inherit", which is a real choice rather
          // than an unfinished edit; naming the inherited value makes that legible.
          activeScope === 'project' && String(base.routerProvider) !== ''
            ? h('div', { className: 'pm-hint' }, fill(t('router.empty'), { value: base.routerProvider }))
            : null
        ),
        h(
          'div',
          { className: 'pm-field' },
          h(
            'div',
            { className: 'pm-row' },
            h('div', { className: 'pm-label' }, t('router.model')),
            isOwn('routerModel') ? h('span', { className: 'pm-chip own' }, t('router.overrideOn')) : null
          ),
          h('input', {
            className: 'pm-input',
            value: choice === null ? '' : choice.routerModel,
            placeholder: 'deepseek-chat',
            onChange: (event) => setChoice((current) => ({ ...(current ?? {}), routerModel: event.target.value }))
          }),
          activeScope === 'project' && String(base.routerModel) !== ''
            ? h('div', { className: 'pm-hint' }, fill(t('router.empty'), { value: base.routerModel }))
            : null
        ),
        h('div', { className: 'pm-hint' }, t('router.provider.hint')),
        configured
          ? null
          : h('div', { className: 'pm-banner' }, t('router.notConfigured')),
        h(
          'button',
          { className: 'pm-btn', disabled: saving !== null, onClick: () => void save() },
          saving === null ? t('router.save') : t('router.saving')
        ),
        saveReason === null
          ? null
          : h('div', { className: saveReason.ok ? 'pm-banner' : 'pm-banner bad' }, saveReason.text)
      )

      const recallSection = h(
        'div',
        { className: 'pm-card' },
        h(
          'div',
          { className: 'pm-row' },
          h('div', { className: 'pm-card-title' }, t('recall.title')),
          isOwn('recallBudget') || isOwn('recallLimit')
            ? h('span', { className: 'pm-chip own' }, t('router.overrideOn'))
            : null
        ),
        h('div', { className: 'pm-muted' }, fill(t('recall.line'), { budget: settings.recallBudget, limit: settings.recallLimit })),
        // Only say there is a different global value when one actually exists, otherwise
        // this line repeats the one above it.
        settings.recallBudget === base.recallBudget && settings.recallLimit === base.recallLimit
          ? null
          : h('div', { className: 'pm-hint' }, fill(t('recall.line'), { budget: base.recallBudget, limit: base.recallLimit }))
      )

      return h(
        'div',
        { className: 'pm-panel' },
        h(
          'div',
          { className: 'pm-head' },
          h('div', { className: 'pm-title' }, t('panel.title')),
          saving === null
            ? null
            : h('div', { className: 'pm-hint' }, t('router.saving'))
        ),
        projectSection,
        atomSection,
        compactionSection,
        scopeSection,
        routerSection,
        recallSection
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
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }) }, MemoryPanel)
      )
    }

    return { inject: ['slots', 'locale'], apply, CSS }
  }
})
