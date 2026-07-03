import { describe, it, expect } from 'vitest'
import { useActiveTopologyStore } from '../activeTopologyStore'
import type { Topology } from '../../types/topology'

const topo = { id: 't1', devices: [], connections: [] } as unknown as Topology

describe('activeTopologyStore', () => {
  it('publishes then clears', () => {
    useActiveTopologyStore.getState().publish({ topology: topo, topologyId: 't1', isTemporary: false })
    expect(useActiveTopologyStore.getState().topologyId).toBe('t1')
    expect(useActiveTopologyStore.getState().topology).toBe(topo)

    useActiveTopologyStore.getState().clear()
    expect(useActiveTopologyStore.getState().topology).toBeNull()
    expect(useActiveTopologyStore.getState().topologyId).toBeUndefined()
  })

  it('publish replaces prior payload (no stale fields)', () => {
    const stubAction = () => ({ id: 'x', type: 'bulk', timestamp: new Date(), source: 'ai', description: 'd', data: { before: null, after: null } }) as const
    useActiveTopologyStore.getState().publish({ topology: topo, topologyId: 't1', pushAction: stubAction as never })
    expect(useActiveTopologyStore.getState().pushAction).toBeDefined()
    useActiveTopologyStore.getState().publish({ topology: topo, topologyId: 't2' })
    expect(useActiveTopologyStore.getState().pushAction).toBeUndefined()
    expect(useActiveTopologyStore.getState().topologyId).toBe('t2')
  })
})
