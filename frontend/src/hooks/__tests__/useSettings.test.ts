import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import { useSettings, coerceNumericSettings } from '../useSettings'

const STORAGE_KEY = 'netstacks-settings'

describe('useSettings numeric coercion (NS-SET-4)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('coerceNumericSettings replaces null/NaN/Infinity numbers with defaults', () => {
    const out = coerceNumericSettings({
      fontSize: null,
      'ai.agent.temperature': NaN,
      'ai.maxConversationMessages': Infinity,
      'ai.liveContext.scrollbackLines': 50,
      fontFamily: 'Inter',
    })
    expect(out.fontSize).toBe(13)
    expect(out['ai.agent.temperature']).toBe(0.7)
    expect(out['ai.maxConversationMessages']).toBe(20)
    expect(out['ai.liveContext.scrollbackLines']).toBe(50)
    expect(out.fontFamily).toBe('Inter')
  })

  it('falls back to the default font size when the stored value is null', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: null }))
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.fontSize).toBe(13)
  })

  it('never persists NaN through updateSetting', () => {
    const { result } = renderHook(() => useSettings())
    act(() => {
      result.current.updateSetting('fontSize', 17)
    })
    expect(result.current.settings.fontSize).toBe(17)

    act(() => {
      result.current.updateSetting('fontSize', NaN)
    })
    expect(result.current.settings.fontSize).toBe(13)
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored.fontSize).toBe(13)
  })

  it('resetSettings restores defaults', () => {
    const { result } = renderHook(() => useSettings())
    act(() => {
      result.current.updateSetting('terminal.copyOnSelect', true)
    })
    expect(result.current.settings['terminal.copyOnSelect']).toBe(true)
    act(() => {
      result.current.resetSettings()
    })
    expect(result.current.settings['terminal.copyOnSelect']).toBe(false)
  })
})
