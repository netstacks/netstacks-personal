import { describe, it, expect, vi } from 'vitest'
import { executeHistoryAction } from '../topologyHistoryActions'
import type { TopologyAction } from '../../types/topologyHistory'
import type { Topology } from '../../types/topology'

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
    ],
    connections: [],
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

const bulkAction: TopologyAction = {
  id: 'x', type: 'bulk', timestamp: new Date(), source: 'user',
  description: 'Auto-layout: grid',
  data: {
    before: [
      { deviceId: 'a', x: 10, y: 10 },
      { deviceId: 'b', x: 20, y: 20 },
    ],
    after: [
      { deviceId: 'a', x: 100, y: 100 },
      { deviceId: 'b', x: 200, y: 200 },
    ],
    context: { topologyId: 't1' },
  },
}

describe('executeHistoryAction — bulk', () => {
  it('redo applies after positions to all listed devices', async () => {
    const topo = makeTopology()
    const box: { captured: Topology | null } = { captured: null }
    await executeHistoryAction(bulkAction, 'redo', {
      topologyId: 't1',
      isTemporary: true,
      setTopology: applySetState(topo, box) as never,
    })
    expect(box.captured!.devices.find(d => d.id === 'a')).toMatchObject({ x: 100, y: 100 })
    expect(box.captured!.devices.find(d => d.id === 'b')).toMatchObject({ x: 200, y: 200 })
  })

  it('undo applies before positions to all listed devices', async () => {
    const topo = { ...makeTopology(), devices: [
      { id: 'a', name: 'a', type: 'router' as const, status: 'online' as const, x: 100, y: 100 },
      { id: 'b', name: 'b', type: 'switch' as const, status: 'online' as const, x: 200, y: 200 },
    ] }
    const box: { captured: Topology | null } = { captured: null }
    await executeHistoryAction(bulkAction, 'undo', {
      topologyId: 't1',
      isTemporary: true,
      setTopology: applySetState(topo, box) as never,
    })
    expect(box.captured!.devices.find(d => d.id === 'a')).toMatchObject({ x: 10, y: 10 })
    expect(box.captured!.devices.find(d => d.id === 'b')).toMatchObject({ x: 20, y: 20 })
  })
})
