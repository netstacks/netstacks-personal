import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import MenuBar from './MenuBar'

function expanded(): string[] {
  return screen.getAllByRole('button', { expanded: true }).map(b => b.textContent ?? '')
}

function pressAlt(target: Element | Window = window) {
  act(() => {
    fireEvent.keyDown(target, { key: 'Alt', altKey: true })
    fireEvent.keyUp(target, { key: 'Alt' })
  })
}

afterEach(() => cleanup())

describe('MenuBar', () => {
  it('underlines a unique mnemonic letter in every top-level menu', () => {
    const { container } = render(<MenuBar />)
    const letters = [...container.querySelectorAll('.menu-top u.mnemonic')].map(u => u.textContent?.toLowerCase())
    expect(letters).toHaveLength(container.querySelectorAll('.menu-top').length)
    expect(new Set(letters).size).toBe(letters.length)
  })

  it('a bare Alt press+release opens the first menu, and again closes it', () => {
    render(<MenuBar />)
    pressAlt()
    expect(expanded()).toEqual(['File'])
    pressAlt()
    expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(0)
  })

  it('Alt+letter opens the matching menu', () => {
    render(<MenuBar />)
    act(() => { fireEvent.keyDown(window, { key: 'e', altKey: true }) })
    expect(expanded()).toEqual(['Edit'])
  })

  it('ArrowRight/ArrowLeft move between menus', () => {
    render(<MenuBar />)
    pressAlt()
    const bar = screen.getByRole('menubar')
    act(() => { fireEvent.keyDown(bar, { key: 'ArrowRight' }) })
    expect(expanded()).toEqual(['Edit'])
    act(() => { fireEvent.keyDown(bar, { key: 'ArrowLeft' }) })
    act(() => { fireEvent.keyDown(bar, { key: 'ArrowLeft' }) })
    expect(expanded()).toEqual(['Help'])
  })

  it('Escape closes the open menu', () => {
    render(<MenuBar />)
    pressAlt()
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }) })
    expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(0)
  })

  it('leaves Alt chords to the terminal', () => {
    render(<MenuBar />)
    const term = document.createElement('div')
    term.className = 'xterm'
    document.body.appendChild(term)
    act(() => { fireEvent.keyDown(term, { key: 'f', altKey: true }) })
    pressAlt(term)
    expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(0)
    term.remove()
  })

  it('leaves Alt to an open modal dialog', () => {
    render(<MenuBar />)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'alertdialog')
    dialog.setAttribute('aria-modal', 'true')
    const button = document.createElement('button')
    dialog.appendChild(button)
    document.body.appendChild(dialog)
    pressAlt(button)
    act(() => { fireEvent.keyDown(button, { key: 'f', altKey: true }) })
    expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(0)
    dialog.remove()
  })

  it('a window blur clears a pending bare Alt', () => {
    render(<MenuBar />)
    act(() => {
      fireEvent.keyDown(window, { key: 'Alt', altKey: true })
      fireEvent.blur(window)
      fireEvent.keyUp(window, { key: 'Alt' })
    })
    expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(0)
  })

  it('returns focus to where it was when a keyboard-opened menu closes', () => {
    render(<MenuBar />)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    pressAlt(input)
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }) })
    expect(document.activeElement).toBe(input)
    input.remove()
  })
})
