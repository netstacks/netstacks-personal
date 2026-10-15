/**
 * Clipboard history palette (docs/clipboard-history-plan.md §3.6).
 *
 * Filter recent clips by text, device, session or source; Enter pastes into
 * the active terminal, Ctrl+Enter re-copies to the OS clipboard. Rows show
 * provenance, size, line-ending and redaction badges. App mounts this only
 * while open, so state starts fresh on every open.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useClipStore } from '../../stores/clipStore'
import { copyWithoutHistory } from '../../lib/clipboard'
import { formatClipSize } from '../../lib/clipText'
import { formatRelativeTime } from '../../lib/enrichmentHelpers'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'
import { useMovableRect } from '../../hooks/useMovableRect'
import { showToast } from '../Toast'
import type { Clip } from '../../types/clip'
import { SOURCE_LABEL, indexClip, matchesQuery, type IndexedClip } from './clipHistoryHelpers'
import './ClipHistoryPalette.css'
import './movablePopup.css'
import Tooltip from '../Tooltip'

interface ClipHistoryPaletteProps {
  onClose: () => void
  /** False when the active tab is not a live terminal; Enter then copies instead. */
  canPaste: boolean
  /** Paste the clip into the active terminal (App applies the flavor preset). */
  onPaste: (clip: Clip) => void
  /** Open the paste preview for this clip (only offered when a terminal is active). */
  onPreview: (clip: Clip) => void
}

interface RowProps {
  item: IndexedClip
  index: number
  selected: boolean
  canPaste: boolean
  onSelect: (index: number) => void
  onPaste: (clip: Clip) => void
  onPreview: (clip: Clip) => void
  onCopy: (clip: Clip) => void
  onPin: (clip: Clip) => void
  onRemove: (clip: Clip) => void
}

/** One history row. Memoised so dragging/resizing the popup does not re-render the list. */
const ClipRow = memo(function ClipRow({ item, index, selected, canPaste, onSelect, onPaste, onPreview, onCopy, onPin, onRemove }: RowProps) {
  const { clip } = item
  const p = clip.provenance
  const where = [p.sessionName || p.deviceHost, p.cliFlavor && p.cliFlavor !== 'auto' ? p.cliFlavor : null]
    .filter(Boolean)
    .join(' · ')
  const badLineEnding = clip.lineEnding === 'crlf' || clip.lineEnding === 'cr' || clip.lineEnding === 'mixed'
  return (
    <div
      data-index={index}
      className={`command-palette-item clip-history-row${selected ? ' selected' : ''}`}
      onMouseEnter={() => onSelect(index)}
      onClick={() => onPaste(clip)}
      title={clip.text.length > 400 ? `${clip.text.slice(0, 400)}…` : clip.text}
    >
      <div className="clip-history-main">
        <div className="clip-history-line">
          {clip.pinned && <Tooltip label="Pinned"><span className="clip-badge clip-badge-pin">★</span></Tooltip>}
          {clip.redacted && <Tooltip label="A credential was scrubbed from this clip"><span className="clip-badge clip-badge-redacted">🔒</span></Tooltip>}
          <span className="clip-history-text">{item.title || '(whitespace)'}</span>
        </div>
        <div className="clip-history-meta">
          <span className="clip-badge">{SOURCE_LABEL[p.source]}</span>
          {where && <span className="clip-history-where">{where}</span>}
          <span>{formatClipSize(clip.bytes, clip.lines)}</span>
          {badLineEnding && (
            <Tooltip label="Line endings that often paste wrong into device CLIs"><span className="clip-badge clip-badge-warn">
              {clip.lineEnding.toUpperCase()}
            </span></Tooltip>
          )}
          <span>{formatRelativeTime(new Date(clip.createdAt))}</span>
        </div>
      </div>
      <div className="clip-history-actions" onClick={(e) => e.stopPropagation()}>
        <Tooltip label={clip.pinned ? 'Unpin' : 'Pin (survives expiry)'}><button aria-label={clip.pinned ? 'Unpin' : 'Pin'} aria-pressed={clip.pinned} type="button" className="ns-btn ns-btn--ghost ns-icon-btn ns-btn--small" onClick={() => onPin(clip)}>
          {clip.pinned ? '★' : '☆'}
        </button></Tooltip>
        {canPaste && (
          <Tooltip label="Preview the paste (shows what the preset changes)"><button aria-label="Preview the paste (shows what the preset changes)" type="button" className="ns-btn ns-btn--ghost ns-icon-btn ns-btn--small" onClick={() => onPreview(clip)}>👁</button></Tooltip>
        )}
        <Tooltip label="Copy to clipboard"><button aria-label="Copy to clipboard" type="button" className="ns-btn ns-btn--ghost ns-icon-btn ns-btn--small" onClick={() => onCopy(clip)}>⧉</button></Tooltip>
        <Tooltip label="Delete from history"><button aria-label="Delete from history" type="button" className="ns-btn ns-btn--ghost ns-btn--danger ns-icon-btn ns-btn--small" onClick={() => onRemove(clip)}>✕</button></Tooltip>
      </div>
    </div>
  )
})

