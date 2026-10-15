import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

// Enterprise mode with the Controller's capabilities. The standalone-only
// tab bodies are stubbed to markers so a test can tell whether one rendered
// (their real bodies call sidecar-only routes the Controller lacks).
vi.mock('../../hooks/useMode', () => ({
  useMode: () => ({ mode: 'enterprise', isEnterprise: true, isStandalone: false, hasEnterpriseFeatures: true, isInitialized: true, controllerUrl: 'https://controller.test' }),
}))
vi.mock('../SettingsTunnels', () => ({ default: () => <div data-testid="tunnels-body" /> }))
vi.mock('../VaultSettings', () => ({ default: () => <div data-testid="vault-body" /> }))
vi.mock('../HostKeysTab', () => ({ default: () => <div data-testid="host-keys-body" /> }))
vi.mock('../StatusBarSettings', () => ({ default: () => null }))
vi.mock('../PanelSettings', () => ({ default: () => null }))
vi.mock('../SettingsHostnames', () => ({ default: () => null }))
vi.mock('../ClipboardSettingsTab', () => ({ default: () => <div data-testid="clipboard-body" /> }))

import SettingsPanel from '../SettingsPanel'
import { useCapabilitiesStore } from '../../stores/capabilitiesStore'

beforeEach(() => {
  useCapabilitiesStore.setState({
    capabilities: { version: '1.0', license_tier: 'enterprise', features: [{ name: 'local_terminal', enabled: true }] },
    permissions: ['*'],
  })
})

const sidebar = () => document.querySelector<HTMLElement>('.settings-sidebar')!

describe('SettingsPanel in enterprise', () => {
  it('shows General instead of a standalone-only tab body asked for directly', () => {
    render(<SettingsPanel initialTab="tunnels" />)
    expect(screen.queryByTestId('tunnels-body')).toBeNull()
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument()
    expect(within(sidebar()).getByRole('button', { name: 'General' })).toHaveClass('active')
  })

  it('lists only the tabs the Controller backs', () => {
    render(<SettingsPanel />)
    const nav = within(sidebar())
    for (const label of ['Tunnels', 'Security', 'Trusted Hosts', 'Layouts', 'Snippets']) {
      expect(nav.queryByRole('button', { name: label })).toBeNull()
    }
    expect(nav.getByRole('button', { name: 'Account' })).toBeInTheDocument()
  })

  it('search never jumps to a standalone-only tab', () => {
    render(<SettingsPanel />)
    fireEvent.change(screen.getByPlaceholderText('Search all settings...'), { target: { value: 'vault' } })
    expect(screen.queryByTestId('vault-body')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('Search all settings...'), { target: { value: 'known hosts' } })
    expect(screen.queryByTestId('host-keys-body')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('Search all settings...'), { target: { value: 'paste' } })
    expect(screen.getByTestId('clipboard-body')).toBeInTheDocument()
  })

  it('does not offer the setup wizard (it writes AI config to the local agent)', () => {
    render(<SettingsPanel />)
    expect(screen.queryByRole('button', { name: 'Re-run Setup Wizard' })).toBeNull()
  })
})
