import { describe, it, expect } from 'vitest'
import { executeTopologyTool } from '../topologyAITools'
import type { TopologyAICallbacks } from '../topologyAITools'

describe('topology_analyze health surfaces live telemetry', () => {
  const baseTopology = {
    id: 't', devices: [
      { id: 'd1', name: 'r1', type: 'router', status: 'online', x: 0, y: 0 },
    ], connections: [],
  }

  it('reports devices/interfaces with errors when stats available', async () => {
    const cb = {
      getTopology: () => baseTopology,
      getDeviceById: (id: string) => baseTopology.devices.find(d => d.id === id),
      getConnectionById: () => undefined,
      getDeviceStats: () => ({
        host: '10.0.0.1', timestamp: '', sysUptimeSeconds: null, sysDescr: null,
        interfaceSummary: { total: 2, up: 1, down: 1, adminDown: 0, totalInErrors: 1200, totalOutErrors: 0, totalInDiscards: 0, totalOutDiscards: 0 },
        cpuPercent: null, memoryPercent: null, memoryUsedMB: null, memoryTotalMB: null,
        interfaces: [{ ifDescr: 'Gi0/1', ifAlias: 'uplink', operStatus: 1, adminStatus: 1, speedMbps: 1000, inOctets: 0, outOctets: 0, inErrors: 1200, outErrors: 0 }],
        healthScore: 40, healthColor: 'orange', maxUtilizationPercent: 10,
      }),
    } as unknown as TopologyAICallbacks

    const res = await executeTopologyTool('topology_analyze', { analysis_type: 'health' }, cb)
    expect(res.is_error).toBe(false)
    expect(res.content).toContain('r1')
    expect(res.content).toContain('1200')
    expect(res.content).toContain('Gi0/1')
  })

  it('reports unavailable when no live stats accessor', async () => {
    const cb = {
      getTopology: () => baseTopology,
      getDeviceById: (id: string) => baseTopology.devices.find(d => d.id === id),
      getConnectionById: () => undefined,
    } as unknown as TopologyAICallbacks
    const res = await executeTopologyTool('topology_analyze', { analysis_type: 'health' }, cb)
    expect(res.is_error).toBe(false)
    expect(res.content).toContain('not enabled')
  })
})
