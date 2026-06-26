import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'

interface ClampedMenu {
  /** Attach to the menu's root element so its real size can be measured. */
  ref: RefObject<HTMLDivElement | null>
  /** A position:fixed style with left/top already clamped to the viewport. */
  style: CSSProperties
}

/**
 * Keeps a popup / context menu fully inside the viewport.
 *
 * The menu is rendered once at the raw cursor point, measured with
 * offsetWidth/offsetHeight, then nudged so its right and bottom edges stay
 * on screen and its top/left never go negative. Measuring the real element
 * correctly accounts for dividers, icon rows, text wrapping and any
 * max-height scroll cap — a fixed per-item height guess does not.
 *
 * The correction runs in useLayoutEffect, so React flushes it before the
 * browser paints: the menu never visibly jumps.
 */
export function useClampedMenuPosition(
  position: { x: number; y: number } | null,
  margin = 8,
): ClampedMenu {
  const ref = useRef<HTMLDivElement | null>(null)
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(position)

  useLayoutEffect(() => {
    let next = position
    if (position && ref.current) {
      // offsetWidth/offsetHeight report the layout border-box size and, unlike
      // getBoundingClientRect(), are NOT shrunk by the menu's scale() open
      // animation — so clamping uses the menu's true final size.
      const { offsetWidth: width, offsetHeight: height } = ref.current
      next = {
        x: Math.max(margin, Math.min(position.x, window.innerWidth - width - margin)),
        y: Math.max(margin, Math.min(position.y, window.innerHeight - height - margin)),
      }
    }
    // Measuring the rendered DOM and re-positioning from it can only happen
    // after layout — this is the canonical useLayoutEffect pattern, not
    // derived state that could be computed during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCoords(next)
  }, [position, margin])

  return {
    ref,
    style: {
      position: 'fixed',
      left: coords?.x ?? position?.x ?? 0,
      top: coords?.y ?? position?.y ?? 0,
    },
  }
}
