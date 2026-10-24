// Pure geometry for ModalFrame's move / resize / viewport clamping (kept
// apart from the component so it stays fast-refresh friendly and testable).

export interface Rect { x: number; y: number; width: number; height: number }
export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** How much of a moved dialog must stay on screen so its header can be grabbed again. */
const KEEP_VISIBLE = 80
const HEADER_REACH = 32

/** Fit a moved/resized dialog inside a (shrunken) window: size first, then position. */
export function clampToViewport(rect: Rect, viewport: { width: number; height: number }): Rect {
  const width = Math.min(rect.width, viewport.width)
  const height = Math.min(rect.height, viewport.height)
  const x = Math.min(Math.max(rect.x, 0), viewport.width - width)
  const y = Math.min(Math.max(rect.y, 0), viewport.height - height)
  return { x, y, width, height }
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
