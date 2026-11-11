import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { formatShortcut } from '../hooks/useKeyboard'
import './Tooltip.css'

const SHOW_DELAY_MS = 700
const GAP_PX = 6
const EDGE_PX = 4

interface TooltipProps {
  /** No label (e.g. a conditional title) shows no tooltip; the wrapper stays so the child never remounts. */
  label?: string
  /** Keybinding such as "Cmd+," (formatted for display per platform). */
  shortcut?: string
  children: ReactElement<{ 'aria-describedby'?: string }>
}

/**
 * Native-style hover label: appears below its anchor after a short hover or
 * keyboard focus (above it when there is no room below), gone on any press,
 * key, pointer leave or blur.
 */
export default function Tooltip({ label, shortcut, children }: TooltipProps) {
  const id = useId()
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number | null>(null)

  const cancel = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }, [])

  const hide = useCallback(() => {
    cancel()
    setAnchor(null)
    setPlacement(null)
  }, [cancel])

  // The wrapper is display: contents (no box), so measure the wrapped element.
  const scheduleShow = useCallback((wrapper: HTMLSpanElement) => {
    const target = wrapper.firstElementChild
    if (!target || !label) return
    cancel()
    timer.current = window.setTimeout(() => setAnchor(target.getBoundingClientRect()), SHOW_DELAY_MS)
  }, [cancel, label])
  const onPointerEnter = useCallback((e: PointerEvent<HTMLSpanElement>) => scheduleShow(e.currentTarget), [scheduleShow])
  // Keyboard focus only: a mouse click focuses too, and must not pop a label.
  const onFocus = useCallback((e: FocusEvent<HTMLSpanElement>) => {
    if (e.target.matches(':focus-visible')) scheduleShow(e.currentTarget)
  }, [scheduleShow])

  // Place once the label is laid out: centred below the anchor, kept inside
  // the window, flipped above when it would run off the bottom.
  useLayoutEffect(() => {
    const tip = tipRef.current
    if (!anchor || !tip) return
    const { offsetWidth: width, offsetHeight: height } = tip
    const centred = anchor.left + anchor.width / 2 - width / 2
    const left = Math.min(Math.max(centred, EDGE_PX), window.innerWidth - width - EDGE_PX)
    const below = anchor.bottom + GAP_PX
    const top = below + height > window.innerHeight - EDGE_PX ? anchor.top - GAP_PX - height : below
    setPlacement({ left, top })
  }, [anchor])

  useEffect(() => {
    if (!anchor) return
    window.addEventListener('keydown', hide, true)
    return () => window.removeEventListener('keydown', hide, true)
  }, [anchor, hide])

  useEffect(() => cancel, [cancel])

  return (
    <>
      <span className="ns-tooltip-anchor" onPointerEnter={onPointerEnter} onPointerLeave={hide} onPointerDown={hide} onFocus={onFocus} onBlur={hide}>
        {cloneElement(children, { 'aria-describedby': label ? id : undefined })}
      </span>
      {createPortal(
        <div
          ref={tipRef}
          id={id}
          role="tooltip"
          className="ns-tooltip"
          hidden={!anchor}
          style={placement ?? undefined}
          data-placed={placement ? 'true' : undefined}
        >
          {label}
          {shortcut && <span className="ns-tooltip-shortcut">{formatShortcut(shortcut)}</span>}
        </div>,
        document.body,
      )}
    </>
  )
}
