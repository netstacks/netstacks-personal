import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { DeviceSummary } from '../../types/enterpriseDevice'

// The Controller's device summary carries the SSH port (the device profile's
// ssh_port, 22 when unset): the panel shows host:port and a device opened from
// it carries the port through to the connect.
const device = (over: Partial<DeviceSummary>): DeviceSummary => ({
  id: 'd1', org_id: 'o1', name: 'core-1', host: '172.18.0.8', port: 22, device_type: 'router',
  manufacturer: null, model: null, site: null, source: 'manual',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...over,
})
const devices = vi.hoisted(() => ({ items: [] as DeviceSummary[] }))
vi.mock('../../api/enterpriseDevices', () => ({
  listEnterpriseDevices: vi.fn(async () => ({ items: devices.items, total: devices.items.length, limit: 1000, offset: 0 })),
}))
vi.mock('../../api/client', () => ({ getCurrentMode: () => 'enterprise' }))

import EnterpriseDevicePanel from '../EnterpriseDevicePanel'

describe('enterprise device port', () => {
  it('shows host:port', async () => {
    devices.items = [device({}), device({ id: 'd2', name: 'edge-1', host: '172.18.0.9', port: 2222 })]
    render(<EnterpriseDevicePanel onDeviceConnect={vi.fn()} />)
    expect(await screen.findByTitle('Connect to 172.18.0.8:22')).toBeInTheDocument()
    expect(screen.getByTitle('Connect to 172.18.0.9:2222')).toBeInTheDocument()
    expect(screen.queryByText(/undefined/)).toBeNull()
  })

  it('hands the device, with its port, to the connect', async () => {
    devices.items = [device({ port: 2222 })]
    const onDeviceQuickConnect = vi.fn()
    render(<EnterpriseDevicePanel onDeviceConnect={vi.fn()} onDeviceQuickConnect={onDeviceQuickConnect} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    expect(onDeviceQuickConnect).toHaveBeenCalledWith(expect.objectContaining({ host: '172.18.0.8', port: 2222 }))
  })
})
