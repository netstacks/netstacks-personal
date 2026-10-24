import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'

// Enterprise: per-user data held outside the app's React tree (module stores,
// localStorage) belongs to the signed-in user and never carries over to the
// next one. Standalone keeps its unscoped keys.
const mode = vi.hoisted(() => ({ current: 'enterprise' as string }))
vi.mock('../../api/client', () => ({
  getCurrentMode: () => mode.current,
  getClient: () => ({ mode: mode.current, http: { get: vi.fn().mockResolvedValue({ data: [] }) } }),
  isClientInitialized: () => true,
}))
vi.mock('../../api/quickPrompts', () => ({
  listQuickPrompts: vi.fn().mockResolvedValue([{ id: 'p1', name: 'alice prompt', is_favorite: false }]),
}))

import { setUserScope, clearUserScope } from '../userScope'
import { TokenUsageProvider } from '../../contexts/TokenUsageContext'
import { useTokenUsage } from '../../contexts/tokenUsageStore'
import { useClipStore } from '../../stores/clipStore'
import { useQuickPromptsStore } from '../../stores/quickPrompts'
import { useCapabilitiesStore } from '../../stores/capabilitiesStore'
import type { CapabilitiesResponse } from '../../types/capabilities'
import { useSftpStore } from '../../stores/sftpStore'
import { listHighlightRules, createHighlightRule } from '../../api/highlightRules'
import { getRememberedValues, rememberValues } from '../quickActionVariables'

function UsageProbe() {
  const { usage, trackUsage } = useTokenUsage()
  return (
    <>
      <span data-testid="total">{usage.totalTokens}</span>
      <button onClick={() => trackUsage('anthropic', { inputTokens: 5, outputTokens: 5, totalTokens: 10 })}>track</button>
    </>
  )
}

beforeEach(() => {
  cleanup()
  localStorage.clear()
  mode.current = 'enterprise'
  clearUserScope()
})

describe('per-user state in enterprise', () => {
  it("token usage is the signed-in user's own", () => {
    setUserScope('https://c', 'alice')
    render(<TokenUsageProvider><UsageProbe /></TokenUsageProvider>)
    act(() => screen.getByText('track').click())
    expect(screen.getByTestId('total')).toHaveTextContent('10')
    cleanup()

    clearUserScope()
    setUserScope('https://c', 'bob')
    render(<TokenUsageProvider><UsageProbe /></TokenUsageProvider>)
    expect(screen.getByTestId('total')).toHaveTextContent('0')
    expect(localStorage.getItem('netstacks_token_usage')).toBeNull()
  })

  it('signing out drops clipboard history, quick prompts, SFTP connections and capabilities', async () => {
    setUserScope('https://c', 'alice')
    await useClipStore.getState().capture('alice secret', { source: 'app-copy' })
    await useQuickPromptsStore.getState().load()
    useSftpStore.setState({ connections: [{ id: 's1', sessionId: 's1', deviceName: 'r1', cliFlavor: 'auto', sftpStartPath: null, homeDir: null, connected: true, error: null }], activeConnectionId: 's1', panelVisible: true })
    useCapabilitiesStore.setState({ capabilities: { features: [] } as unknown as CapabilitiesResponse, permissions: ['devices:read'] })
    expect(useClipStore.getState().clips).toHaveLength(1)
    expect(useQuickPromptsStore.getState().prompts).toHaveLength(1)

    clearUserScope()
    expect(useClipStore.getState().clips).toEqual([])
    expect(useQuickPromptsStore.getState()).toMatchObject({ prompts: [], loaded: false })
    expect(useSftpStore.getState()).toMatchObject({ connections: [], activeConnectionId: null, panelVisible: false })
    expect(useCapabilitiesStore.getState()).toMatchObject({ capabilities: null, permissions: [] })
  })

  it("highlight rules and quick-action variables are kept per user", async () => {
    setUserScope('https://c', 'alice')
    await createHighlightRule({ name: 'alice rule', pattern: 'x' })
    rememberValues('qa1', { host: 'alice-router' })
    expect(await listHighlightRules()).toHaveLength(1)

    clearUserScope()
    setUserScope('https://c', 'bob')
    expect(await listHighlightRules()).toEqual([])
    expect(getRememberedValues('qa1')).toEqual({})

    clearUserScope()
    setUserScope('https://c', 'alice')
    expect(await listHighlightRules()).toHaveLength(1)
    expect(getRememberedValues('qa1')).toEqual({ host: 'alice-router' })
  })
})

describe('standalone', () => {
  it('keeps the unscoped keys', () => {
    mode.current = 'standalone'
    rememberValues('qa1', { host: 'r1' })
    expect(JSON.parse(localStorage.getItem('qa-vars-qa1')!)).toEqual({ host: 'r1' })
    render(<TokenUsageProvider><UsageProbe /></TokenUsageProvider>)
    act(() => screen.getByText('track').click())
    expect(JSON.parse(localStorage.getItem('netstacks_token_usage')!).totalTokens).toBe(10)
  })
})
