import { describe, it, expect, vi } from 'vitest'
import { executeHistoryAction } from '../topologyHistoryActions'
import type { TopologyAction } from '../../types/topologyHistory'
import type { Topology } from '../../types/topology'
import * as topologyApi from '../../api/topology'

vi.mock('../../api/topology', () => ({
  updateDevicePosition: vi.fn().mockResolvedValue(undefined),
  createConnection: vi.fn().mockResolvedValue(undefined),
  deleteConnection: vi.fn().mockResolvedValue(undefined),
  deleteDevice: vi.fn().mockResolvedValue(undefined),
}))

function makeTopology(): Topology {
  return {
    id: 't1',
    name: 't',
    source: 'manual',
    createdAt: '',
    updatedAt: '',
    devices: [
      { id: 'a', name: 'a', type: 'router', status: 'online', x: 10, y: 10 },
      { id: 'b', name: 'b', type: 'switch', status: 'online', x: 20, y: 20 },
      { id: 'c', name: 'c', type: 'firewall', status: 'online', x: 30, y: 30 },
      { id: 'd', name: 'd', type: 'server', status: 'online', x: 40, y: 40 },
    ],
    connections: [
      { id: 'c1', sourceDeviceId: 'a', targetDeviceId: 'b', sourceInterface: 'eth0', targetInterface: 'eth1' },
      { id: 'c2', sourceDeviceId: 'c', targetDeviceId: 'd', sourceInterface: 'eth2', targetInterface: 'eth3' },
    ],
  }
}

/** Run a setState updater against a captured topology, return the result. */
function applySetState(current: Topology, deps: { captured: Topology | null }) {
  return (updater: unknown) => {
    const next = typeof updater === 'function'
      ? (updater as (p: Topology) => Topology)(current)
      : (updater as Topology)
    deps.captured = next
  }
}

const bulkRemoveAction: TopologyAction = {
  id: 'x',
  type: 'bulk_remove',
  timestamp: new Date(),
  source: 'user',
  description: 'Delete selected devices',
  data: {
    before: {
      devices: [
        { id: 'a', name: 'a', type: 'router', status: 'online', x: 10, y: 10 },
        { id: 'b', name: 'b', type: 'switch', status: 'online', x: 20, y: 20 },
      ],
      connections: [
        { id: 'c1', sourceDeviceId: 'a', targetDeviceId: 'b', sourceInterface: 'eth0', targetInterface: 'eth1' },
      ],
    },
    after: null,
    context: { topologyId: 't1' },
  },
}

describe('executeHistoryAction — bulk_remove', () => {
  it('redo removes listed devices and their connections from state', async () => {
    const topo = makeTopology()
    const box: { captured: Topology | null } = { captured: null }
    await executeHistoryAction(bulkRemoveAction, 'redo', {
      topologyId: 't1',
      isTemporary: true,
      setTopology: applySetState(topo, box) as never,
    })

    // Devices a and b should be removed; c and d should remain
    expect(box.captured!.devices).toHaveLength(2)
    expect(box.captured!.devices.find(d => d.id === 'c')).toBeDefined()
    expect(box.captured!.devices.find(d => d.id === 'd')).toBeDefined()

    // Connection c1 (in before.connections) should be removed
    // Connection c2 should remain (not in before.connections and doesn't reference removed devices)
    expect(box.captured!.connections).toHaveLength(1)
    expect(box.captured!.connections[0].id).toBe('c2')
  })

  it('redo calls deleteDevice for each removed device when not temporary', async () => {
    const topo = makeTopology()
    const box: { captured: Topology | null } = { captured: null }
    const deleteDeviceMock = vi.mocked(topologyApi.deleteDevice)
    deleteDeviceMock.mockClear()

    await executeHistoryAction(bulkRemoveAction, 'redo', {
      topologyId: 't1',
      isTemporary: false,
      setTopology: applySetState(topo, box) as never,
    })

    expect(deleteDeviceMock).toHaveBeenCalledTimes(2)
    expect(deleteDeviceMock).toHaveBeenCalledWith('t1', 'a')
    expect(deleteDeviceMock).toHaveBeenCalledWith('t1', 'b')
  })

  it('undo restores devices and connections to state', async () => {
    const topo = {
      ...makeTopology(),
      devices: [
        { id: 'c', name: 'c', type: 'firewall' as const, status: 'online' as const, x: 30, y: 30 },
        { id: 'd', name: 'd', type: 'server' as const, status: 'online' as const, x: 40, y: 40 },
      ],
      connections: [{ id: 'c2', sourceDeviceId: 'c', targetDeviceId: 'd', sourceInterface: 'eth2', targetInterface: 'eth3' }],
    }
    const box: { captured: Topology | null } = { captured: null }

    await executeHistoryAction(bulkRemoveAction, 'undo', {
      topologyId: 't1',
      isTemporary: true,
      setTopology: applySetState(topo, box) as never,
    })

    // Devices a and b should be restored
    expect(box.captured!.devices).toHaveLength(4)
    expect(box.captured!.devices.find(d => d.id === 'a')).toMatchObject({ id: 'a', name: 'a', type: 'router' })
    expect(box.captured!.devices.find(d => d.id === 'b')).toMatchObject({ id: 'b', name: 'b', type: 'switch' })

    // Connection c1 should be restored
    expect(box.captured!.connections).toHaveLength(2)
    expect(box.captured!.connections.find(c => c.id === 'c1')).toMatchObject({ id: 'c1', sourceDeviceId: 'a', targetDeviceId: 'b' })
  })
})
