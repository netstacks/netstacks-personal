import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useOverlayDismiss } from '../hooks/useOverlayDismiss'
import { clampMove, clampToViewport, resizeRect, type Edge, type Rect } from './modalFrameGeometry'
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
 *
 * Focus contract (every dialog gets it): on open, focus moves into the dialog
 * — a child that already took focus (React `autoFocus`, its own effect) keeps
 * it, else the first `[autofocus]` / `[data-autofocus]` element, else the
 * first focusable control, else the dialog itself. While a modal dialog is
 * open, Tab / Shift+Tab wrap inside it and the rest of the page is `inert`
 * (aria-hidden where `inert` is unsupported). On close, focus returns to the
 * element that had it before the dialog opened.
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


const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const DEFAULT_MIN = { width: 320, height: 200 }
const NON_DRAG_TARGETS = 'button, input, select, textarea, a, label, [role="button"], [role="tab"], [contenteditable="true"]'

const FOCUSABLE_SELECTOR =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
const AUTOFOCUS_SELECTOR = '[autofocus], [data-autofocus]'
/** Siblings left alone when inerting the page: they hold no focusable UI, or must keep announcing. */
const INERT_EXEMPT = 'script, style, link, template, [aria-live]'

function isVisible(el: HTMLElement): boolean {
  if (el.closest('[hidden], [inert]')) return false
  return typeof el.checkVisibility === 'function' ? el.checkVisibility() : true
}

/** The dialog's keyboard-reachable controls, in tab order (DOM order; positive tabindex is not used). */
function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(isVisible)
}

// Reference counts so stacked dialogs (one opened from another) share the
// inerted page, and the page is released only when the last one closes.
const inertCounts = new Map<Element, { count: number; owned: boolean; viaAria: boolean }>()
const supportsInert = () => typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype

function inertSiblings(keep: Element): () => void {
  const parent = keep.parentElement
  if (!parent) return () => {}
  const targets = [...parent.children].filter((el) => el !== keep && !el.matches(INERT_EXEMPT))
  for (const el of targets) {
    const entry = inertCounts.get(el)
    if (entry) {
      entry.count += 1
      continue
    }
    const owned = !el.hasAttribute('inert')
    const viaAria = owned && !supportsInert() && el.getAttribute('aria-hidden') !== 'true'
    if (owned) el.setAttribute('inert', '')
    if (viaAria) el.setAttribute('aria-hidden', 'true')
    inertCounts.set(el, { count: 1, owned, viaAria })
  }
  return () => {
    for (const el of targets) {
      const entry = inertCounts.get(el)
      if (!entry) continue
      entry.count -= 1
      if (entry.count > 0) continue
      inertCounts.delete(el)
      if (entry.owned) el.removeAttribute('inert')
      if (entry.viaAria) el.removeAttribute('aria-hidden')
    }
  }
}

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

  // Captured during the first render — before a child's `autoFocus` (which
  // React applies in the commit, ahead of any effect here) moves focus.
  const [opener] = useState(() => (typeof document === 'undefined' ? null : document.activeElement))

  // Initial focus, then restore on close. Layout effect so focus moves before
  // paint; children's autofocus and focus effects have already run.
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    if (!frame.contains(document.activeElement)) {
      const preferred = [...frame.querySelectorAll<HTMLElement>(AUTOFOCUS_SELECTOR)].find(isVisible)
      const target = preferred ?? focusableWithin(frame)[0] ?? frame
      target.focus({ preventScroll: true })
    }
    return () => {
      // Only hand focus back when it is still ours to give: inside the
      // dialog, or dropped on <body> because the dialog just unmounted.
      const active = document.activeElement
      const lost = !active || active === document.body || frame.contains(active)
      if (lost && opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [opener])

  // Background inert while a modal dialog is open.
  useEffect(() => {
    const overlay = frameRef.current?.parentElement
    if (!modal || !overlay) return
    return inertSiblings(overlay)
  }, [modal])

  const onFrameKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e)
    if (e.defaultPrevented || e.key !== 'Tab' || !modal) return
    const frame = frameRef.current
    if (!frame) return
    const focusable = focusableWithin(frame)
    if (focusable.length === 0) {
      e.preventDefault()
      frame.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === frame)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

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

  // Keep a moved/resized dialog inside the window when it shrinks: the size
  // shrinks to fit too, so the header and the far edges stay reachable.
  useEffect(() => {
    if (!rect) return
    const onResize = () => setRect((r) => (r ? clampToViewport(r, viewport()) : r))
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
        onKeyDown={onFrameKeyDown}
        tabIndex={-1}
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
