import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useEditorFontSettings } from '../useEditorFontSettings'

const STORAGE_KEY = 'netstacks-settings'

describe('useEditorFontSettings', () => {
  beforeEach(() => localStorage.clear())

  it('uses Settings → Appearance → Editor Font Size', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'editor.fontSize': 17, fontSize: 12 }))
    expect(renderHook(() => useEditorFontSettings()).result.current.fontSize).toBe(17)
  })

  it('applies the View → Zoom step on top of it', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 'editor.fontSize': 15, 'view.zoomStep': 2 }))
    expect(renderHook(() => useEditorFontSettings()).result.current.fontSize).toBe(17)
  })
})
