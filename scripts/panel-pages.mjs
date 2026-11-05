
// ------------------------------------------------------------------- pages

/** Overview: the six numbers the tab exists to answer. */
function OverviewPage(props) {
  const { data, t, now } = props
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
      h('div', { className: 'pm-card-title' }, fill(t('compactions.total'), { total: data.compactions.total, atoms: data.compactions.atoms })),
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
                h(Field, { label: t('trace.candidates'), mono: true }, key),
                h(Field, { label: t('compactions.row.added'), }, `${row.added} added · ${row.updated} updated · ${row.unchanged} unchanged`),
                h(Field, { label: t('compactions.row.timeNoTurn'), }, fill(t('compactions.row.timeNoTurn'), { when: fmtTime(row.at, t), chars: row.summaryChars })),
                h(Field, { label: t('detail.counts') }, `${row.statementsSkipped} skipped`),
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
  const recent = data.compactions?.recent ?? []
  const notCollected = h('span', { className: 'pm-muted' }, t('trace.notCollected'))

  // The backend records aggregate counters, not per-run traces. Saying so is the honest
  // rendering: inventing a plausible task intent for each row would be fabrication.
  return h(
    'div',
    { className: 'pm-page enter' },
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
      h('div', { className: 'pm-hint' }, `${recent.length} ${t('tab.compactions')}`),
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
      h(Field, { label: t('router.model') }, h('input', { className: 'pm-input', value: choice?.routerModel ?? '', onChange: (event) => setChoice({ ...choice, routerModel: event.target.value }), placeholder: base.routerModel || '' })),
      h('div', { className: 'pm-hint' }, t('scope.hint.global')),
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
      h('div', { className: 'pm-hint' }, t('capacity.coldHint')),
    ),
  )
}
