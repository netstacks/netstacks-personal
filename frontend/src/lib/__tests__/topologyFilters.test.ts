import { describe, it, expect } from 'vitest'
import { isDeviceVisible, filterTopology } from '../topologyFilters'
import { DEFAULT_DEVICE_FILTERS } from '../../types/topology'
import type { Device, Topology, DeviceFilterState } from '../../types/topology'

function dev(id: string, over: Partial<Device> = {}): Device {
  return { id, name: id, type: 'switch', status: 'online', x: 0, y: 0, ...over }
}

describe('isDeviceVisible', () => {
  it('shows everything with default filters', () => {
    expect(isDeviceVisible(dev('a'), DEFAULT_DEVICE_FILTERS)).toBe(true)
    expect(isDeviceVisible(dev('n', { isNeighbor: true }), DEFAULT_DEVICE_FILTERS)).toBe(true)
  })

  it('hides neighbors when neighbors toggle is off', () => {
    const f: DeviceFilterState = { discovery: { managed: true, neighbors: false }, status: { online: true, warning: true, offline: true, unknown: true } }
    expect(isDeviceVisible(dev('n', { isNeighbor: true }), f)).toBe(false)
    expect(isDeviceVisible(dev('m'), f)).toBe(true)
  })

  it('hides managed when managed toggle is off', () => {
    const f: DeviceFilterState = { discovery: { managed: false, neighbors: true }, status: { online: true, warning: true, offline: true, unknown: true } }
    expect(isDeviceVisible(dev('m'), f)).toBe(false)
    expect(isDeviceVisible(dev('n', { isNeighbor: true }), f)).toBe(true)
  })

  it('hides by status axis independently', () => {
    const f: DeviceFilterState = { discovery: { managed: true, neighbors: true }, status: { online: false, warning: true, offline: true, unknown: true } }
    expect(isDeviceVisible(dev('a', { status: 'online' }), f)).toBe(false)
    expect(isDeviceVisible(dev('b', { status: 'offline' }), f)).toBe(true)
  })

  it('requires BOTH axes to pass', () => {
    const f: DeviceFilterState = { discovery: { managed: true, neighbors: false }, status: { online: false, warning: true, offline: true, unknown: true } }
    // neighbor + online: fails both
    expect(isDeviceVisible(dev('x', { isNeighbor: true, status: 'online' }), f)).toBe(false)
  })
})

describe('filterTopology', () => {
  const topo: Topology = {
    id: 't', name: 't', source: 'manual', createdAt: '', updatedAt: '',
    devices: [dev('a'), dev('b', { isNeighbor: true }), dev('c')],
    connections: [
      { id: 'ab', sourceDeviceId: 'a', targetDeviceId: 'b', status: 'active' },
      { id: 'ac', sourceDeviceId: 'a', targetDeviceId: 'c', status: 'active' },
    ],
  }

  it('drops hidden devices and connections touching them', () => {
    const f: DeviceFilterState = { discovery: { managed: true, neighbors: false }, status: { online: true, warning: true, offline: true, unknown: true } }
    const out = filterTopology(topo, f)
    expect(out.devices.map(d => d.id).sort()).toEqual(['a', 'c'])
    // 'ab' touches hidden 'b' -> dropped; 'ac' survives
    expect(out.connections.map(c => c.id)).toEqual(['ac'])
  })

  it('does not mutate the input', () => {
    const f: DeviceFilterState = { discovery: { managed: true, neighbors: false }, status: { online: true, warning: true, offline: true, unknown: true } }
    filterTopology(topo, f)
    expect(topo.devices.length).toBe(3)
    expect(topo.connections.length).toBe(2)
  })

  it('returns everything with defaults', () => {
    const out = filterTopology(topo, DEFAULT_DEVICE_FILTERS)
    expect(out.devices.length).toBe(3)
    expect(out.connections.length).toBe(2)
  })
})
