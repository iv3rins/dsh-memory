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
      'recall.line': '每次最多 {budget} tokens、{limit} 条'
    }

    const en = {
      'panel.title': 'Project memory',
      'panel.open': 'Open project memory',
      'panel.loading': 'Reading…',
      'panel.retry': 'Read again',
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
      'recall.line': 'At most {budget} tokens and {limit} atoms per step'
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
`

    // -------------------------------------------------------------------- panel

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

      const load = useCallback(async () => {
        setState({ phase: 'loading', data: null, reason: null })
        const result = await getJson(STATUS_PATH)
        if (result.ok) setState({ phase: 'ready', data: result.data, reason: null })
        else setState({ phase: 'error', data: null, reason: result.reason })
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      // The editor mirrors the saved settings until the user touches it, so a
      // refetch after saving does not fight the control the user is using.
      useEffect(() => {
        if (state.phase !== 'ready' || state.data === null) return
        const settings = state.data.settings
        setChoice((current) =>
          current ?? {
            routerTier: settings.routerTier,
            routerStrategy: settings.routerStrategy,
            routerProvider: settings.routerProvider,
            routerModel: settings.routerModel
          }
        )
      }, [state])

      const save = useCallback(async () => {
        if (choice === null) return
        setSaving(true)
        setSaveReason(null)
        // Each changed key is its own request: a partial failure must not look like a
        // total success, and each write is applied by the Loader independently.
        const pending = [
          ['routerTier', choice.routerTier],
          ['routerStrategy', choice.routerStrategy],
          ['routerProvider', choice.routerProvider],
          ['routerModel', choice.routerModel]
        ].filter(([key]) => state.data !== null && choice[key] !== state.data.settings[key])

        if (pending.length === 0) {
          setSaving(null)
          setSaveReason({ ok: true, text: t('router.saved') })
          return
        }
        for (const [key, value] of pending) {
          try {
            const response = await fetch(CONFIG_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ key, value })
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
        await load()
      }, [choice, state, t, load])

      if (state.phase === 'loading') {
        return h('div', { className: 'pm-panel' }, h('div', { className: 'pm-muted' }, t('panel.loading')))
      }
      if (state.phase === 'error') {
        return h(
          'div',
          { className: 'pm-panel' },
          h('div', { className: 'pm-banner bad' }, `${t('panel.error')}: ${state.reason}`),
          h('button', { className: 'pm-btn', onClick: () => void load() }, t('panel.retry'))
        )
      }

      const data = state.data
      const atoms = data.atoms
      const compactions = data.compactions
      const settings = data.settings

      const atomSection =
        atoms === null || atoms.readable !== true
          ? h('div', { className: 'pm-card' }, h('div', { className: 'pm-card-title' }, t('atoms.title')), h('div', { className: 'pm-muted' }, atoms === null ? '—' : atoms.reason))
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

      const routerSection = h(
        'div',
        { className: 'pm-card' },
        h('div', { className: 'pm-card-title' }, t('router.title')),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', { className: 'pm-label' }, t('router.tier')),
          tierChoices
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', { className: 'pm-label' }, t('router.strategy')),
          h('div', { className: 'pm-hint' }, t('router.strategy.hint')),
          strategyChoices
        ),
        h(
          'div',
          { className: 'pm-field' },
          h('div', { className: 'pm-label' }, t('router.provider')),
          h('input', {
            className: 'pm-input',
            value: choice === null ? '' : choice.routerProvider,
            placeholder: 'deepseek',
            onChange: (event) => setChoice((current) => ({ ...(current ?? {}), routerProvider: event.target.value }))
          })
        ),
        h(
          'div',
          { className: 'pm-field' },
          h('div', { className: 'pm-label' }, t('router.model')),
          h('input', {
            className: 'pm-input',
            value: choice === null ? '' : choice.routerModel,
            placeholder: 'deepseek-chat',
            onChange: (event) => setChoice((current) => ({ ...(current ?? {}), routerModel: event.target.value }))
          })
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
        h('div', { className: 'pm-card-title' }, t('recall.title')),
        h('div', { className: 'pm-muted' }, fill(t('recall.line'), { budget: settings.recallBudget, limit: settings.recallLimit }))
      )

      return h(
        'div',
        { className: 'pm-panel' },
        h(
          'div',
          { className: 'pm-head' },
          h('div', { className: 'pm-title' }, t('panel.title')),
          h('button', { className: 'pm-btn', onClick: () => void load() }, t('panel.retry'))
        ),
        h('div', { className: 'pm-sub' }, String(data.root)),
        atomSection,
        compactionSection,
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
