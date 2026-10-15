import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import Tooltip from './Tooltip'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function renderTip() {
  render(<Tooltip label="Network Topology" shortcut="Cmd+2"><button>icon</button></Tooltip>)
  return { anchor: screen.getByRole('button'), tip: screen.getByRole('tooltip', { hidden: true }) }
}

describe('Tooltip', () => {
  it('describes its anchor even while hidden', () => {
    const { anchor, tip } = renderTip()
    expect(anchor).toHaveAttribute('aria-describedby', tip.id)
    expect(tip).not.toBeVisible()
    expect(tip).toHaveTextContent(/^Network Topology(⌘2|Ctrl\+2)$/)
  })

  it('appears after 700ms of hover, not before', () => {
    const { anchor, tip } = renderTip()
    fireEvent.pointerEnter(anchor)
    act(() => { vi.advanceTimersByTime(699) })
    expect(tip).not.toBeVisible()
    act(() => { vi.advanceTimersByTime(1) })
    expect(tip).toBeVisible()
  })

  it('hides on pointer down, pointer leave, and any key', () => {
    const { anchor, tip } = renderTip()
    const show = () => { fireEvent.pointerEnter(anchor); act(() => { vi.advanceTimersByTime(700) }) }
    show(); fireEvent.pointerDown(anchor); expect(tip).not.toBeVisible()
    show(); fireEvent.pointerLeave(anchor); expect(tip).not.toBeVisible()
    show(); fireEvent.keyDown(window, { key: 'a' }); expect(tip).not.toBeVisible()
  })

  it('appears on keyboard focus and hides on blur', () => {
    const { anchor, tip } = renderTip()
    // jsdom has no focus-visible heuristic; a keyboard focus matches it in browsers.
    vi.spyOn(anchor, 'matches').mockImplementation((selector: string) => selector === ':focus-visible')
    act(() => { anchor.focus() })
    act(() => { vi.advanceTimersByTime(700) })
    expect(tip).toBeVisible()
    act(() => { anchor.blur() })
    expect(tip).not.toBeVisible()
  })

  it('does not appear when focus came from a mouse click (not :focus-visible)', () => {
    const { anchor, tip } = renderTip()
    const matches = vi.spyOn(anchor, 'matches').mockImplementation((selector: string) => selector !== ':focus-visible')
    act(() => { anchor.focus() })
    act(() => { vi.advanceTimersByTime(700) })
    expect(tip).not.toBeVisible()
    matches.mockRestore()
  })

  it('never appears if the pointer leaves before the delay', () => {
    const { anchor, tip } = renderTip()
    fireEvent.pointerEnter(anchor)
    fireEvent.pointerLeave(anchor)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(tip).not.toBeVisible()
  })

  it('shows for a disabled control (the wrapper takes the hover)', () => {
    render(<Tooltip label="Needs an API key"><button disabled>Save</button></Tooltip>)
    fireEvent.pointerEnter(screen.getByRole('button'))
    act(() => { vi.advanceTimersByTime(700) })
    expect(screen.getByRole('tooltip')).toHaveTextContent('Needs an API key')
  })

  it('shows nothing and describes nothing without a label', () => {
    render(<Tooltip label={undefined}><button>b</button></Tooltip>)
    fireEvent.pointerEnter(screen.getByRole('button'))
    act(() => { vi.advanceTimersByTime(700) })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-describedby')
  })

  it('keeps the anchor\'s own handlers', () => {
    const onPointerDown = vi.fn()
    render(<Tooltip label="x"><button onPointerDown={onPointerDown}>b</button></Tooltip>)
    fireEvent.pointerDown(screen.getByRole('button'))
    expect(onPointerDown).toHaveBeenCalled()
  })
})

describe('Tooltip placement', () => {
  const rect = (r: Partial<DOMRect>) => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}), ...r }) as DOMRect

  function showAt(anchorRect: DOMRect, size: { width: number; height: number }) {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(size.width)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(size.height)
    const { anchor, tip } = renderTip()
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(anchorRect)
    fireEvent.pointerEnter(anchor)
    act(() => { vi.advanceTimersByTime(700) })
    return tip
  }

  afterEach(() => { vi.restoreAllMocks() })

  it('centres below the anchor', () => {
    const tip = showAt(rect({ left: 200, width: 40, top: 100, bottom: 120 }), { width: 60, height: 20 })
    expect(tip.style.left).toBe('190px')
    expect(tip.style.top).toBe('126px')
  })

  it('flips above when there is no room below (status bar)', () => {
    const bottom = window.innerHeight - 2
    const tip = showAt(rect({ left: 200, width: 40, top: bottom - 20, bottom }), { width: 60, height: 20 })
    expect(tip.style.top).toBe(`${bottom - 20 - 6 - 20}px`)
  })

  it('stays inside the window at the right edge', () => {
    const tip = showAt(rect({ left: window.innerWidth - 10, width: 10, top: 100, bottom: 120 }), { width: 80, height: 20 })
    expect(tip.style.left).toBe(`${window.innerWidth - 80 - 4}px`)
  })
})
