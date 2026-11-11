// View → Zoom scales content text (terminal + editors), not the whole UI. It is
// a step (`view.zoomStep`) applied on top of whatever font size is in effect —
// global setting or a session's own — so Actual Size (step 0) restores exactly
// what the user chose. Zoom never takes text outside 9–24 px, and never pulls a
// size the user chose outside that range into it.
export const ZOOM_MIN_FONT = 9
export const ZOOM_MAX_FONT = 24
const MAX_STEP = ZOOM_MAX_FONT - ZOOM_MIN_FONT

/** The zoom step after one Zoom In (+1) or Zoom Out (-1). */
export function nextZoomStep(step: number, delta: 1 | -1): number {
  return Math.min(MAX_STEP, Math.max(-MAX_STEP, step + delta))
}

/** A content font size with the zoom step applied. */
export function zoomedFontSize(base: number, step: number): number {
  if (step === 0) return base
  return Math.min(Math.max(base, ZOOM_MAX_FONT), Math.max(Math.min(base, ZOOM_MIN_FONT), base + step))
}