export default function ClipHistoryPalette({ onClose, canPaste, onPaste, onPreview }: ClipHistoryPaletteProps) {
  const clips = useClipStore((s) => s.clips)
  const loaded = useClipStore((s) => s.loaded)
  const refresh = useClipStore((s) => s.refresh)
  const setPinned = useClipStore((s) => s.setPinned)
  const remove = useClipStore((s) => s.remove)
  const clearUnpinned = useClipStore((s) => s.clearUnpinned)

  const [query, setQuery] = useState('')
  const [pinnedOnly, setPinnedOnly] = useState(false)
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const { backdropProps, contentProps } = useOverlayDismiss({ onDismiss: onClose })
  const { style, onHeaderMouseDown, onResizeMouseDown } = useMovableRect({
    initial: (vw, vh) => ({ w: Math.min(760, vw - 32), h: Math.min(560, Math.round(vh * 0.7)), x: Math.max(8, Math.round((vw - Math.min(760, vw - 32)) / 2)), y: Math.round(vh * 0.12) }),
    minWidth: 420,
    minHeight: 240,
    storageKey: 'netstacks:clip-history:rect',
  })

  useEffect(() => {
    if (!loaded) void refresh()
  }, [loaded, refresh])

  const indexed = useMemo(() => clips.map(indexClip), [clips])
  const rows = useMemo(
    () => indexed.filter((ix) => (!pinnedOnly || ix.clip.pinned) && matchesQuery(ix.haystack, query)),
    [indexed, pinnedOnly, query],
  )

  // Clamp instead of resetting state when the filter shrinks the list.
  const selectedIndex = Math.min(selected, Math.max(0, rows.length - 1))

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const current = rows[selectedIndex]?.clip

  const doCopy = async (clip: Clip) => {
    if (await copyWithoutHistory(clip.text)) {
      showToast('Copied to clipboard', 'success', 1500)
      onClose()
    } else {
      showToast('Could not write to the clipboard', 'error')
    }
  }

  const doPaste = (clip: Clip) => {
    if (!canPaste) {
      void doCopy(clip)
      return
    }
    onPaste(clip)
    onClose()
  }

  const doPreview = (clip: Clip) => {
    onPreview(clip)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected(Math.min(rows.length - 1, selectedIndex + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected(Math.max(0, selectedIndex - 1))
    } else if (e.key === 'Enter' && current) {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) void doCopy(current)
      else doPaste(current)
    } else if (e.key === 'Delete' && current && query === '') {
      e.preventDefault()
      void remove(current.id)
    }
  }

  return (
    <div className="command-palette-overlay" {...backdropProps}>
      <div className="clip-history movable-popup" role="dialog" aria-label="Clipboard history" style={style} {...contentProps}>
        <Tooltip label="Drag to move"><div className="movable-popup-titlebar" onMouseDown={onHeaderMouseDown}>
          <span className="movable-popup-title">Clipboard History</span>
          <button type="button" className="ns-btn ns-btn--ghost ns-icon-btn movable-popup-close" onClick={onClose} aria-label="Close">✕</button>
        </div></Tooltip>
        <div className="command-palette-input-wrapper clip-history-head">
          <input data-ai-fill="off"
            autoFocus
            className="command-palette-input"
            placeholder="Search clipboard history — text, device, session, source…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(0) }}
            onKeyDown={onKeyDown}
          />
          <Tooltip label="Show pinned clips only"><button
            type="button"
            className={`ns-btn ns-btn--ghost ns-btn--small clip-history-filter${pinnedOnly ? ' active' : ''}`}
            onClick={() => setPinnedOnly((v) => !v)}
          >
            ★ Pinned
          </button></Tooltip>
        </div>

        <div className="command-palette-list clip-history-list" ref={listRef}>
          {rows.length === 0 && (
            <div className="command-palette-empty">
              {clips.length === 0
                ? 'No clips yet. Anything you copy inside NetStacks shows up here.'
                : 'No clips match.'}
            </div>
          )}
          {rows.map((item, i) => (
            <ClipRow
              key={item.clip.id}
              item={item}
              index={i}
              selected={i === selectedIndex}
              canPaste={canPaste}
              onSelect={setSelected}
              onPaste={doPaste}
              onPreview={doPreview}
              onCopy={(clip) => void doCopy(clip)}
              onPin={(clip) => void setPinned(clip.id, !clip.pinned)}
              onRemove={(clip) => void remove(clip.id)}
            />
          ))}
        </div>

        <div className="clip-history-foot">
          <span>
            <kbd>↵</kbd> {canPaste ? 'paste into terminal' : 'copy'} · <kbd>Ctrl+↵</kbd> copy · <kbd>Del</kbd> remove
          </span>
          <Tooltip label="Delete every unpinned clip"><button
            type="button"
            className="ns-btn ns-btn--small"
            disabled={!clips.some((c) => !c.pinned)}
            onClick={() => void clearUnpinned()}
          >
            Clear unpinned
          </button></Tooltip>
        </div>
        <Tooltip label="Drag to resize"><div className="movable-popup-resize" onMouseDown={onResizeMouseDown} /></Tooltip>
      </div>
    </div>
  )
}
