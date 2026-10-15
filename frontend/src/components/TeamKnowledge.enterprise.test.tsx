import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { SessionContext } from '../types/sessionContext'

// A fake Controller: /sessions/:key/context resolves a definition linked to a
// device to that device (entries come back keyed `device-<uuid>`), like
// routes/session_context.rs resolve_context_ref.
const DEF_LINKED = '11111111-1111-1111-1111-111111111111'
const DEF_UNLINKED = '22222222-2222-2222-2222-222222222222'
const DEVICE = '33333333-3333-3333-3333-333333333333'

const entry = (id: string, sessionId: string, issue: string, root_cause: string): SessionContext => ({
  id, session_id: sessionId, issue, root_cause, resolution: null, commands: null, ticket_ref: null,
  author: 'netops', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
})
const deviceEntries = [entry('c1', `device-${DEVICE}`, 'Uplink flapping', 'Storm control')]
// A device's list can also hold entries keyed on a linked definition's UUID.
const definitionKeyedEntry = entry('c3', DEF_LINKED, 'BGP flap after upgrade', 'Hold timer mismatch')
const unlinkedEntries = [entry('c2', DEF_UNLINKED, 'SSH idle timeouts', 'exec-timeout 5')]
const device = {
  id: DEVICE, org_id: 'o1', name: 'core-rtr-01', host: '10.0.0.1', port: 22, device_type: 'router',
  manufacturer: null, model: null, site: null, source: 'manual', created_at: '', updated_at: '',
}

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }))
vi.mock('../api/client', () => ({
  getClient: () => ({ mode: 'enterprise', http }),
  getCurrentMode: () => 'enterprise',
  isClientInitialized: () => true,
}))

import TeamKnowledge from './TeamKnowledge'
import EnterpriseContextDialog from './EnterpriseContextDialog'
import { sessionContextKey } from '../api/sessionContext'

const getCalls = () => http.get.mock.calls.map(([url]) => url as string)
const originalScrollIntoView = Element.prototype.scrollIntoView

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  http.get.mockImplementation(async (url: string) => {
    if (url === `/sessions/${DEF_LINKED}/context` || url === `/sessions/device-${DEVICE}/context`) return { data: deviceEntries }
    if (url === `/devices/${DEVICE}/context`) return { data: deviceEntries }
    if (url === `/sessions/${DEF_UNLINKED}/context`) return { data: unlinkedEntries }
    if (url === `/devices/browse/${DEVICE}`) return { data: { device, status: null, site: null } }
    throw new Error(`unexpected GET ${url}`)
  })
})

afterEach(() => {
  cleanup()
  http.get.mockReset()
  Element.prototype.scrollIntoView = originalScrollIntoView
})

describe('sessionContextKey', () => {
  it('uses the Controller target in enterprise and the saved session in standalone', () => {
    expect(sessionContextKey({ enterpriseSessionDefinitionId: DEF_LINKED }, true)).toBe(DEF_LINKED)
    expect(sessionContextKey({ enterpriseSessionDefinitionId: `device-${DEVICE}` }, true)).toBe(`device-${DEVICE}`)
    expect(sessionContextKey({ sessionId: 's1' }, false)).toBe('s1')
    expect(sessionContextKey({ sessionId: 's1' }, true)).toBeUndefined()
    expect(sessionContextKey({}, true)).toBeUndefined()
  })
})

describe('TeamKnowledge in enterprise', () => {
  const handlers = () => ({ onAnnounced: vi.fn(), onOpenEntry: vi.fn(), onAskAI: vi.fn() })

  it('lists a session-definition tab\'s knowledge by its definition id', async () => {
    const h = handlers()
    render(<TeamKnowledge sessionId={sessionContextKey({ enterpriseSessionDefinitionId: DEF_LINKED }, true)!} {...h} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Team Knowledge, 1 entry' }))
    fireEvent.click(screen.getByRole('button', { name: /Uplink flapping/ }))
    expect(getCalls()).toEqual([`/sessions/${DEF_LINKED}/context`])
    expect(h.onOpenEntry).toHaveBeenCalledWith(deviceEntries[0])
  })

  it('shows every entry the Controller lists, whatever its session_id', async () => {
    http.get.mockResolvedValueOnce({ data: [...deviceEntries, definitionKeyedEntry] })
    render(<TeamKnowledge sessionId={`device-${DEVICE}`} {...handlers()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Team Knowledge, 2 entries' }))
    expect(screen.getByRole('button', { name: /Uplink flapping/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /BGP flap after upgrade/ })).toBeInTheDocument()
  })

  it('lists a device tab\'s knowledge by device-<id>', async () => {
    render(<TeamKnowledge sessionId={sessionContextKey({ enterpriseSessionDefinitionId: `device-${DEVICE}` }, true)!} {...handlers()} />)
    expect(await screen.findByRole('button', { name: 'Team Knowledge, 1 entry' })).toBeInTheDocument()
    expect(getCalls()).toEqual([`/sessions/device-${DEVICE}/context`])
  })
})

describe('EnterpriseContextDialog', () => {
  it('opens a device-keyed entry in the device\'s Edit Device dialog on Context, entry expanded', async () => {
    render(<EnterpriseContextDialog context={deviceEntries[0]} sessionKey={DEF_LINKED} sessionName="core-rtr-01" onClose={vi.fn()} onError={vi.fn()} />)
    expect(await screen.findByText('Storm control')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Edit Device' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Context' })).toHaveClass('active')
    expect(getCalls()).toEqual([`/devices/browse/${DEVICE}`, `/devices/${DEVICE}/context`])
  })

  it('opens a definition-keyed entry listed for a device tab in that device\'s dialog', async () => {
    http.get.mockImplementation(async (url: string) => {
      if (url === `/devices/browse/${DEVICE}`) return { data: { device, status: null, site: null } }
      if (url === `/devices/${DEVICE}/context`) return { data: [...deviceEntries, definitionKeyedEntry] }
      throw new Error(`unexpected GET ${url}`)
    })
    render(<EnterpriseContextDialog context={definitionKeyedEntry} sessionKey={`device-${DEVICE}`} sessionName="core-rtr-01" onClose={vi.fn()} onError={vi.fn()} />)
    expect(await screen.findByText('Hold timer mismatch')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Edit Device' })).toBeInTheDocument()
  })

  it('opens an unlinked session definition\'s entry in its own Context editor', async () => {
    render(<EnterpriseContextDialog context={unlinkedEntries[0]} sessionKey={DEF_UNLINKED} sessionName="lab-sw-01" onClose={vi.fn()} onError={vi.fn()} />)
    expect(await screen.findByText('exec-timeout 5')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Context — lab-sw-01' })).toBeInTheDocument()
    expect(getCalls()).toEqual([`/sessions/${DEF_UNLINKED}/context`])
  })

  it('reports a device that cannot be loaded and closes', async () => {
    http.get.mockRejectedValueOnce(new Error('Device not found'))
    const onClose = vi.fn()
    const onError = vi.fn()
    render(<EnterpriseContextDialog context={deviceEntries[0]} sessionKey={DEF_LINKED} sessionName="core-rtr-01" onClose={onClose} onError={onError} />)
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(onError).toHaveBeenCalledWith('Device not found')
    expect(screen.queryByRole('heading', { name: 'Edit Device' })).toBeNull()
  })
})
