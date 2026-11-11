import { describe, it, expect, beforeEach } from 'vitest'
import { useActiveTopologyStore } from '../../stores/activeTopologyStore'
import { buildTopologySeed } from '../aiTopologySeed'
import type { Topology } from '../../types/topology'

const topo = {
  id: 't',
  devices: [
    { id: 'd1', name: 'r1', type: 'router', status: 'online', x: 0, y: 0 },
    { id: 'd2', name: 'sw1', type: 'switch', status: 'online', x: 1, y: 1 },
  ],
  connections: [
    { id: 'c1', sourceDeviceId: 'd1', targetDeviceId: 'd2', sourceInterface: 'Gi0/1', targetInterface: 'Gi1/1', status: 'active' },
  ],
} as unknown as Topology

describe('buildTopologySeed', () => {
  beforeEach(() => useActiveTopologyStore.getState().clear())

  it('map seed with no topology is graceful', () => {
    expect(buildTopologySeed('map').toLowerCase()).toContain('no topology')
  })

  it('map seed reports counts', () => {
    useActiveTopologyStore.getState().publish({ topology: topo, topologyId: 't' })
    const seed = buildTopologySeed('map')
    expect(seed).toContain('2 devices')
    expect(seed).toContain('1 link')
  })

  it('device seed names the device', () => {
    useActiveTopologyStore.getState().publish({ topology: topo, topologyId: 't' })
    expect(buildTopologySeed('device', 'd1')).toContain('r1')
  })

  it('link seed names both endpoints and interfaces', () => {
    useActiveTopologyStore.getState().publish({ topology: topo, topologyId: 't' })
    const seed = buildTopologySeed('link', 'c1')
    expect(seed).toContain('r1')
    expect(seed).toContain('sw1')
    expect(seed).toContain('Gi0/1')
  })
})
