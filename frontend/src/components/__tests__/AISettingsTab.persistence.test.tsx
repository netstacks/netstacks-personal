import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'

// Standalone Settings → AI: a change only reads as saved once the backend
// write succeeded. A failed write rolls the control back and offers Retry.
vi.mock('../../hooks/useMode', () => ({
  useMode: () => ({ mode: 'standalone', isEnterprise: false, isStandalone: true, hasEnterpriseFeatures: false, isInitialized: true, controllerUrl: null }),
}))
vi.mock('../../api/client', () => ({
  getClient: () => ({ mode: 'standalone', http: { get: vi.fn().mockResolvedValue({ data: null }) } }),
  getCurrentMode: () => 'standalone',
  isClientInitialized: () => false,
}))
const setAiAgentConfig = vi.hoisted(() => vi.fn())
const setSanitizationConfig = vi.hoisted(() => vi.fn())
vi.mock('../../api/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/ai')>()
  const resolved = <T,>(value: T) => vi.fn().mockResolvedValue(value)
  return {
    ...actual,
    listProviderModels: resolved({ models: [], source: 'live' }),
    getAiConfig: resolved(null),
    getAiProviderOverrides: resolved({}),
    setAiProviderOverrides: resolved(undefined),
    hasAiApiKey: resolved(false),
    getAiApiKey: resolved(null),
    getSanitizationConfig: resolved({ ...actual.DEFAULT_SANITIZATION_CONFIG, redact_hostnames: false }),
    setSanitizationConfig,
    setAiAgentConfig,
    getAiConfigModeStatus: resolved({ enabled: false, expires_at: null, seconds_remaining: null }),
    checkOllamaStatus: resolved(false),
    fetchOllamaModels: resolved([]),
  }
})
vi.mock('../AIMemoryTab', () => ({ default: () => null }))
vi.mock('../McpServersSection', () => ({ default: () => null }))

import AISettingsTab from '../AISettingsTab'
import { TokenUsageProvider } from '../../contexts/TokenUsageContext'
import { defaultSettings, setGlobalSettings } from '../../hooks/useSettings'

async function renderTab() {
  render(<TokenUsageProvider><AISettingsTab /></TokenUsageProvider>)
  await act(async () => { await Promise.resolve() })
}

/** A backend write that fails after a round trip, like a real request. */
const failLater = (message: string) => () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), 0))

beforeEach(() => {
  cleanup()
  setGlobalSettings(defaultSettings)
  setAiAgentConfig.mockReset()
  setSanitizationConfig.mockReset()
})

// AISettingsTab is one of the largest components in the app; mounting it under
// a full parallel test run takes several seconds on its own, so this suite gets
// a longer budget than vitest's 5 s default.
describe('Settings → AI persistence failures', { timeout: 20_000 }, () => {
  it('agent setting: rolls back on a failed save and Retry re-applies it', async () => {
    setAiAgentConfig.mockImplementationOnce(failLater('agent unreachable')).mockResolvedValue(undefined)
    await renderTab()
    const field = screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Max Iterations' })
    const before = field.value
    fireEvent.change(field, { target: { value: '22' } })

    expect(await screen.findByText(/Agent settings weren't saved: agent unreachable/)).toBeInTheDocument()
    expect(field.value).toBe(before)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(field.value).toBe('22'))
    expect(setAiAgentConfig).toHaveBeenLastCalledWith(expect.objectContaining({ max_iterations: 22 }))
    await waitFor(() => expect(screen.queryByText(/weren't saved/)).toBeNull())
  })

  it('redaction rule: a failed save restores the switch and shows a retryable error', async () => {
    setSanitizationConfig.mockImplementationOnce(failLater('disk full')).mockResolvedValue(undefined)
    await renderTab()
    const toggle = await screen.findByRole('switch', { name: 'Redact Hostnames/FQDNs' })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)

    expect(await screen.findByText(/Redaction settings weren't saved: disk full/)).toBeInTheDocument()
    expect(toggle).not.toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(toggle).toBeChecked())
    expect(setSanitizationConfig).toHaveBeenLastCalledWith(expect.objectContaining({ redact_hostnames: true }))
  })
})
