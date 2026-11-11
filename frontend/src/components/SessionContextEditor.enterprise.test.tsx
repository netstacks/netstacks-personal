import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { SessionContext } from '../types/sessionContext'

// Enterprise Team Knowledge permissions, as the Controller enforces them:
// adding needs `devices.manage` (else 403 `{"error":"Insufficient permissions"}`);
// editing or deleting needs to be the entry's author or an org admin
// (`system.manage` / `*`), else 403 with a plain-text body.
const DEVICE = '33333333-3333-3333-3333-333333333333'
const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }))
vi.mock('../api/client', () => ({
  getClient: () => ({ mode: 'enterprise', http }),
  getCurrentMode: () => 'enterprise',
  isClientInitialized: () => true,
}))
const showToast = vi.hoisted(() => vi.fn())
vi.mock('./Toast', () => ({ showToast }))

import SessionContextEditor from './SessionContextEditor'
import { useCapabilitiesStore } from '../stores/capabilitiesStore'

const entry = (id: string, author: string, issue: string): SessionContext => ({
  id, session_id: `device-${DEVICE}`, issue, root_cause: `${issue} cause`, resolution: null, commands: null, ticket_ref: null,
  author, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
})
const mine = entry('c1', 'alice', 'Uplink flapping')
const theirs = entry('c2', 'bob', 'SSH timeouts')

function forbidden(data: unknown) {
  return Object.assign(new Error('Request failed with status code 403'), { isAxiosError: true, response: { status: 403, data } })
}

function signedInWith(permissions: string[]) {
  useCapabilitiesStore.setState({ capabilities: { version: '1.0', license_tier: 'enterprise', features: [] }, permissions })
}

async function renderEditor(expand?: string) {
  render(<SessionContextEditor deviceId={DEVICE} currentUser="alice" initialExpandedId={expand} />)
  await screen.findByText('Device Context')
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  http.get.mockResolvedValue({ data: [mine, theirs] })
  showToast.mockReset()
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  useCapabilitiesStore.setState({ capabilities: null, permissions: [] })
})

describe('Team Knowledge editor permissions (enterprise)', () => {
  it('a viewer (no devices.manage) gets no Add', async () => {
    signedInWith(['devices.view'])
    await renderEditor()
    expect(screen.queryByRole('button', { name: '+ Add Context' })).toBeNull()
  })

  it('devices.manage can add', async () => {
    signedInWith(['devices.manage'])
    await renderEditor()
    expect(screen.getByRole('button', { name: '+ Add Context' })).toBeInTheDocument()
  })

  it('edits and deletes only the user\'s own entries', async () => {
    signedInWith(['devices.manage'])
    await renderEditor('c2')
    expect(await screen.findByText('SSH timeouts cause')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()

    cleanup()
    await renderEditor('c1')
    expect(await screen.findByText('Uplink flapping cause')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it.each([['system.manage'], ['*']])('an org admin (%s) can edit and delete anyone\'s entry', async (permission) => {
    signedInWith([permission])
    await renderEditor('c2')
    expect(await screen.findByText('SSH timeouts cause')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('a refused add (403) says why', async () => {
    signedInWith(['devices.manage'])
    http.post.mockRejectedValueOnce(forbidden({ error: 'Insufficient permissions' }))
    await renderEditor()
    fireEvent.click(screen.getByRole('button', { name: '+ Add Context' }))
    fireEvent.change(screen.getByPlaceholderText('Brief description of the issue or topic'), { target: { value: 'Fan failure' } })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: 'Add Context' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('You need permission to manage devices to add Team Knowledge.', 'error'))
  })

  it('a refused delete (403, plain-text body) says why and keeps the entry', async () => {
    signedInWith(['devices.manage'])
    http.delete.mockRejectedValueOnce(forbidden('Forbidden'))
    await renderEditor('c1')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Only the author or an administrator can delete this entry.', 'error'))
    expect(screen.getByText('Uplink flapping')).toBeInTheDocument()
  })
})
