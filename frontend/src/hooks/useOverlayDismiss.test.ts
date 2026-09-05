import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useOverlayDismiss } from './useOverlayDismiss'

function pressEscape() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
}

describe('useOverlayDismiss', () => {
  it('Escape dismisses only the topmost (most recently mounted) overlay', () => {
    const parent = vi.fn()
    const child = vi.fn()
    const p = renderHook(() => useOverlayDismiss({ onDismiss: parent }))
    const c = renderHook(() => useOverlayDismiss({ onDismiss: child }))

    pressEscape()
    expect(child).toHaveBeenCalledTimes(1)
    expect(parent).not.toHaveBeenCalled()

    // Once the child unmounts the parent becomes topmost again.
    c.unmount()
    pressEscape()
    expect(parent).toHaveBeenCalledTimes(1)
    p.unmount()
  })

  it('a parent re-render with a new onDismiss does not jump above the child', () => {
    const parentA = vi.fn()
    const parentB = vi.fn()
    const child = vi.fn()
    const p = renderHook(({ fn }) => useOverlayDismiss({ onDismiss: fn }), {
      initialProps: { fn: parentA },
    })
    const c = renderHook(() => useOverlayDismiss({ onDismiss: child }))
    p.rerender({ fn: parentB })

    pressEscape()
    expect(child).toHaveBeenCalledTimes(1)
    expect(parentA).not.toHaveBeenCalled()
    expect(parentB).not.toHaveBeenCalled()

    // ...but the parent does use the latest callback once it is topmost.
    c.unmount()
    pressEscape()
    expect(parentB).toHaveBeenCalledTimes(1)
    expect(parentA).not.toHaveBeenCalled()
    p.unmount()
  })

  it('stops the Escape event so bubble-phase listeners never see it', () => {
    const onDismiss = vi.fn()
    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    const h = renderHook(() => useOverlayDismiss({ onDismiss }))

    pressEscape()
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()

    h.unmount()
    window.removeEventListener('keydown', outer)
  })

  it('a disabled overlay yields to the one beneath it', () => {
    const parent = vi.fn()
    const child = vi.fn()
    const p = renderHook(() => useOverlayDismiss({ onDismiss: parent }))
    const c = renderHook(() => useOverlayDismiss({ onDismiss: child, enabled: false }))

    pressEscape()
    expect(child).not.toHaveBeenCalled()
    expect(parent).toHaveBeenCalledTimes(1)
    c.unmount()
    p.unmount()
  })

  it('backdrop click dismisses only when the press started on the backdrop', () => {
    const onDismiss = vi.fn()
    const { result } = renderHook(() => useOverlayDismiss({ onDismiss }))
    const backdrop = {} as EventTarget
    const content = {} as EventTarget
    const ev = (target: EventTarget) => ({ target, currentTarget: backdrop }) as unknown as React.MouseEvent

    // Press began inside the dialog (drag/resize/text selection) and ended over the backdrop.
    result.current.backdropProps.onMouseDown(ev(content))
    result.current.backdropProps.onClick(ev(backdrop))
    expect(onDismiss).not.toHaveBeenCalled()

    // Plain backdrop click still dismisses, and the inside-press flag does not linger.
    result.current.backdropProps.onMouseDown(ev(backdrop))
    result.current.backdropProps.onClick(ev(backdrop))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
