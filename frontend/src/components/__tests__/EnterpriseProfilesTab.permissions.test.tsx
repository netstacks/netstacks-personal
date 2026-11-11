import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

// Shared and service profiles are changed by Controller admins only
// (system.manage or *): their edit controls are offered to admins alone, and a
// refusal (403) is shown with its reason.
const api = vi.hoisted(() => ({
  listMyProfiles: vi.fn(),
  listAccessibleProfiles: vi.fn(async () => []),
  getUserDefaultProfile: vi.fn(async () => null),
  setDefaultProfile: vi.fn(),
  listProfileSecrets: vi.fn(async () => [{ id: 's1', profile_id: 'p1', secret_type: 'password', priority: 1, username: 'noc', host: null, port: null, metadata: null, allow_port_forwarding: false, allow_scp_sftp: false, record_sessions: false, expires_at: null, created_at: '' }]),
  createProfileSecret: vi.fn(),
  deleteProfileSecret: vi.fn(),
  revealProfileSecret: vi.fn(),
}))
vi.mock('../../api/enterpriseProfiles', () => api)
const showToast = vi.hoisted(() => vi.fn())
vi.mock('../Toast', () => ({ showToast }))

import EnterpriseProfilesTab from '../EnterpriseProfilesTab'
import { useAuthStore } from '../../stores/authStore'
import { useCapabilitiesStore } from '../../stores/capabilitiesStore'
import type { User } from '../../types/auth'

const profile = (profile_type: 'personal' | 'shared' | 'service') => ({ id: 'p1', name: 'NOC', profile_type, username: 'noc', is_default: true })

async function renderAs(permissions: string[], type: 'personal' | 'shared' | 'service') {
  useCapabilitiesStore.setState({ permissions, capabilities: { version: '1', license_tier: 'enterprise', features: [] } })
  api.listMyProfiles.mockResolvedValue([profile(type)])
  render(<EnterpriseProfilesTab />)
  await screen.findByText('Password')
}

beforeEach(() => {
  cleanup()
  showToast.mockClear()
  useAuthStore.setState({ user: { id: 'u1' } as unknown as User })
})

describe('My Profiles permissions', () => {
  it('a non-admin gets no edit controls on a shared profile', async () => {
    await renderAs(['devices.read'], 'shared')
    expect(screen.queryByRole('button', { name: '+ Add auth method' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(screen.getByText(/an administrator manages its auth methods/)).toBeInTheDocument()
  })

  it('a non-admin still edits their personal profile', async () => {
    await renderAs(['devices.read'], 'personal')
    expect(screen.getByRole('button', { name: '+ Add auth method' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('an admin edits a service profile', async () => {
    await renderAs(['system.manage'], 'service')
    expect(screen.getByRole('button', { name: '+ Add auth method' })).toBeInTheDocument()
  })

  it("a refusal (403) is shown with the Controller's reason", async () => {
    await renderAs(['*'], 'shared')
    api.deleteProfileSecret.mockRejectedValue(Object.assign(new Error('Request failed with status code 403'), {
      isAxiosError: true,
      response: { status: 403, data: { error: 'Only administrators can modify shared profiles' } },
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove' })) })
    expect(showToast).toHaveBeenCalledWith('Failed to remove auth method: Only administrators can modify shared profiles', 'error')
  })
})
