/**
 * Scratchpad — a transient Monaco editor for jotting quick notes.
 *
 * Lifecycle is in-memory only: closing without saving discards the
 * buffer. Save target depends on context:
 *   - Active workspace tab  → <rootPath>/.netstacks/notes/<ts>.txt
 *   - No active workspace   → docs API, 'notes' category
 *
 * State (content, minimized, maximized, position/size) is owned by the
 * parent so the floating panel can hide-and-restore without losing the
 * buffer, and so the buffer can be moved into an in-app tab.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import ScratchpadEditor, { saveScratchpadContent, scratchpadTarget } from './ScratchpadEditor'
import type { WorkspaceConfig } from '../types/workspace'
import './Scratchpad.css'

interface ScratchpadProps {
  open: boolean
  minimized: boolean
  maximized: boolean
  content: string
  onContentChange: (v: string) => void
  onMinimize: () => void
  onToggleMaximize: () => void
  onPopToTab: () => void
  onClose: () => void
  /** Active workspace, if any. Determines save destination. */
  activeWorkspace: WorkspaceConfig | null
}

const DEFAULT_WIDTH = 720
const DEFAULT_HEIGHT = 560
const MIN_WIDTH = 360
const MIN_HEIGHT = 240

interface Rect { x: number; y: number; w: number; h: number }

function defaultRect(): Rect {
  const w = Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 80))
  const h = Math.min(DEFAULT_HEIGHT, Math.max(MIN_HEIGHT, window.innerHeight - 120))
  return {
    x: Math.max(8, Math.round((window.innerWidth - w) / 2)),
    y: Math.max(8, Math.round(window.innerHeight * 0.08)),
    w,
    h,
  }
}

export default function Scratchpad(props: ScratchpadProps) {
  const {
    open, minimized, maximized, content, onContentChange,
    onMinimize, onToggleMaximize, onPopToTab, onClose, activeWorkspace,
  } = props

  const [saving, setSaving] = useState(false)
  const [rect, setRect] = useState<Rect>(() => defaultRect())
  // Saved rect to restore to when un-maximizing.
  const preMaximizeRectRef = useRef<Rect | null>(null)

  // Close on Esc when the panel is visible.
  useEffect(() => {
    if (!open || minimized) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [open, minimized, onClose])

  // Keep the panel inside the viewport if the window resizes.
  useEffect(() => {
    if (!open || minimized || maximized) return
    const clamp = () => {
      setRect(r => ({
        w: Math.min(r.w, window.innerWidth - 16),
        h: Math.min(r.h, window.innerHeight - 16),
        x: Math.min(Math.max(0, r.x), window.innerWidth - Math.min(r.w, window.innerWidth)),
        y: Math.min(Math.max(0, r.y), window.innerHeight - Math.min(r.h, window.innerHeight)),
      }))
    }
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [open, minimized, maximized])

  // Drag-to-move from the header (no-op when maximized).
  const dragRef = useRef<{ offsetX: number; offsetY: number } | null>(null)
  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('button')) return
    if (maximized) return
    e.preventDefault()
    dragRef.current = { offsetX: e.clientX - rect.x, offsetY: e.clientY - rect.y }
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      setRect(r => ({
        ...r,
        x: Math.min(Math.max(0, ev.clientX - d.offsetX), window.innerWidth - r.w),
        y: Math.min(Math.max(0, ev.clientY - d.offsetY), window.innerHeight - r.h),
      }))
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [rect.x, rect.y, maximized])

  // Double-click the header → minimize.
  const onHeaderDoubleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('button')) return
    onMinimize()
  }, [onMinimize])

  // Drag-to-resize from the bottom-right corner (no-op when maximized).
  const resizeRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null)
  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    if (maximized) return
    e.preventDefault()
    e.stopPropagation()
    resizeRef.current = { startX: e.clientX, startY: e.clientY, startW: rect.w, startH: rect.h }
    const onMove = (ev: MouseEvent) => {
      const r = resizeRef.current
      if (!r) return
      setRect(prev => ({
        ...prev,
        w: Math.min(Math.max(MIN_WIDTH, r.startW + (ev.clientX - r.startX)), window.innerWidth - prev.x),
        h: Math.min(Math.max(MIN_HEIGHT, r.startH + (ev.clientY - r.startY)), window.innerHeight - prev.y),
      }))
    }
    const onUp = () => {
      resizeRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [rect.w, rect.h, maximized])

  // Snapshot the floating rect right before maximizing so we can restore.
  useEffect(() => {
    if (maximized && !preMaximizeRectRef.current) {
      preMaximizeRectRef.current = rect
    } else if (!maximized && preMaximizeRectRef.current) {
      setRect(preMaximizeRectRef.current)
      preMaximizeRectRef.current = null
    }
    // Only react when maximized changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maximized])

  if (!open || minimized) return null

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
      <div
        className="scratchpad-header"
        onMouseDown={onHeaderMouseDown}
        onDoubleClick={onHeaderDoubleClick}
        title={maximized ? 'Double-click to minimize' : 'Drag to move · double-click to minimize'}
      >
        <div className="scratchpad-title">
          <span>Scratchpad</span>
          <span className="scratchpad-target" title="Save destination">→ {target}</span>
        </div>
        <div className="scratchpad-actions">
          <button
            className="scratchpad-btn scratchpad-btn-primary"
            onClick={() => { void handleSaveClick() }}
            disabled={saving}
            title="Save (Cmd/Ctrl+S)"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            className="scratchpad-btn"
            onClick={onPopToTab}
            title="Open in a new tab"
          >
            Pop to Tab
          </button>
          <button
            className="scratchpad-btn"
            onClick={onToggleMaximize}
            title={maximized ? 'Restore' : 'Maximize'}
          >
            {maximized ? '❐' : '▢'}
          </button>
          <button
            className="scratchpad-btn"
            onClick={onMinimize}
            title="Minimize to status bar"
          >
            —
          </button>
          <button
            className="scratchpad-btn"
            onClick={onClose}
            title="Close (Esc) — discards unsaved content"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="scratchpad-body">
        <ScratchpadEditor
          value={content}
          onChange={onContentChange}
          activeWorkspace={activeWorkspace}
          onSaved={onClose}
        />
      </div>
      {!maximized && (
        <div
          className="scratchpad-resize-handle"
          onMouseDown={onResizeMouseDown}
          title="Drag to resize"
        />
      )}
    </div>
  )
}
