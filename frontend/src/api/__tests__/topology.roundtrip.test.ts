import { beforeEach, describe, expect, it, vi } from 'vitest'

const http = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  post: vi.fn(),
}

vi.mock('../client', () => ({
  getClient: () => ({ http }),
  getCurrentMode: () => 'standalone',
}))

import { deviceEnrichmentDetails, connectionCreateRequest, updateDevice } from '../topology'
import type { Device, Connection } from '../../types/topology'

function dev(over: Partial<Device> = {}): Device {
  return { id: 'd1', name: 'r1', type: 'router', status: 'unknown', x: 0, y: 0, ...over }
}

describe('deviceEnrichmentDetails', () => {
  it('returns null when there is nothing beyond what addNeighborDevice carries', () => {
    expect(deviceEnrichmentDetails(dev({ primaryIp: '10.0.0.1', profileId: 'p' }))).toBeNull()
  })

  it('carries enrichment + status + neighbor marker', () => {
    expect(deviceEnrichmentDetails(dev({
      status: 'online', site: 'DC1', role: 'core', platform: 'IOS-XE', vendor: 'Cisco',
      version: '17.3', model: 'C9300', serial: 'ABC', uptime: '3d', isNeighbor: true,
    }))).toEqual({
      status: 'online', site: 'DC1', role: 'core', platform: 'IOS-XE', vendor: 'Cisco',
      version: '17.3', model: 'C9300', serial: 'ABC', uptime: '3d', notes: 'discovery:neighbor',
    })
  })

  it('prefers explicit notes over the neighbor marker', () => {
    expect(deviceEnrichmentDetails(dev({ notes: 'hand-written', isNeighbor: true }))).toEqual({ notes: 'hand-written' })
  })
})

describe('connectionCreateRequest', () => {
  const map = new Map([['a', 'A'], ['b', 'B']])
  const conn: Connection = {
    id: 'c1', sourceDeviceId: 'a', targetDeviceId: 'b', status: 'active',
    sourceInterface: 'Gi0/1', targetInterface: 'Gi0/2', label: 'uplink',
    waypoints: [{ x: 1, y: 2 }], curveStyle: 'orthogonal', bundleId: 'bn', bundleIndex: 1,
    color: '#f00', lineStyle: 'dashed', lineWidth: 3, notes: 'n',
  }

  it('remaps IDs and carries routing/styling', () => {
    expect(connectionCreateRequest(conn, map)).toEqual({
      source_device_id: 'A', target_device_id: 'B',
      source_interface: 'Gi0/1', target_interface: 'Gi0/2', label: 'uplink',
      waypoints: JSON.stringify([{ x: 1, y: 2 }]), curve_style: 'orthogonal',
      bundle_id: 'bn', bundle_index: 1, color: '#f00', line_style: 'dashed', line_width: 3, notes: 'n',
    })
  })

  it('returns null when an endpoint was not saved', () => {
    expect(connectionCreateRequest({ ...conn, targetDeviceId: 'zzz' }, map)).toBeNull()
  })

  it('omits waypoints when empty', () => {
    expect(connectionCreateRequest({ ...conn, waypoints: [] }, map)?.waypoints).toBeUndefined()
  })
})

describe('updateDevice', () => {
  beforeEach(() => vi.clearAllMocks())

  it('translates frontend `type` to the agent field `device_type`', async () => {
    await updateDevice('t1', 'd1', { type: 'switch', name: 'sw1' })
    expect(http.put).toHaveBeenCalledWith('/topologies/t1/devices/d1/details', { name: 'sw1', device_type: 'switch' })
  })

  it('leaves an explicit device_type alone', async () => {
    await updateDevice('t1', 'd1', { type: 'switch', device_type: 'firewall' })
    expect(http.put).toHaveBeenCalledWith('/topologies/t1/devices/d1/details', { device_type: 'firewall' })
  })
})
