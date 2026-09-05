/**
 * Movable + resizable floating rect for popups (clipboard history, paste
 * preview, scratchpad, floating AI chat): header drag to move, bottom-right
 * handle to resize, clamped to the viewport, in one hook so popups don't grow
 * their own copies. With `storageKey` the rect persists (written when a
 * gesture ends, not on every mousemove).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { usePersistedState } from './usePersistedState'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface Options {
  /** Where the popup opens when nothing is stored. */
  initial: (vw: number, vh: number) => Rect
  minWidth: number
  minHeight: number
  /** localStorage key the rect is remembered under; omit for a transient popup. */
  storageKey?: string
  /** Ignore drag/resize gestures (e.g. while maximized). */
  disabled?: boolean
}

const MARGIN = 8

/** Fit `r` inside a `vw`×`vh` viewport honouring the minimum size. Pure. */
export function clampRect(r: Rect, vw: number, vh: number, minW: number, minH: number): Rect {
  const w = Math.max(Math.min(minW, vw - MARGIN * 2), Math.min(r.w, vw - MARGIN * 2))
  const h = Math.max(Math.min(minH, vh - MARGIN * 2), Math.min(r.h, vh - MARGIN * 2))
  const x = Math.min(Math.max(MARGIN, r.x), Math.max(MARGIN, vw - w - MARGIN))
  const y = Math.min(Math.max(MARGIN, r.y), Math.max(MARGIN, vh - h - MARGIN))
  return { x, y, w, h }
}

const isRect = (v: unknown): v is Rect =>
  typeof v === 'object' && v !== null &&
  (['x', 'y', 'w', 'h'] as const).every((k) => Number.isFinite((v as Record<string, unknown>)[k]))

/** Sentinel key for popups that don't persist; the stored value is never read or written for it. */
const TRANSIENT_KEY = 'netstacks:movable-rect:transient'

export function useMovableRect({ initial, minWidth, minHeight, storageKey, disabled = false }: Options) {
  const clamp = useCallback(
    (r: Rect) => clampRect(r, window.innerWidth, window.innerHeight, minWidth, minHeight),
    [minWidth, minHeight],
  )
  // Stored copy: only updated when a drag/resize finishes, and only when persisting.
  const [stored, setStored] = usePersistedState<Rect | null>(storageKey ?? TRANSIENT_KEY, null, { validate: (v): v is Rect | null => v === null || isRect(v) })
  // Live copy: follows the pointer.
  const [rect, setRect] = useState<Rect>(() => clamp((storageKey ? stored : null) ?? initial(window.innerWidth, window.innerHeight)))
  const rectRef = useRef(rect)
  useEffect(() => {
    rectRef.current = rect
  }, [rect])
  /** Which pointer gesture is in progress — for cursor/transition styling. */
  const [gesture, setGesture] = useState<'move' | 'resize' | null>(null)

  // Keep inside the viewport if the window shrinks.
  useEffect(() => {
    const onResize = () => setRect(clamp)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clamp])

  /** Track a pointer gesture: `update(ev)` drives the rect, mouseup persists it. */
  const track = useCallback((kind: 'move' | 'resize', update: (ev: MouseEvent) => void) => {
    setGesture(kind)
    const onMove = (ev: MouseEvent) => update(ev)
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setGesture(null)
      if (storageKey) setStored(rectRef.current)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [setStored, storageKey])

  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if (disabled || e.button !== 0) return
    const target = e.target as HTMLElement
    // Buttons and form fields in the header keep their own behaviour.
    if (target.closest('button, input, select, textarea, a')) return
    e.preventDefault()
    const offsetX = e.clientX - rectRef.current.x
    const offsetY = e.clientY - rectRef.current.y
    track('move', (ev) => setRect((r) => clamp({ ...r, x: ev.clientX - offsetX, y: ev.clientY - offsetY })))
  }, [clamp, disabled, track])

  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    if (disabled || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const { w: startW, h: startH } = rectRef.current
    track('resize', (ev) => setRect((r) => clamp({ ...r, w: startW + (ev.clientX - startX), h: startH + (ev.clientY - startY) })))
  }, [clamp, disabled, track])

  /** Programmatic move (e.g. open at the pointer). The caller decides on clamping. */
  const moveTo = useCallback((x: number, y: number) => setRect((r) => ({ ...r, x, y })), [])

  const style = useMemo<CSSProperties>(
    () => ({ position: 'fixed', left: rect.x, top: rect.y, width: rect.w, height: rect.h }),
    [rect],
  )

  return { rect, style, gesture, onHeaderMouseDown, onResizeMouseDown, moveTo }
}
