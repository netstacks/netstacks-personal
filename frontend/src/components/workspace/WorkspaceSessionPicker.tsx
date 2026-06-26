import { useEffect, useMemo, useRef, useState } from 'react'
import { listSessions, type Session } from '../../api/sessions'
import { getErrorMessage } from '../../api/errors'
import './WorkspaceSessionPicker.css'

interface WorkspaceSessionPickerProps {
  /**
   * Parent must conditionally mount the picker (`{open && <Picker .../>}`),
   * or change the React `key` between opens, so each open starts with a
   * fresh state slot. We deliberately do not gate render on an `open`
   * prop here — that pattern requires reset useEffects that trigger the
   * `react-hooks/set-state-in-effect` ESLint rule.
   */
  onClose: () => void
  onPick: (session: Session) => void
}

/**
 * Modal session picker for the workspace sub-panel.
 *
 * Reuses the existing listSessions() API so inventory matches the
 * side-panel session list exactly — no separate fetch path, no risk
 * of drift. Filter is client-side (the agent already returns the full
 * list and the typical user has <500 saved sessions, so this stays
 * snappy without a server-side search endpoint).
 *
 * Distinct from SessionPanel (the sidebar tree) because it's:
 *   - modal, dismissible by Escape
 *   - flat list (no groups) so keyboard arrows always advance
 *   - returns a Session via onPick rather than firing a global event
 *
 * Render the picker via the standard React pattern: parent controls
 * the open state; the modal portals nothing — it sits in the DOM
 * tree of the workspace tab so backdrop clicks scope to that tab.
 */
export default function WorkspaceSessionPicker({
  onClose,
  onPick,
}: WorkspaceSessionPickerProps) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // activeIdx is the user's selection intent; the actually-rendered
  // selection is derived (safeIdx below) so the index can't slide out
  // of bounds when the filtered list shrinks under it.
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Load sessions once on mount. The parent re-mounts the picker per
  // open (via conditional render or key change), so this effect fires
  // exactly when we want a fresh fetch — no `open` dep needed.
  useEffect(() => {
    let cancelled = false
    listSessions()
      .then((s) => {
        if (cancelled) return
        setSessions(s)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(getErrorMessage(err, 'Failed to load sessions'))
        setLoading(false)
      })
    // Focus the search input on mount.
    requestAnimationFrame(() => inputRef.current?.focus())
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      s.host.toLowerCase().includes(q)
    )
  }, [sessions, query])

  // Derived in-bounds index. The user's activeIdx can drift past the
  // filtered length when they type a more selective query, but rather
  // than writing it back via setState in an effect (lint violation +
  // extra render), we just clamp at the read site. -1 means "nothing
  // is highlightable", which is the correct semantic for an empty list.
  const safeIdx = filtered.length === 0 ? -1 : Math.min(activeIdx, filtered.length - 1)

  // Scroll the highlighted row into view as the user arrow-keys through
  // a long list — without this the highlight slides off-screen and
  // the user has no idea what Enter will pick. No setState here, so
  // this effect is fine under set-state-in-effect.
  useEffect(() => {
    if (!listRef.current) return
    const row = listRef.current.querySelector(`[data-idx="${safeIdx}"]`) as HTMLElement | null
    row?.scrollIntoView({ block: 'nearest' })
  }, [safeIdx])

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(() => Math.min(filtered.length - 1, safeIdx + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(() => Math.max(0, safeIdx - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const s = filtered[safeIdx]
      if (s) onPick(s)
    }
  }

  return (
    <div
      className="wsp-picker-backdrop"
      onClick={onClose}
      onKeyDown={handleKey}
      role="presentation"
    >
      <div
        className="wsp-picker"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Open session in panel"
      >
        <div className="wsp-picker-header">
          <input
            ref={inputRef}
            type="text"
            className="wsp-picker-input"
            placeholder="Search sessions by name or host…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
          />
          <button
            type="button"
            className="wsp-picker-close"
            onClick={onClose}
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
        <div className="wsp-picker-list" ref={listRef}>
          {loading && <div className="wsp-picker-empty">Loading…</div>}
          {error && <div className="wsp-picker-error">{error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div className="wsp-picker-empty">
              {query ? 'No sessions match.' : 'No saved sessions.'}
            </div>
          )}
          {!loading &&
            !error &&
            filtered.map((s, i) => (
              <button
                key={s.id}
                type="button"
                data-idx={i}
                className={`wsp-picker-row ${i === safeIdx ? 'active' : ''}`}
                onClick={() => onPick(s)}
                onMouseEnter={() => setActiveIdx(i)}
              >
                {/* Per-session color stripe to match top-level SSH tabs */}
                <span
                  className="wsp-picker-color"
                  style={{ background: s.color || 'transparent' }}
                  aria-hidden="true"
                />
                <span className="wsp-picker-proto" aria-label={s.protocol || 'ssh'}>
                  {s.protocol === 'telnet' ? '📡' : '🔗'}
                </span>
                <span className="wsp-picker-name">{s.name}</span>
                <span className="wsp-picker-host">{s.host}:{s.port}</span>
              </button>
            ))}
        </div>
        <div className="wsp-picker-footer">
          <span>↑↓ navigate · Enter to open · Esc to cancel</span>
        </div>
      </div>
    </div>
  )
}
