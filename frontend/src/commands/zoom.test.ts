import { describe, it, expect } from 'vitest'
import { nextZoomStep, zoomedFontSize, ZOOM_MAX_FONT, ZOOM_MIN_FONT } from './zoom'

describe('zoomedFontSize', () => {
  it('leaves the chosen size alone at step 0 (Actual Size), even outside the zoom range', () => {
    expect(zoomedFontSize(14, 0)).toBe(14)
    expect(zoomedFontSize(32, 0)).toBe(32)
  })

  it('applies the step on top of any base size (global or per-session)', () => {
    expect(zoomedFontSize(14, 2)).toBe(16)
    expect(zoomedFontSize(18, -3)).toBe(15)
  })

  it('keeps zoomed text within 9–24 px', () => {
    expect(zoomedFontSize(20, 10)).toBe(ZOOM_MAX_FONT)
    expect(zoomedFontSize(12, -10)).toBe(ZOOM_MIN_FONT)
  })

  it('never pulls a size the user chose outside the range back into it', () => {
    expect(zoomedFontSize(32, 1)).toBe(32)
    expect(zoomedFontSize(32, -1)).toBe(31)
    expect(zoomedFontSize(8, -1)).toBe(8)
  })
})

describe('nextZoomStep', () => {
  it('steps by one and stops at the span of the zoom range', () => {
    expect(nextZoomStep(0, 1)).toBe(1)
    expect(nextZoomStep(0, -1)).toBe(-1)
    expect(nextZoomStep(ZOOM_MAX_FONT - ZOOM_MIN_FONT, 1)).toBe(ZOOM_MAX_FONT - ZOOM_MIN_FONT)
    expect(nextZoomStep(ZOOM_MIN_FONT - ZOOM_MAX_FONT, -1)).toBe(ZOOM_MIN_FONT - ZOOM_MAX_FONT)
  })
})
