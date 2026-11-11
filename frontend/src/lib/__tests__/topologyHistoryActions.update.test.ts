import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeHistoryAction } from '../topologyHistoryActions'
import type { TopologyAction } from '../../types/topologyHistory'
import type { Topology, Device, Connection } from '../../types/topology'

const saveDeviceUpdate = vi.fn().mockResolvedValue({ persisted: [], notPersisted: [] })
const saveConnectionUpdate = vi.fn().mockResolvedValue({ persisted: [], notPersisted: [] })

vi.mock('../../api/topology', () => ({
  updateDevicePosition: vi.fn().mockResolvedValue(undefined),
  createConnection: vi.fn().mockResolvedValue(undefined),
  deleteConnection: vi.fn().mockResolvedValue(undefined),
  deleteDevice: vi.fn().mockResolvedValue(undefined),
  saveDeviceUpdate: (...args: unknown[]) => saveDeviceUpdate(...args),
  saveConnectionUpdate: (...args: unknown[]) => saveConnectionUpdate(...args),
  // Only `status` is local-only in these fixtures; everything else saves.
  toDeviceUpdateRequest: (p: Record<string, unknown>) => ({
    unknown: Object.keys(p).filter(k => k === 'status'), invalid: [],
  }),
  toConnectionUpdateRequest: (p: Record<string, unknown>) => ({
    unknown: Object.keys(p).filter(k => k === 'status'), invalid: [],
  }),
}))

const deviceBefore: Device = { id: 'a', name: 'core-1', type: 'router', status: 'online', x: 10, y: 10 }
// The AI changed the name and status; the user later moved the device.
const deviceAfter: Device = { ...deviceBefore, name: 'core-01', status: 'warning' }

const connBefore: Connection = {
  id: 'c1', sourceDeviceId: 'a', targetDeviceId: 'b', sourceInterface: 'Gi0/1', label: 'uplink',
} as Connection
const connAfter: Connection = { ...connBefore, sourceInterface: 'Te1/0/1', label: 'core uplink' } as Connection

function topology(device: Device, conn: Connection): Topology {
  return {
    id: 't1', name: 't', source: 'manual', createdAt: '', updatedAt: '',
    devices: [{ ...device, x: 500, y: 500 }],
    connections: [conn],
  }
}

function runner(start: Topology) {
  const box: { current: Topology } = { current: start }
  const setTopology = (updater: unknown) => {
    box.current = typeof updater === 'function'
      ? (updater as (p: Topology) => Topology)(box.current)
      : (updater as Topology)
  }
  return { box, setTopology: setTopology as never }
}

const deviceAction: TopologyAction = {
  id: 'u1', type: 'update_device', timestamp: new Date(), source: 'ai',
  description: 'Updated device core-1',
  data: { before: deviceBefore, after: deviceAfter, context: { topologyId: 't1', deviceId: 'a' } },
}

const connAction: TopologyAction = {
  id: 'u2', type: 'update_connection', timestamp: new Date(), source: 'ai',
  description: 'Updated connection',
  data: { before: connBefore, after: connAfter, context: { topologyId: 't1', connectionId: 'c1' } },
}

describe('executeHistoryAction — AI updates', () => {
  beforeEach(() => {
    saveDeviceUpdate.mockClear()
    saveConnectionUpdate.mockClear()
  })

  it('undo of a device update restores only the changed fields and saves the persistable ones', async () => {
    const { box, setTopology } = runner(topology(deviceAfter, connBefore))
    await executeHistoryAction(deviceAction, 'undo', { topologyId: 't1', isTemporary: false, setTopology })

    const d = box.current.devices[0]
    expect(d.name).toBe('core-1')
    expect(d.status).toBe('online')
    // a later, unrelated change (position) survives the undo
    expect(d.x).toBe(500)
    // status is local-only, so it is restored on screen but not sent
    expect(saveDeviceUpdate).toHaveBeenCalledWith('t1', 'a', { name: 'core-1' })
  })

  it('redo of a device update re-applies it', async () => {
    const { box, setTopology } = runner(topology(deviceBefore, connBefore))
    await executeHistoryAction(deviceAction, 'redo', { topologyId: 't1', isTemporary: false, setTopology })
    expect(box.current.devices[0].name).toBe('core-01')
    expect(saveDeviceUpdate).toHaveBeenCalledWith('t1', 'a', { name: 'core-01' })
  })

  it('undo of a connection update restores and saves the changed fields', async () => {
    const { box, setTopology } = runner(topology(deviceBefore, connAfter))
    await executeHistoryAction(connAction, 'undo', { topologyId: 't1', isTemporary: false, setTopology })
    expect(box.current.connections[0]).toMatchObject({ sourceInterface: 'Gi0/1', label: 'uplink' })
    expect(saveConnectionUpdate).toHaveBeenCalledWith('t1', 'c1', { sourceInterface: 'Gi0/1', label: 'uplink' })
  })

  it('temporary topologies update the view without saving', async () => {
    const { box, setTopology } = runner(topology(deviceAfter, connBefore))
    await executeHistoryAction(deviceAction, 'undo', { topologyId: 't1', isTemporary: true, setTopology })
    expect(box.current.devices[0].name).toBe('core-1')
    expect(saveDeviceUpdate).not.toHaveBeenCalled()
  })
})
