import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import EdgeDock from './EdgeDock'

function renderDock(onClick = vi.fn()) {
  render(
    <EdgeDock slotRef={() => {}}>
      <button type="button" className="panel-tab" onClick={onClick}>Knowledge</button>
    </EdgeDock>,
  )
  return { dock: screen.getByTestId('edge-dock'), tab: screen.getByRole('button', { name: 'Knowledge' }), onClick }
}

function drag(tab: HTMLElement, fromY: number, toY: number) {
  fireEvent.pointerDown(tab, { button: 0, clientY: fromY })
  fireEvent.pointerMove(window, { clientY: toY })
  fireEvent.pointerUp(window, { clientY: toY })
  fireEvent.click(tab)
}

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('EdgeDock', () => {
  it('moves vertically when a tab is dragged, persists the position, and swallows the drop click', () => {
    const { dock, tab, onClick } = renderDock()
    expect(dock.style.top).toBe('120px')
    drag(tab, 200, 260)
    expect(dock.style.top).toBe('180px')
    expect(localStorage.getItem('netstacks-edge-dock-y')).toBe('180')
    expect(onClick).not.toHaveBeenCalled()
  })

  it('keeps a plain click (no drag) working', () => {
    const { tab, onClick } = renderDock()
    fireEvent.pointerDown(tab, { button: 0, clientY: 200 })
    fireEvent.pointerUp(window, { clientY: 201 })
    fireEvent.click(tab)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('stays inside the window', () => {
    const { dock, tab } = renderDock()
    drag(tab, 200, -500)
    expect(dock.style.top).toBe('8px')
    drag(tab, 200, window.innerHeight + 500)
    expect(Number.parseFloat(dock.style.top)).toBeLessThanOrEqual(window.innerHeight - 8)
  })

  it('starts at the saved position', () => {
    localStorage.setItem('netstacks-edge-dock-y', '300')
    const { dock } = renderDock()
    expect(dock.style.top).toBe('300px')
  })
})
