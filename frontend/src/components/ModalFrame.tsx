import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useOverlayDismiss } from '../hooks/useOverlayDismiss'
import './ModalFrame.css'

/**
 * The overlay + window chrome every modal dialog uses: centred on open,
 * movable by its header, resizable from any edge or corner (like a native
 * window), and it remembers its last size per `id` (never its position).
 * Double-clicking the header restores the default size. Rendered into
 * document.body, so an ancestor that contains fixed positioning (a transform,
 * filter or backdrop-filter) can't offset or clip it.
 *
 * The drag handle is any element marked `data-drag-handle`, or the header
 * row — a direct child of the frame that is a heading or whose class ends in
 * "header" or "-head". Controls
 * inside the header (buttons, fields, links) never start a drag.
 */
export interface ModalFrameProps {
  /** Stable key for the remembered size, e.g. "session-settings". */
  id: string
  /** Escape / backdrop dismissal. Omit for dialogs that only close via their buttons. */
  onDismiss?: () => void
  /** Master switch for dismissal (e.g. false while saving). */
  dismissEnabled?: boolean
  /** Dismiss on Escape (default true). */
  escape?: boolean
  /** Dismiss on a click outside the dialog (default true; never when not modal). */
  clickOutside?: boolean
  /** Dimmed backdrop that blocks the page (default). False leaves the page usable. */
  modal?: boolean
  /** Resizable from edges/corners (default true; alerts pass false). */
  resizable?: boolean
  minSize?: { width: number; height: number }
  /** Stacking layer: dialogs, or startup gates (vault, host-key prompts). */
  layer?: 'modal' | 'gate'
  role?: 'dialog' | 'alertdialog'
  labelledBy?: string
  label?: string
  className?: string
  /** Extra inline style for the dialog surface (the frame's own position/size win). */
  style?: React.CSSProperties
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>
  testId?: string
  children: React.ReactNode
}

interface Rect { x: number; y: number; width: number; height: number }
type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const DEFAULT_MIN = { width: 320, height: 200 }
/** How much of a moved dialog must stay on screen so its header can be grabbed again. */
const KEEP_VISIBLE = 80
const HEADER_REACH = 32
const NON_DRAG_TARGETS = 'button, input, select, textarea, a, label, [role="button"], [role="tab"], [contenteditable="true"]'

const sizeKey = (id: string) => `netstacks-modal-size:${id}`

function readSize(id: string): { width: number; height: number } | null {
  try {
    const raw = localStorage.getItem(sizeKey(id))
    if (!raw) return null
    const v = JSON.parse(raw) as { width?: unknown; height?: unknown }
    return typeof v.width === 'number' && typeof v.height === 'number' ? { width: v.width, height: v.height } : null
  } catch {
    return null
  }
}

/** Keep a moved dialog grabbable: its header row stays inside the window. */
export function clampMove(rect: Rect, viewport: { width: number; height: number }): Rect {
  const x = Math.min(Math.max(rect.x, KEEP_VISIBLE - rect.width), viewport.width - KEEP_VISIBLE)
  const y = Math.min(Math.max(rect.y, 0), viewport.height - HEADER_REACH)
  return { ...rect, x, y }
}

/** Resize from `edge` by (dx, dy): the grabbed edge moves, the opposite edge stays put. */
export function resizeRect(
  start: Rect,
  edge: Edge,
  dx: number,
  dy: number,
  min: { width: number; height: number },
  viewport: { width: number; height: number },
): Rect {
  let { x, y, width, height } = start
  const right = start.x + start.width
  const bottom = start.y + start.height
  if (edge.includes('e')) width = Math.min(Math.max(start.width + dx, min.width), viewport.width - start.x)
  if (edge.includes('s')) height = Math.min(Math.max(start.height + dy, min.height), viewport.height - start.y)
  if (edge.includes('w')) {
    x = Math.min(Math.max(start.x + dx, 0), right - min.width)
    width = right - x
  }
  if (edge.includes('n')) {
    y = Math.min(Math.max(start.y + dy, 0), bottom - min.height)
    height = bottom - y
  }
  return { x, y, width, height }
}

function isHeaderTarget(frame: HTMLElement, target: HTMLElement): boolean {
  if (target.closest(NON_DRAG_TARGETS)) return false
  if (target.closest('[data-drag-handle]')) return true
  let el: HTMLElement | null = target
  while (el && el.parentElement !== frame) el = el.parentElement
  return !!el && (/^H[1-4]$/.test(el.tagName) || [...el.classList].some((c) => c.endsWith('header') || c.endsWith('-head')))
}

