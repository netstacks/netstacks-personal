import { describe, it, expect, vi } from 'vitest'

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

import { followWindowFocus, parseCssColor } from './nativeWindow'

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
  it('mirrors the native window focus onto <html data-window-focused>', async () => {
    await followWindowFocus()
    expect(document.documentElement.dataset.windowFocused).toBe('false')
    win.emitFocus(true)
    expect(document.documentElement.dataset.windowFocused).toBe('true')
    win.emitFocus(false)
    expect(document.documentElement.dataset.windowFocused).toBe('false')
  })
})
