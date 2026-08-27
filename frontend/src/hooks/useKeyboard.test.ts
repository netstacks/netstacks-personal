import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useKeyboard, shouldDeferToTarget, type KeyboardActionHandler } from './useKeyboard'

// jsdom's navigator.platform is '' → the hook resolves the Windows bindings.
function press(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}

function mount(action: 'closeTab' | 'saveDocument' | 'commandPalette', handler: KeyboardActionHandler) {
  const hook = renderHook(() => useKeyboard())
  hook.result.current.registerAction(action, handler)
  return hook
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('shouldDeferToTarget', () => {
  it('defers single-Ctrl chords inside xterm but not Cmd or multi-modifier chords', () => {
    const xterm = document.createElement('div')
    xterm.className = 'xterm'
    const inner = document.createElement('textarea')
    xterm.appendChild(inner)
    document.body.appendChild(xterm)

    expect(shouldDeferToTarget(inner, 'Ctrl+W')).toBe(true)
    expect(shouldDeferToTarget(inner, 'Cmd+W')).toBe(false)
    expect(shouldDeferToTarget(inner, 'Ctrl+Shift+P')).toBe(false)
  })

  it('defers single-modifier chords in text inputs only', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    expect(shouldDeferToTarget(input, 'Ctrl+S')).toBe(true)
    expect(shouldDeferToTarget(input, 'Ctrl+Shift+S')).toBe(false)
    expect(shouldDeferToTarget(document.body, 'Ctrl+S')).toBe(false)
  })
})

describe('useKeyboard capture listener', () => {
  it('leaves Ctrl+W to xterm (readline kill-word) instead of closing the tab', () => {
    const xterm = document.createElement('div')
    xterm.className = 'xterm'
    document.body.appendChild(xterm)
    const closeTab = vi.fn()
    const hook = mount('closeTab', closeTab)

    const e = press(xterm, { key: 'w', ctrlKey: true })
    expect(closeTab).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)

    // Same chord from outside the terminal still fires.
    press(document.body, { key: 'w', ctrlKey: true })
    expect(closeTab).toHaveBeenCalledTimes(1)
    hook.unmount()
  })

  it('still fires multi-modifier chords inside xterm', () => {
    const xterm = document.createElement('div')
    xterm.className = 'xterm'
    document.body.appendChild(xterm)
    const palette = vi.fn()
    const hook = mount('commandPalette', palette)

    press(xterm, { key: 'p', ctrlKey: true, shiftKey: true })
    expect(palette).toHaveBeenCalledTimes(1)
    hook.unmount()
  })

  it('passes the key through when the handler declines it', () => {
    const decline = vi.fn(() => false)
    const hook = mount('saveDocument', decline)

    const e = press(document.body, { key: 's', ctrlKey: true })
    expect(decline).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(false)

    const accept = vi.fn()
    hook.result.current.registerAction('saveDocument', accept)
    const e2 = press(document.body, { key: 's', ctrlKey: true })
    expect(accept).toHaveBeenCalledTimes(1)
    expect(e2.defaultPrevented).toBe(true)
    hook.unmount()
  })
})
