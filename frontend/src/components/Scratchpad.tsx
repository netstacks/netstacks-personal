/**
 * Scratchpad — a transient Monaco editor for jotting quick notes.
 *
 * Lifecycle is in-memory only: closing without saving discards the
 * buffer. Save target depends on context:
 *   - Active workspace tab  → <rootPath>/.netstacks/notes/<ts>.txt
 *   - No active workspace   → docs API, 'notes' category
 *
 * The parent owns open/minimized/maximized; the buffer is owned here so a
 * keystroke re-renders only this panel, not the whole app. The component
 * stays mounted while minimized (it renders nothing), so the buffer
 * survives hide-and-restore; the parent unmounts it on close or when the
 * buffer is handed to an in-app tab via `onPopToTab(content)`.
 */

import { useEffect, useState, useCallback } from 'react'
import { useMovableRect, type Rect } from '../hooks/useMovableRect'
import ScratchpadEditor, { saveScratchpadContent, scratchpadTarget } from './ScratchpadEditor'
import type { WorkspaceConfig } from '../types/workspace'
import './Scratchpad.css'
import { useBinding } from '../hooks/useKeyboard'
import Tooltip from './Tooltip'

interface ScratchpadProps {
  minimized: boolean
  maximized: boolean
  onMinimize: () => void
  onToggleMaximize: () => void
  /** Move the buffer into a new tab; the parent unmounts this panel. */
  onPopToTab: (content: string) => void
  onClose: () => void
  /** Active workspace, if any. Determines save destination. */
  activeWorkspace: WorkspaceConfig | null
}

const DEFAULT_WIDTH = 720
const DEFAULT_HEIGHT = 560
const MIN_WIDTH = 360
const MIN_HEIGHT = 240

function defaultRect(vw: number, vh: number): Rect {
  const w = Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, vw - 80))
  const h = Math.min(DEFAULT_HEIGHT, Math.max(MIN_HEIGHT, vh - 120))
  return {
    x: Math.max(8, Math.round((vw - w) / 2)),
    y: Math.max(8, Math.round(vh * 0.08)),
    w,
    h,
  }
}

export default function Scratchpad(props: ScratchpadProps) {
  const saveBinding = useBinding('saveDocument')
  const {
    minimized, maximized, onMinimize, onToggleMaximize, onPopToTab, onClose, activeWorkspace,
  } = props

  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  // Position/size: shared movable-rect mechanics (drag header, corner resize,
  // viewport clamp, persisted per gesture). Gestures are ignored while
  // maximized; the floating rect is kept, so restoring simply shows it again.
  const { rect, onHeaderMouseDown, onResizeMouseDown } = useMovableRect({
    initial: defaultRect,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    storageKey: 'netstacks:scratchpad:rect',
    disabled: maximized,
  })

  // Close on Esc when the panel is visible.
  useEffect(() => {
    if (minimized) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [minimized, onClose])

  // Double-click the header → minimize.
  const onHeaderDoubleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('button')) return
    onMinimize()
  }, [onMinimize])

  if (minimized) return null

  const target = scratchpadTarget(activeWorkspace)

  const handleSaveClick = async () => {
    if (saving) return
    setSaving(true)
    try {
      await saveScratchpadContent(content, activeWorkspace)
      onClose()
    } catch { /* toast already shown by helper */ }
    finally { setSaving(false) }
  }

  const panelStyle: React.CSSProperties = maximized
    ? { left: 0, top: 0, width: '100vw', height: '100vh', borderRadius: 0 }
    : { left: rect.x, top: rect.y, width: rect.w, height: rect.h }

  return (
    <div
      className={`scratchpad-panel${maximized ? ' maximized' : ''}`}
      role="dialog"
      aria-label="Scratchpad"
      style={panelStyle}
    >
      <Tooltip label={maximized ? 'Double-click to minimize' : 'Drag to move · double-click to minimize'}><div
        className="scratchpad-header"
        onMouseDown={onHeaderMouseDown}
        onDoubleClick={onHeaderDoubleClick}
      >
        <div className="scratchpad-title">
          <span>Scratchpad</span>
          <Tooltip label="Save destination"><span className="scratchpad-target">→ {target}</span></Tooltip>
        </div>
        <div className="scratchpad-actions">
          <Tooltip label="Save" shortcut={saveBinding}><button
            className="ns-btn ns-btn--small ns-btn--primary"
            onClick={() => { void handleSaveClick() }}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button></Tooltip>
          <Tooltip label="Open in a new tab"><button
            className="ns-btn ns-btn--small"
            onClick={() => onPopToTab(content)}
          >
            Pop to Tab
          </button></Tooltip>
          <Tooltip label={maximized ? 'Restore' : 'Maximize'}><button
            className="ns-btn ns-btn--small"
            onClick={onToggleMaximize}
            aria-label={maximized ? 'Restore' : 'Maximize'}
          >
            {maximized ? '❐' : '▢'}
          </button></Tooltip>
          <Tooltip label="Minimize to status bar"><button aria-label="Minimize to status bar"
            className="ns-btn ns-btn--small"
            onClick={onMinimize}
          >
            —
          </button></Tooltip>
          <Tooltip label="Close (Esc) — discards unsaved content"><button aria-label="Close (Esc) — discards unsaved content"
            className="ns-btn ns-btn--small"
            onClick={onClose}
          >
            ✕
          </button></Tooltip>
        </div>
      </div></Tooltip>
      <div className="scratchpad-body">
        <ScratchpadEditor
          initialValue={content}
          onChange={setContent}
          activeWorkspace={activeWorkspace}
          onSaved={onClose}
        />
      </div>
      {!maximized && (
        <Tooltip label="Drag to resize"><div
          className="scratchpad-resize-handle"
          onMouseDown={onResizeMouseDown}
        /></Tooltip>
      )}
    </div>
  )
}