const ModalFrame = forwardRef<HTMLDivElement, ModalFrameProps>(function ModalFrame({
  id,
  onDismiss,
  dismissEnabled = true,
  escape = true,
  clickOutside = true,
  modal = true,
  resizable = true,
  minSize = DEFAULT_MIN,
  layer = 'modal',
  role = 'dialog',
  labelledBy,
  label,
  className,
  style: surfaceStyle,
  onKeyDown,
  testId,
  children,
}, ref) {
  const frameRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => frameRef.current as HTMLDivElement)

  // null = centred by the overlay; set once the user moves or resizes.
  const [rect, setRect] = useState<Rect | null>(null)
  const [size, setSize] = useState(() => (resizable ? readSize(id) : null))
  const [gesture, setGesture] = useState<'move' | 'resize' | null>(null)

  const { backdropProps, contentProps } = useOverlayDismiss({
    onDismiss: onDismiss ?? (() => {}),
    enabled: !!onDismiss && dismissEnabled,
    escape,
    clickOutside: modal && clickOutside,
  })

  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight })

  const currentRect = useCallback((): Rect => {
    const r = frameRef.current!.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  }, [])

  // Keep a moved dialog on screen when the window shrinks.
  useEffect(() => {
    if (!rect) return
    const onResize = () => setRect((r) => (r ? clampMove(r, viewport()) : r))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [rect])

  const startGesture = (
    e: React.PointerEvent,
    kind: 'move' | 'resize',
    apply: (start: Rect, dx: number, dy: number) => Rect,
  ) => {
    if (e.button !== 0) return
    e.preventDefault()
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture?.(e.pointerId)
    const start = rect ?? currentRect()
    const origin = { x: e.clientX, y: e.clientY }
    let last = start
    setRect(start)
    setGesture(kind)
    const onMove = (ev: PointerEvent) => {
      last = apply(start, ev.clientX - origin.x, ev.clientY - origin.y)
      setRect(last)
    }
    const onUp = () => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
      setGesture(null)
      if (kind === 'resize') {
        const remembered = { width: Math.round(last.width), height: Math.round(last.height) }
        setSize(remembered)
        localStorage.setItem(sizeKey(id), JSON.stringify(remembered))
      }
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
  }

  const onFramePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isHeaderTarget(e.currentTarget, e.target as HTMLElement)) return
    startGesture(e, 'move', (start, dx, dy) => clampMove({ ...start, x: start.x + dx, y: start.y + dy }, viewport()))
  }

  const onFrameDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isHeaderTarget(e.currentTarget, e.target as HTMLElement)) return
    localStorage.removeItem(sizeKey(id))
    setSize(null)
    setRect(null)
  }

  const style: React.CSSProperties = rect
    ? { position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height, margin: 0, maxWidth: 'none', maxHeight: 'none', transform: 'none' }
    : size
      ? { width: size.width, height: size.height, maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100vh - 16px)' }
      : {}
  const sized = !!rect || !!size

  return createPortal(
    <div
      className={`ns-modal-overlay ns-modal-overlay--${layer}${modal ? '' : ' ns-modal-overlay--modeless'}`}
      {...(modal ? backdropProps : {})}
      role="presentation"
    >
      <div
        ref={frameRef}
        className={`ns-modal${sized ? ' ns-modal--sized' : ''}${gesture ? ` ns-modal--${gesture}` : ''}${className ? ` ${className}` : ''}`}
        style={{ ...surfaceStyle, ...style }}
        role={role}
        aria-modal={modal}
        aria-labelledby={labelledBy}
        aria-label={label}
        onPointerDown={onFramePointerDown}
        onDoubleClick={onFrameDoubleClick}
        onKeyDown={onKeyDown}
        data-testid={testId}
        {...contentProps}
      >
        {children}
        {resizable && EDGES.map((edge) => (
          <div
            key={edge}
            className={`ns-modal-resize ns-modal-resize--${edge}`}
            data-edge={edge}
            aria-hidden
            onPointerDown={(e) => {
              e.stopPropagation()
              startGesture(e, 'resize', (start, dx, dy) => resizeRect(start, edge, dx, dy, minSize, viewport()))
            }}
          />
        ))}
      </div>
    </div>,
    document.body,
  )
})

export default ModalFrame
