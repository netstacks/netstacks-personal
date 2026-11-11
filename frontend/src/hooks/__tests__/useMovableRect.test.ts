import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { clampRect, useMovableRect } from '../useMovableRect'

describe('clampRect', () => {
  it('keeps a rect inside the viewport with a margin', () => {
    expect(clampRect({ x: -50, y: -50, w: 400, h: 300 }, 1000, 800, 200, 100)).toEqual({ x: 8, y: 8, w: 400, h: 300 })
    expect(clampRect({ x: 900, y: 700, w: 400, h: 300 }, 1000, 800, 200, 100)).toEqual({ x: 592, y: 492, w: 400, h: 300 })
  })

  it('applies the minimum size and shrinks to fit small windows', () => {
    expect(clampRect({ x: 10, y: 10, w: 50, h: 20 }, 1000, 800, 200, 100)).toEqual({ x: 10, y: 10, w: 200, h: 100 })
    const r = clampRect({ x: 0, y: 0, w: 2000, h: 2000 }, 500, 400, 200, 100)
    expect(r).toEqual({ x: 8, y: 8, w: 484, h: 384 })
  })
})

describe('useMovableRect', () => {
  const opts = { initial: () => ({ x: 100, y: 100, w: 400, h: 300 }), minWidth: 200, minHeight: 100 }
  const mouse = (type: string, x: number, y: number) => window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }))
  const down = (x: number, y: number) =>
    ({ button: 0, clientX: x, clientY: y, target: document.createElement('div'), preventDefault() {}, stopPropagation() {} }) as unknown as React.MouseEvent

  it('drags, resizes, reports the gesture, and persists only on mouseup', () => {
    localStorage.removeItem('t:rect')
    const { result } = renderHook(() => useMovableRect({ ...opts, storageKey: 't:rect' }))
    act(() => result.current.onHeaderMouseDown(down(110, 110)))
    expect(result.current.gesture).toBe('move')
    act(() => mouse('mousemove', 160, 140))
    expect(result.current.rect).toMatchObject({ x: 150, y: 130 })
    // usePersistedState mirrors the initial `null`; the rect itself is written on mouseup only.
    expect(JSON.parse(localStorage.getItem('t:rect')!)).toBeNull()
    act(() => mouse('mouseup', 160, 140))
    expect(result.current.gesture).toBeNull()
    expect(JSON.parse(localStorage.getItem('t:rect')!)).toMatchObject({ x: 150, y: 130, w: 400, h: 300 })

    act(() => result.current.onResizeMouseDown(down(0, 0)))
    act(() => mouse('mousemove', 50, 20))
    act(() => mouse('mouseup', 50, 20))
    expect(result.current.rect).toMatchObject({ w: 450, h: 320 })
  })

  it('ignores gestures while disabled and supports moveTo', () => {
    const { result } = renderHook(() => useMovableRect({ ...opts, disabled: true }))
    act(() => result.current.onHeaderMouseDown(down(110, 110)))
    act(() => mouse('mousemove', 300, 300))
    act(() => mouse('mouseup', 300, 300))
    expect(result.current.rect).toMatchObject({ x: 100, y: 100 })
    act(() => result.current.moveTo(20, 30))
    expect(result.current.rect).toMatchObject({ x: 20, y: 30, w: 400, h: 300 })
  })
})
