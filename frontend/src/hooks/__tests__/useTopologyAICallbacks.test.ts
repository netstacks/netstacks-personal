import { describe, expect, it, vi } from 'vitest'

vi.mock('../../api/client', () => ({
  getClient: () => ({ http: {} }),
  getCurrentMode: () => 'standalone',
}))

import { toDeviceUpdateRequest } from '../useTopologyAICallbacks'

describe('toDeviceUpdateRequest', () => {
  it('maps camelCase Device fields to the agent snake_case details struct', () => {
    const { request, dropped } = toDeviceUpdateRequest({
      name: 'core-1', type: 'switch', status: 'online', site: 'DC1', role: 'core',
      primaryIp: '10.0.0.1', profileId: 'p1', snmpProfileId: 's1', platform: 'EOS', notes: 'n',
    })
    expect(request).toEqual({
      name: 'core-1', device_type: 'switch', status: 'online', site: 'DC1', role: 'core',
      primary_ip: '10.0.0.1', profile_id: 'p1', snmp_profile_id: 's1', platform: 'EOS', notes: 'n',
    })
    expect(dropped).toEqual([])
  })

  it('drops keys the agent does not persist and reports them', () => {
    const { request, dropped } = toDeviceUpdateRequest({
      x: 100, y: 200, id: 'nope', sessionId: 's', netboxId: 4, isNeighbor: true, metadata: { a: 'b' }, name: 'ok',
    })
    expect(request).toEqual({ name: 'ok' })
    expect(dropped.sort()).toEqual(['id', 'isNeighbor', 'metadata', 'netboxId', 'sessionId', 'x', 'y'])
  })

  it('skips undefined values without reporting them', () => {
    const { request, dropped } = toDeviceUpdateRequest({ name: undefined, site: 'X' })
    expect(request).toEqual({ site: 'X' })
    expect(dropped).toEqual([])
  })
})
