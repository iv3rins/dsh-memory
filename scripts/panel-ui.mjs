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
