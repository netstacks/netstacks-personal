import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const env = vi.hoisted(() => ({ enterprise: false }))
const createHistory = vi.fn(async () => ({}))
vi.mock('../../api/sessions', () => ({
  listHistory: () => Promise.resolve([]),
  createHistory: (...a: unknown[]) => createHistory(...(a as [])),
  createSession: vi.fn(),
}))
vi.mock('../../api/profiles', () => ({
  listProfiles: () => Promise.resolve([{ id: 'p1', name: 'Lab', username: 'admin', auth_type: 'password' }]),
}))
vi.mock('../../api/enterpriseProfiles', () => ({
  listAccessibleProfiles: () => Promise.resolve([{ id: 'ep1', name: 'Org', username: 'netops', auth_mode: 'password' }]),
}))
vi.mock('../../hooks/useMode', () => ({
  useMode: () => ({ isEnterprise: env.enterprise, isStandalone: !env.enterprise }),
}))
vi.mock('../../hooks/useHostnameFormatter', () => ({ useHostnameFormatter: () => (s: string) => s }))
vi.mock('../AITabInput', () => ({ default: () => null }))

import QuickConnectDialog from '../QuickConnectDialog'
import { quickConnectTabFields, buildTerminalWsParams, type QuickConnectInfo } from '../../lib/terminalTarget'

beforeEach(() => { createHistory.mockClear() })
afterEach(() => { cleanup(); env.enterprise = false })

async function connect(host: string, profile?: string): Promise<QuickConnectInfo> {
  const onConnect = vi.fn()
  render(<QuickConnectDialog isOpen onClose={() => {}} onConnect={onConnect} />)
  fireEvent.change(screen.getByLabelText('Host'), { target: { value: host } })
  fireEvent.change(screen.getByLabelText('Port'), { target: { value: '2222' } })
  if (profile) {
    await screen.findByRole('option', { name: /Lab|Org/ })
    fireEvent.change(screen.getByLabelText(/Credential Profile/), { target: { value: profile } })
  }
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1))
  return onConnect.mock.calls[0][0] as QuickConnectInfo
}

describe('Quick Connect without saving', () => {
  it('standalone: hands back the whole target and the tab never opens a local shell', async () => {
    const info = await connect('r1.lab', 'p1')
    expect(info).toEqual({ host: 'r1.lab', port: 2222, profile_id: 'p1', username: 'admin' })
    const tab = quickConnectTabFields(info, false, 'quick-1')
    const ws = buildTerminalWsParams({ protocol: tab.protocol, ...tab })
    expect(ws.ok && ws.params.get('type')).toBe('ssh')
    expect(ws.ok && ws.params.get('host')).toBe('r1.lab')
    expect(ws.ok && ws.params.get('profile_id')).toBe('p1')
  })

  it('enterprise: connects without a profile (device-anchored) and skips local history', async () => {
    env.enterprise = true
    const info = await connect('core-sw1')
    expect(info).toEqual({ host: 'core-sw1', port: 2222, profile_id: '', username: undefined })
    expect(createHistory).not.toHaveBeenCalled()
    expect(quickConnectTabFields(info, true, 'quick-2')).toMatchObject({ enterpriseTargetHost: 'core-sw1', enterpriseProfileId: '' })
  })
})
