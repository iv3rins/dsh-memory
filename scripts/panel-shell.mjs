
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
      h('div', { className: 'pm-title' }, t('nav.crumbRoot')),
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
  } else if (data !== null) {
    if (tab === 'overview') body = h(OverviewPage, { data, t, now })
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
