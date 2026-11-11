import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// Enterprise: the Controller manages the AI providers, so Settings → AI shows
// them read-only and never asks for a local provider's model list (the
// Controller has no /ai/providers/<type>/models). Standalone still does.
const env = vi.hoisted(() => ({ enterprise: true }))
vi.mock('../../hooks/useMode', () => ({
  useMode: () => ({
    mode: env.enterprise ? 'enterprise' : 'standalone',
    isEnterprise: env.enterprise,
    isStandalone: !env.enterprise,
    hasEnterpriseFeatures: env.enterprise,
    isInitialized: true,
    controllerUrl: env.enterprise ? 'https://controller.test' : null,
  }),
}))
vi.mock('../../api/client', () => ({
  getClient: () => ({ mode: env.enterprise ? 'enterprise' : 'standalone', http: { get: vi.fn().mockResolvedValue({ data: null }) } }),
  getCurrentMode: () => (env.enterprise ? 'enterprise' : 'standalone'),
  isClientInitialized: () => false,
}))
const listProviderModels = vi.hoisted(() => vi.fn())
const getSanitizationConfig = vi.hoisted(() => vi.fn())
const setAiAgentConfig = vi.hoisted(() => vi.fn())
vi.mock('../../api/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/ai')>()
  const resolved = <T,>(value: T) => vi.fn().mockResolvedValue(value)
  return {
    ...actual,
    listProviderModels,
    getAiConfig: resolved(null),
    getAiProviderOverrides: resolved({}),
    hasAiApiKey: resolved(false),
    getAiApiKey: resolved(null),
    getSanitizationConfig,
    setAiAgentConfig,
    getAiStatus: resolved({ configured: true, providers: [{ type: 'anthropic', name: 'Claude', is_default: true }] }),
    getAiConfigModeStatus: resolved({ enabled: false, expires_at: null, seconds_remaining: null }),
    checkOllamaStatus: resolved(false),
    fetchOllamaModels: resolved([]),
  }
})
vi.mock('../AIMemoryTab', () => ({ default: () => null }))
vi.mock('../McpServersSection', () => ({ default: () => null }))

import AISettingsTab from '../AISettingsTab'
import { TokenUsageProvider } from '../../contexts/TokenUsageContext'
import { useCapabilitiesStore } from '../../stores/capabilitiesStore'
import { DEFAULT_SANITIZATION_CONFIG } from '../../api/ai'

/** Signed in to the Controller with these RBAC permissions. */
function signedInWith(permissions: string[]) {
  useCapabilitiesStore.setState({ capabilities: { version: '1.0', license_tier: 'enterprise', features: [] }, permissions })
}

async function renderTab() {
  render(<TokenUsageProvider><AISettingsTab /></TokenUsageProvider>)
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  cleanup()
  listProviderModels.mockReset().mockResolvedValue({ models: [], source: 'live' })
  getSanitizationConfig.mockReset().mockResolvedValue({ ...DEFAULT_SANITIZATION_CONFIG, redact_hostnames: true })
  setAiAgentConfig.mockReset().mockResolvedValue(undefined)
  useCapabilitiesStore.setState({ capabilities: null, permissions: [] })
})

describe('Settings → AI providers', () => {
  it('enterprise: shows the Controller-managed providers and fetches no local model list', async () => {
    env.enterprise = true
    await renderTab()
    expect(screen.getByText(/its administrator manages the providers/)).toBeInTheDocument()
    expect(await screen.findByText('Claude')).toBeInTheDocument()
    expect(listProviderModels).not.toHaveBeenCalled()
  })

  it('standalone: the expanded provider card loads its models', async () => {
    env.enterprise = false
    await renderTab()
    expect(listProviderModels).toHaveBeenCalledWith('anthropic', expect.anything())
  })
})

describe('Settings → AI redaction rules', () => {
  it('enterprise non-admin: never asks for the admin-only config and says who manages it', async () => {
    env.enterprise = true
    signedInWith(['devices.view', 'sessions.connect'])
    await renderTab()
    expect(getSanitizationConfig).not.toHaveBeenCalled()
    expect(screen.getByText('Redaction rules are managed by your administrator.')).toBeInTheDocument()
    expect(screen.queryByText('Optional Redaction')).toBeNull()
    expect(screen.queryByText('Custom Redaction Patterns')).toBeNull()
    expect(screen.queryByText('Allowlist')).toBeNull()
    // Testing what the org's rules redact stays available to everyone.
    expect(screen.getByText('Test Sanitization')).toBeInTheDocument()
  })

  it.each([['system.manage'], ['*']])('enterprise admin (%s): loads and edits the org\'s rules', async (permission) => {
    env.enterprise = true
    signedInWith([permission])
    await renderTab()
    expect(getSanitizationConfig).toHaveBeenCalledOnce()
    expect(await screen.findByText('Optional Redaction')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Redact Hostnames/FQDNs' })).toBeChecked()
    expect(screen.queryByText('Redaction rules are managed by your administrator.')).toBeNull()
  })

  it('standalone: edits this machine\'s rules', async () => {
    env.enterprise = false
    await renderTab()
    expect(getSanitizationConfig).toHaveBeenCalledOnce()
    expect(await screen.findByText('Optional Redaction')).toBeInTheDocument()
  })
})

describe('Settings → AI agent config', () => {
  it('opening the tab writes nothing; changing an agent setting saves ai.agent_config', async () => {
    env.enterprise = true
    signedInWith(['*'])
    await renderTab()
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(setAiAgentConfig).not.toHaveBeenCalled()

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Max Iterations' }), { target: { value: '22' } })
    expect(setAiAgentConfig).toHaveBeenCalledOnce()
    expect(setAiAgentConfig).toHaveBeenCalledWith(expect.objectContaining({ provider: null, max_iterations: 22 }))
  })
})
