import { describe, it, expect, vi, afterEach } from 'vitest'

const win = vi.hoisted(() => {
  let focusHandler: ((e: { payload: boolean }) => void) | null = null
  return {
    emitFocus: (focused: boolean) => focusHandler?.({ payload: focused }),
    api: {
      isFocused: async () => false,
      onFocusChanged: async (cb: (e: { payload: boolean }) => void) => { focusHandler = cb; return () => {} },
    },
  }
})

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win.api }))

import { desktopChrome, followWindowFocus, parseCssColor } from './nativeWindow'

describe('parseCssColor', () => {
  it('parses opaque rgb() with full alpha', () => {
    expect(parseCssColor('rgb(30, 30, 30)')).toEqual([30, 30, 30, 255])
  })

  it('keeps transparency so a transparent body stays transparent', () => {
    expect(parseCssColor('rgba(0, 0, 0, 0)')).toEqual([0, 0, 0, 0])
    expect(parseCssColor('rgba(255, 255, 255, 0.5)')).toEqual([255, 255, 255, 128])
  })
})

describe('followWindowFocus', () => {
  afterEach(() => { delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ })

  it('mirrors the native window focus onto <html data-window-focused>', async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} })
    await followWindowFocus()
    expect(document.documentElement.dataset.windowFocused).toBe('false')
    win.emitFocus(true)
    expect(document.documentElement.dataset.windowFocused).toBe('true')
    win.emitFocus(false)
    expect(document.documentElement.dataset.windowFocused).toBe('false')
  })

  it('follows the page window focus in the browser build', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await followWindowFocus()
    expect(document.documentElement.dataset.windowFocused).toBe('true')
    window.dispatchEvent(new Event('blur'))
    expect(document.documentElement.dataset.windowFocused).toBe('false')
    window.dispatchEvent(new Event('focus'))
    expect(document.documentElement.dataset.windowFocused).toBe('true')
  })
})

describe('desktopChrome', () => {
  afterEach(() => { delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ })

  it('is present in the desktop app and absent in the browser build (no app menu for Settings)', () => {
    expect(desktopChrome()).toBe(false)
    Object.assign(window, { __TAURI_INTERNALS__: {} })
    expect(desktopChrome()).toBe(true)
  })
})
