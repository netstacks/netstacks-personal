import { render, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mocks = vi.hoisted(() => ({
  listMcp: vi.fn(),
  mode: { isEnterprise: false, controllerUrl: null as string | null },
}))

vi.mock('../../api/mcp', () => ({
  listMcpServers: mocks.listMcp,
  connectMcpServer: vi.fn(),
}))
vi.mock('../../hooks/useMode', () => ({ useMode: () => mocks.mode }))
vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client')
  return { ...actual, getRemoteAgentHost: () => null }
})

import StatusBar from '../StatusBar'
import { useCapabilitiesStore } from '../../stores/capabilitiesStore'
import { DEFAULT_STATUS_BAR_SETTINGS, saveStatusBarSettings } from '../../api/statusBarSettings'

let hidden = false
const setHidden = (value: boolean) => {
  hidden = value
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

const renderBar = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StatusBar connectedCount={0} />
    </QueryClientProvider>,
  )

describe('StatusBar MCP polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hidden = false
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    localStorage.clear()
    mocks.listMcp.mockReset()
    mocks.listMcp.mockResolvedValue([])
    mocks.mode.isEnterprise = false
    useCapabilitiesStore.setState({
      capabilities: {
        version: 'test',
        license_tier: 'standalone',
        features: [{ name: 'local_ai_tools', enabled: true }],
      },
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    useCapabilitiesStore.setState({ capabilities: null })
  })

  it('polls every 15 s in standalone mode with the status bar enabled', async () => {
    renderBar()
    await advance(0)
    expect(mocks.listMcp).toHaveBeenCalledTimes(1)
    await advance(45_000)
    expect(mocks.listMcp).toHaveBeenCalledTimes(4)
  })

  it('does not poll while the status bar is disabled, and starts when enabled', async () => {
    saveStatusBarSettings({ ...DEFAULT_STATUS_BAR_SETTINGS, enabled: false })
    renderBar()
    await advance(60_000)
    expect(mocks.listMcp).not.toHaveBeenCalled()

    act(() => { saveStatusBarSettings({ ...DEFAULT_STATUS_BAR_SETTINGS, enabled: true }) })
    await advance(0)
    expect(mocks.listMcp).toHaveBeenCalledTimes(1)
  })

  it('does not poll in enterprise mode', async () => {
    mocks.mode.isEnterprise = true
    renderBar()
    await advance(60_000)
    expect(mocks.listMcp).not.toHaveBeenCalled()
  })

  it('does not poll without the AI tools feature', async () => {
    useCapabilitiesStore.setState({ capabilities: null })
    renderBar()
    await advance(60_000)
    expect(mocks.listMcp).not.toHaveBeenCalled()
  })

  it('pauses while hidden and refreshes as soon as the window is shown', async () => {
    renderBar()
    await advance(0)
    expect(mocks.listMcp).toHaveBeenCalledTimes(1)
    setHidden(true)
    await advance(60_000)
    expect(mocks.listMcp).toHaveBeenCalledTimes(1)
    setHidden(false)
    await advance(0)
    expect(mocks.listMcp).toHaveBeenCalledTimes(2)
  })
})
