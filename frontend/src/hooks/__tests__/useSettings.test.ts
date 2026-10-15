import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import { useSettings, coerceNumericSettings, seedDefaultDisabledTools } from '../useSettings'
import { DEFAULT_DISABLED_TOOLS } from '../../lib/agentTools'

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

describe('default-off AI tools seeding', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('registry flags the console tools as default-off', () => {
    expect(DEFAULT_DISABLED_TOOLS).toEqual(expect.arrayContaining(['open_console', 'run_console_command']))
  })

  it('seeds default-off tools into both modes exactly once', () => {
    const { result } = renderHook(() => useSettings())
    const s = result.current.settings
    for (const name of DEFAULT_DISABLED_TOOLS) {
      expect(s['ai.disabledTools.autopilot']).toContain(name)
      expect(s['ai.disabledTools.overlord']).toContain(name)
      expect(s['ai.disabledTools.seeded']).toContain(name)
    }
    // A user re-enable survives the next load because the tool is already seeded.
    const reenabled = seedDefaultDisabledTools({
      ...s,
      'ai.disabledTools.autopilot': s['ai.disabledTools.autopilot'].filter((n) => n !== 'open_console'),
    })
    expect(reenabled['ai.disabledTools.autopilot']).not.toContain('open_console')
  })

  it('does not disturb stored lists for already-seeded tools', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      'ai.disabledTools.autopilot': [],
      'ai.disabledTools.overlord': ['run_bash'],
      'ai.disabledTools.seeded': [...DEFAULT_DISABLED_TOOLS],
    }))
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings['ai.disabledTools.autopilot']).toEqual([])
    expect(result.current.settings['ai.disabledTools.overlord']).toEqual(['run_bash'])
  })
})

describe('useSettings font family migration', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('maps the legacy literal "System Default" stack to the platform default', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif",
    }))
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.fontFamily).toBe('')
  })

  it('keeps a user-chosen font family', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontFamily: "'JetBrains Mono', Menlo, Monaco, monospace" }))
    const { result } = renderHook(() => useSettings())
    expect(result.current.settings.fontFamily).toBe("'JetBrains Mono', Menlo, Monaco, monospace")
  })
})
