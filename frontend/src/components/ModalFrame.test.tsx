import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import ModalFrame from './ModalFrame'
import { clampMove, clampToViewport, resizeRect } from './modalFrameGeometry'

const VIEWPORT = { width: 1000, height: 800 }
const START = { x: 300, y: 200, width: 400, height: 300 }
const MIN = { width: 320, height: 200 }

beforeEach(() => {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(VIEWPORT.width)
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(VIEWPORT.height)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: START.x, top: START.y, width: START.width, height: START.height,
    right: START.x + START.width, bottom: START.y + START.height, x: START.x, y: START.y, toJSON: () => ({}),
  } as DOMRect)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})

function renderFrame(props: Partial<React.ComponentProps<typeof ModalFrame>> = {}) {
  return render(
    <ModalFrame id="test-dialog" label="Test" {...props}>
      <div className="test-dialog-header">
        <h2>Title</h2>
        <button type="button">Close</button>
      </div>
      <div className="dialog-content">Body</div>
    </ModalFrame>,
  )
}

const frame = () => screen.getByRole('dialog')
const header = () => screen.getByText('Title')
const edge = (name: string) => frame().querySelector(`[data-edge="${name}"]`) as HTMLElement

function drag(target: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  fireEvent.pointerDown(target, { button: 0, clientX: from.x, clientY: from.y, pointerId: 1 })
  fireEvent.pointerMove(target, { clientX: to.x, clientY: to.y, pointerId: 1 })
  fireEvent.pointerUp(target, { clientX: to.x, clientY: to.y, pointerId: 1 })
}

describe('resizeRect', () => {
  it('grows from the right and bottom edges, keeping the origin', () => {
    expect(resizeRect(START, 'se', 50, 40, MIN, VIEWPORT)).toEqual({ ...START, width: 450, height: 340 })
  })

  it('moves the origin when resizing from the left or top edge', () => {
    expect(resizeRect(START, 'nw', -50, -40, MIN, VIEWPORT)).toEqual({ x: 250, y: 160, width: 450, height: 340 })
    expect(resizeRect(START, 'w', 30, 0, MIN, VIEWPORT)).toEqual({ ...START, x: 330, width: 370 })
  })

  it('never shrinks below the minimum size or past the window', () => {
    expect(resizeRect(START, 'se', -500, -500, MIN, VIEWPORT)).toEqual({ ...START, width: 320, height: 200 })
    expect(resizeRect(START, 'nw', 200, 200, MIN, VIEWPORT)).toEqual({ x: 380, y: 300, width: 320, height: 200 })
    expect(resizeRect(START, 'se', 2000, 2000, MIN, VIEWPORT)).toEqual({ ...START, width: 700, height: 600 })
    expect(resizeRect(START, 'nw', -2000, -2000, MIN, VIEWPORT)).toEqual({ x: 0, y: 0, width: 700, height: 500 })
  })
})

describe('clampMove', () => {
  it('keeps the header reachable', () => {
    expect(clampMove({ ...START, x: -2000, y: -50 }, VIEWPORT)).toMatchObject({ x: 80 - START.width, y: 0 })
    expect(clampMove({ ...START, x: 5000, y: 5000 }, VIEWPORT)).toMatchObject({ x: 920, y: 768 })
  })
})

describe('clampToViewport', () => {
  it('shrinks the dialog to fit a smaller window, then keeps it on screen', () => {
    expect(clampToViewport({ x: 500, y: 400, width: 800, height: 700 }, { width: 600, height: 500 }))
      .toEqual({ x: 0, y: 0, width: 600, height: 500 })
    expect(clampToViewport({ x: 500, y: 400, width: 300, height: 200 }, { width: 600, height: 500 }))
      .toEqual({ x: 300, y: 300, width: 300, height: 200 })
    expect(clampToViewport({ ...START, x: -100, y: -40 }, VIEWPORT)).toEqual({ ...START, x: 0, y: 0 })
  })
})

