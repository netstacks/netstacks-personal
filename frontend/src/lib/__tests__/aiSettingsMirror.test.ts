import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const put = vi.fn(async () => ({ data: null }))
vi.mock('../../api/client', () => ({
  getClient: () => ({ mode: 'standalone', http: { put } }),
  getCurrentMode: () => 'standalone',
}))

import { startAiSettingsMirror } from '../aiSettingsMirror'
import { getPermissionMode } from '../aiModes'
import { defaultSettings, setGlobalSettings, useSettings, STORAGE_KEY } from '../../hooks/useSettings'

afterEach(() => setGlobalSettings(defaultSettings))

describe('permission-mode settings', () => {
  it('persist and stay in sync between the panel picker and Settings → AI', async () => {
    const picker = renderHook(() => useSettings())
    const settingsTab = renderHook(() => useSettings())
    expect(settingsTab.result.current.settings['ai.permissionMode.overlord']).toBe('ask')

    act(() => picker.result.current.updateSetting('ai.permissionMode.overlord', 'yolo'))
    await waitFor(() => expect(settingsTab.result.current.settings['ai.permissionMode.overlord']).toBe('yolo'))
    expect(getPermissionMode('overlord')).toBe('yolo')
    expect(getPermissionMode('autopilot')).toBe('auto')
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)['ai.permissionMode.overlord']).toBe('yolo')
  })
})

describe('startAiSettingsMirror', () => {
  it('writes the sidecar-enforced settings at start and only the changed ones after', async () => {
    startAiSettingsMirror()
    const bodies = () => Object.fromEntries(put.mock.calls.map(([url, body]) => [url, body]))
    expect(bodies()).toEqual({
      '/settings/ai.permissionMode.autopilot': '"auto"',
      '/settings/ai.disabledTools.autopilot': JSON.stringify(defaultSettings['ai.disabledTools.autopilot']),
      '/settings/ai.bash.deniedCommands': '[]',
    })
    expect(put.mock.calls[0][2]).toEqual({ headers: { 'Content-Type': 'application/json' } })

    put.mockClear()
    const { result } = renderHook(() => useSettings())
    act(() => result.current.updateSetting('ai.permissionMode.overlord', 'yolo'))
    act(() => result.current.updateSetting('ai.bash.deniedCommands', ['wget']))
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
    expect(put).toHaveBeenCalledWith('/settings/ai.bash.deniedCommands', '["wget"]', expect.anything())

    // Another window (a popout) changed the Auto Pilot mode.
    put.mockClear()
    window.dispatchEvent(new StorageEvent('storage', {
      key: STORAGE_KEY,
      newValue: JSON.stringify({ ...defaultSettings, 'ai.bash.deniedCommands': ['wget'], 'ai.permissionMode.autopilot': 'ask' }),
    }))
    expect(put).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledWith('/settings/ai.permissionMode.autopilot', '"ask"', expect.anything())
  })
})
