import { describe, it, expect, afterEach } from 'vitest'
import { getModeName, getSystemPrompt } from '../aiModes'
import { getSettings, setGlobalSettings } from '../../hooks/useSettings'

const base = getSettings()
afterEach(() => setGlobalSettings({ ...base, 'ai.modes.autopilot.name': 'Auto Pilot', 'ai.modes.overlord.name': 'Overlord' }))

describe('customizable mode names', () => {
  it('getModeName falls back to the default label', () => {
    setGlobalSettings({ ...base, 'ai.modes.overlord.name': '' })
    expect(getModeName('overlord')).toBe('Overlord')
  })

  it('getModeName returns the custom name', () => {
    setGlobalSettings({ ...base, 'ai.modes.overlord.name': 'Guardian' })
    expect(getModeName('overlord')).toBe('Guardian')
  })

  it('the mode-awareness block uses the custom name', () => {
    setGlobalSettings({ ...base, 'ai.modes.autopilot.name': 'Pilot X' })
    const prompt = getSystemPrompt('autopilot', false)
    expect(prompt).toContain('Your Mode: Pilot X')
  })
})