describe('ModalFrame', () => {
  it('shrinks a resized dialog when the window shrinks', () => {
    renderFrame()
    drag(edge('se'), { x: 700, y: 500 }, { x: 760, y: 560 })
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(400)
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(300)
    fireEvent(window, new Event('resize'))
    expect(frame().style.width).toBe('400px')
    expect(frame().style.height).toBe('300px')
    expect(frame().style.left).toBe('0px')
    expect(frame().style.top).toBe('0px')
  })

  it('moves when dragged by the header, clamped on screen', () => {
    renderFrame()
    drag(header(), { x: 400, y: 210 }, { x: 450, y: 260 })
    expect(frame().style.left).toBe('350px')
    expect(frame().style.top).toBe('250px')
    drag(header(), { x: 450, y: 260 }, { x: 450, y: -500 })
    expect(frame().style.top).toBe('0px')
  })

  it('does not start a drag from a control in the header', () => {
    renderFrame()
    drag(screen.getByRole('button', { name: 'Close' }), { x: 400, y: 210 }, { x: 450, y: 260 })
    expect(frame().style.left).toBe('')
  })

  it('resizes from the bottom-right corner and the left edge', () => {
    renderFrame()
    drag(edge('se'), { x: 700, y: 500 }, { x: 760, y: 560 })
    expect(frame().style.width).toBe('460px')
    expect(frame().style.height).toBe('360px')
    drag(edge('w'), { x: 300, y: 300 }, { x: 250, y: 300 })
    expect(frame().style.left).toBe('250px')
    expect(frame().style.width).toBe('510px')
  })

  it('remembers its size per id and opens with it next time', () => {
    renderFrame()
    drag(edge('se'), { x: 700, y: 500 }, { x: 760, y: 560 })
    cleanup()
    renderFrame()
    expect(frame().style.width).toBe('460px')
    expect(frame().style.height).toBe('360px')
    expect(frame().style.left).toBe('')
  })

  it('restores the default size on a header double-click', () => {
    renderFrame()
    drag(edge('se'), { x: 700, y: 500 }, { x: 760, y: 560 })
    fireEvent.doubleClick(header())
    expect(frame().style.width).toBe('')
    expect(localStorage.getItem('netstacks-modal-size:test-dialog')).toBeNull()
  })

  it('has no resize handles when not resizable', () => {
    renderFrame({ resizable: false })
    expect(edge('se')).toBeNull()
  })

  it('dismisses on Escape and a backdrop click when modal', () => {
    const onDismiss = vi.fn()
    renderFrame({ onDismiss })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    fireEvent.click(frame().parentElement!)
    expect(onDismiss).toHaveBeenCalledTimes(2)
    fireEvent.click(frame())
    expect(onDismiss).toHaveBeenCalledTimes(2)
  })

  it('leaves the page usable when not modal: no backdrop dismissal', () => {
    const onDismiss = vi.fn()
    renderFrame({ onDismiss, modal: false })
    expect(frame().getAttribute('aria-modal')).toBe('false')
    expect(frame().parentElement!.className).toContain('ns-modal-overlay--modeless')
    fireEvent.click(frame().parentElement!)
    expect(onDismiss).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})

describe('ModalFrame focus contract', () => {
  function Harness({ onDismiss, autoFocusLast = false }: { onDismiss?: () => void; autoFocusLast?: boolean }) {
    const [open, setOpen] = useState(false)
    const close = () => { onDismiss?.(); setOpen(false) }
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>Open</button>
        <button type="button">Behind</button>
        {open && (
          <ModalFrame id="focus-dialog" label="Focus" onDismiss={close}>
            <div className="test-dialog-header"><h2>Title</h2></div>
            <input aria-label="Name" />
            {autoFocusLast ? <button type="button" data-autofocus>Save</button> : <button type="button">Save</button>}
            <button type="button" onClick={close}>Cancel</button>
          </ModalFrame>
        )}
      </>
    )
  }

  const tab = (shift = false) => fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: shift })

  function openDialog(props: Parameters<typeof Harness>[0] = {}) {
    render(<Harness {...props} />)
    const opener = screen.getByRole('button', { name: 'Open' })
    opener.focus()
    fireEvent.click(opener)
    return opener
  }

  it('moves focus to the first control on open', () => {
    openDialog()
    expect(document.activeElement).toBe(screen.getByLabelText('Name'))
  })

  it('respects a per-dialog autofocus target', () => {
    openDialog({ autoFocusLast: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }))
  })

  it('wraps Tab from the last control and Shift+Tab from the first', () => {
    openDialog()
    const name = screen.getByLabelText('Name')
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    tab(true)
    expect(document.activeElement).toBe(cancel)
    tab()
    expect(document.activeElement).toBe(name)
  })

  it('makes the page behind inert while open and releases it on close', () => {
    const opener = openDialog()
    const background = opener.parentElement!
    expect(background.hasAttribute('inert')).toBe(true)
    expect(frame().parentElement!.hasAttribute('inert')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(background.hasAttribute('inert')).toBe(false)
    expect(background.hasAttribute('aria-hidden')).toBe(false)
  })

  it('closes on Escape and restores focus to the opener', () => {
    const onDismiss = vi.fn()
    const opener = openDialog({ onDismiss })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('does not trap focus or inert the page when not modal', () => {
    render(
      <div data-testid="page">
        <ModalFrame id="modeless" label="Modeless" modal={false}><button type="button">Only</button></ModalFrame>
      </div>,
    )
    expect(screen.getByTestId('page').parentElement!.hasAttribute('inert')).toBe(false)
    const only = screen.getByRole('button', { name: 'Only' })
    expect(document.activeElement).toBe(only)
    const ev = fireEvent.keyDown(only, { key: 'Tab' })
    expect(ev).toBe(true)
  })
})
