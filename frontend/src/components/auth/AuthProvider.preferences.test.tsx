import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'

// Standalone: the settings stay on this device — nothing is read from or
// written to the Controller's per-user store.
const http = { get: vi.fn(async () => ({ data: null })), put: vi.fn(async () => ({ data: null })) }
vi.mock('../../api/client', () => ({
  getClient: () => ({ mode: 'standalone', http }),
  getCurrentMode: () => 'standalone',
  isClientInitialized: () => true,
}))
vi.mock('../../hooks/useMode', () => ({
  useMode: () => ({ mode: 'standalone', isEnterprise: false, isStandalone: true, hasEnterpriseFeatures: false, isInitialized: true, controllerUrl: null }),
}))

import { AuthProvider } from './AuthProvider'
import { defaultSettings, getSettings, setGlobalSettings, STORAGE_KEY } from '../../hooks/useSettings'
import { setAppTheme } from '../../lib/appTheme'

describe('AuthProvider in standalone', () => {
  it('renders the app at once and never syncs settings to a Controller', async () => {
    vi.useFakeTimers()
    render(<AuthProvider><div>app</div></AuthProvider>)
    expect(screen.getByText('app')).toBeInTheDocument()

    act(() => {
      setGlobalSettings({ ...getSettings(), 'ai.permissionMode.autopilot': 'yolo', 'view.zoomStep': 2 })
      setAppTheme('dark')
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expect(http.get).not.toHaveBeenCalled()
    expect(http.put).not.toHaveBeenCalled()
    // The device copy is the unscoped key, as before.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)['view.zoomStep']).toBe(2)
    setGlobalSettings(defaultSettings)
    vi.useRealTimers()
  })
})
