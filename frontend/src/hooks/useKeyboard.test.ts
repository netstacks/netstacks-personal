import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  useKeyboard,
  shouldDeferToTarget,
  canonicalBinding,
  matchesBinding,
  eventToBinding,
  formatShortcut,
  findShortcutOwner,
  findKeybindingConflict,
  getCurrentBinding,
  resetAllKeybindings,
  setKeybinding,
  DEFAULT_KEYBINDINGS,
  KEYBOARD_ACTIONS,
  KEYBOARD_CATEGORIES,
  type KeyboardActionHandler,
} from './useKeyboard'

// jsdom's navigator.platform is '' → the hook resolves the Windows bindings.
function press(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(e)
  return e
}

function mount(action: 'closeTab' | 'saveDocument' | 'commandPalette' | 'newTerminal', handler: KeyboardActionHandler) {
  const hook = renderHook(() => useKeyboard())
  hook.result.current.registerAction(action, handler)
  return hook
}

beforeEach(() => {
  localStorage.clear()
  resetAllKeybindings()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('registry consistency', () => {
  it('lists every action exactly once, in a category the settings page renders', () => {
    const ids = KEYBOARD_ACTIONS.map(a => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.sort()).toEqual(Object.keys(DEFAULT_KEYBINDINGS).sort())
    for (const a of KEYBOARD_ACTIONS) expect(KEYBOARD_CATEGORIES).toContain(a.category)
  })

  it('has no two defaults on the same chord (per platform)', () => {
    for (const platform of ['mac', 'windows'] as const) {
      const seen = new Map<string, string>()
      for (const [id, b] of Object.entries(DEFAULT_KEYBINDINGS)) {
        const key = canonicalBinding(b[platform])
        expect(seen.get(key), `${id} and ${seen.get(key)} share ${b[platform]}`).toBeUndefined()
        seen.set(key, id)
      }
    }
  })
})

describe('binding grammar', () => {
  it('canonicalizes modifier order, Meta/Cmd, and key aliases', () => {
    expect(canonicalBinding('Shift+Ctrl+K')).toBe(canonicalBinding('Ctrl+Shift+K'))
    expect(canonicalBinding('Meta+K')).toBe(canonicalBinding('Cmd+k'))
    expect(canonicalBinding('Ctrl+Return')).toBe(canonicalBinding('Ctrl+Enter'))
    expect(canonicalBinding('Escape')).toBe(canonicalBinding('Esc'))
    expect(canonicalBinding('Ctrl+ArrowUp')).toBe(canonicalBinding('Ctrl+Up'))
  })

  it('matches events strictly on modifiers and tolerantly on key spelling', () => {
    const ev = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)
    expect(matchesBinding(ev({ key: 'Enter', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Return')).toBe(true)
    expect(matchesBinding(ev({ key: 'Escape' }), 'Esc')).toBe(true)
    expect(matchesBinding(ev({ key: 'k', ctrlKey: true }), 'Cmd+K')).toBe(false)
    expect(matchesBinding(ev({ key: 'k', metaKey: true }), 'Ctrl+K')).toBe(false)
    expect(matchesBinding(ev({ key: 'w' }), 'Ctrl+W')).toBe(false)
  })

  it('round-trips a recorded chord through the matcher', () => {
    const e = new KeyboardEvent('keydown', { key: 'ArrowUp', ctrlKey: true, altKey: true })
    const recorded = eventToBinding(e)
    expect(recorded).toBe('Ctrl+Alt+Up')
    expect(matchesBinding(e, recorded)).toBe(true)
    expect(eventToBinding(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true }))).toBe('')
  })

  it('formats for the platform', () => {
    expect(formatShortcut('Ctrl+Shift+P')).toBe('Ctrl+Shift+P')
    expect(formatShortcut('Cmd+Shift+P')).toBe('Ctrl+Shift+P')
  })
})

describe('shared store', () => {
  it('applies a rebind from one hook instance to another instance\'s dispatcher immediately', () => {
    const newTerminal = vi.fn()
    const dispatcher = mount('newTerminal', newTerminal)
    const editor = renderHook(() => useKeyboard())

    act(() => editor.result.current.setBinding('newTerminal', 'Ctrl+Shift+Y'))

    press(document.body, { key: 't', ctrlKey: true })
    expect(newTerminal).not.toHaveBeenCalled()
    press(document.body, { key: 'y', ctrlKey: true, shiftKey: true })
    expect(newTerminal).toHaveBeenCalledTimes(1)

    // Persisted, and visible through the non-React accessor.
    expect(JSON.parse(localStorage.getItem('netstacks-keybindings') || '{}').newTerminal.windows).toBe('Ctrl+Shift+Y')
    expect(getCurrentBinding('newTerminal')).toBe('Ctrl+Shift+Y')
    expect(dispatcher.result.current.isCustomized('newTerminal')).toBe(true)

    act(() => editor.result.current.resetBinding('newTerminal'))
    expect(getCurrentBinding('newTerminal')).toBe('Ctrl+T')
    dispatcher.unmount()
    editor.unmount()
  })

  it('keeps the other platform\'s binding when rebinding on this one', () => {
    setKeybinding('closeTab', 'Ctrl+Shift+X')
    const stored = JSON.parse(localStorage.getItem('netstacks-keybindings') || '{}')
    expect(stored.closeTab).toEqual({ mac: 'Cmd+W', windows: 'Ctrl+Shift+X' })
  })
})

describe('conflicts', () => {
  it('reports the action or reserved key that owns a chord, ignoring the action being edited', () => {
    expect(findShortcutOwner('Ctrl+Shift+P')).toEqual({ action: 'commandPalette', label: 'Command Palette' })
    expect(findShortcutOwner('Shift+Ctrl+p')).toEqual({ action: 'commandPalette', label: 'Command Palette' })
    expect(findKeybindingConflict('commandPalette', 'Ctrl+Shift+P')).toBeNull()
    expect(findKeybindingConflict('closeTab', 'Ctrl+Shift+P')?.action).toBe('commandPalette')
    expect(findKeybindingConflict('closeTab', 'Ctrl+3')).toEqual({ label: 'Go to Tab 3' })
    expect(findKeybindingConflict('closeTab', 'Ctrl+Alt+Shift+F9')).toBeNull()
  })

  it('sees custom bindings, not just defaults', () => {
    setKeybinding('closeTab', 'Ctrl+Alt+Q')
    expect(findShortcutOwner('Ctrl+Alt+Q')?.action).toBe('closeTab')
    expect(findShortcutOwner('Ctrl+W')).toBeNull()
  })
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
