import { describe, it, expect } from 'vitest'
import { computeLayout } from '../topologyLayout'
import type { Device, Connection } from '../../types/topology'

/** Build n minimal devices at origin so layout has to move them. */
function makeDevices(n: number): Device[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `d${i}`,
    name: `Device-${i}`,
    type: 'switch' as const,
    status: 'unknown' as const,
    x: 0,
    y: 0,
  }))
}

const noConns: Connection[] = []

function allInBounds(pos: Map<string, { x: number; y: number }>): boolean {
  for (const { x, y } of pos.values()) {
    if (!(x >= 0 && x <= 1000 && y >= 0 && y <= 1000)) return false
    if (Number.isNaN(x) || Number.isNaN(y)) return false
  }
  return true
}

describe('computeLayout — grid', () => {
  it('returns a position for every device, all in bounds', () => {
    const devices = makeDevices(10)
    const pos = computeLayout('grid', devices, noConns)
    expect(pos.size).toBe(10)
    expect(allInBounds(pos)).toBe(true)
  })

  it('is deterministic', () => {
    const devices = makeDevices(7)
    const a = computeLayout('grid', devices, noConns)
    const b = computeLayout('grid', devices, noConns)
    expect([...a.entries()]).toEqual([...b.entries()])
  })

  it('does not stack all devices on one point', () => {
    const devices = makeDevices(9)
    const pos = computeLayout('grid', devices, noConns)
    const unique = new Set([...pos.values()].map(p => `${p.x},${p.y}`))
    expect(unique.size).toBe(9)
  })

  it('handles empty input', () => {
    expect(computeLayout('grid', [], noConns).size).toBe(0)
  })
})

describe('computeLayout — circular', () => {
  it('places every device in bounds', () => {
    const devices = makeDevices(6)
    const pos = computeLayout('circular', devices, noConns)
    expect(pos.size).toBe(6)
    expect(allInBounds(pos)).toBe(true)
  })

  it('single device goes to center', () => {
    const pos = computeLayout('circular', makeDevices(1), noConns)
    expect(pos.get('d0')).toEqual({ x: 500, y: 500 })
  })

  it('is deterministic', () => {
    const devices = makeDevices(8)
    const a = computeLayout('circular', devices, noConns)
    const b = computeLayout('circular', devices, noConns)
    expect([...a.entries()]).toEqual([...b.entries()])
  })
})

describe('computeLayout — hierarchical', () => {
  it('places every device in bounds and puts the root above its children', () => {
    // core router -> two access switches
    const devices: Device[] = [
      { id: 'r1', name: 'core', type: 'router', status: 'online', x: 0, y: 0 },
      { id: 's1', name: 'acc1', type: 'switch', status: 'online', x: 0, y: 0 },
      { id: 's2', name: 'acc2', type: 'switch', status: 'online', x: 0, y: 0 },
    ]
    const connections: Connection[] = [
      { id: 'c1', sourceDeviceId: 'r1', targetDeviceId: 's1', status: 'active' },
      { id: 'c2', sourceDeviceId: 'r1', targetDeviceId: 's2', status: 'active' },
    ]
    const pos = computeLayout('hierarchical', devices, connections)
    expect(pos.size).toBe(3)
    const root = pos.get('r1')!
    const child1 = pos.get('s1')!
    const child2 = pos.get('s2')!
    // Root is on a higher layer (smaller y) than its children.
    expect(root.y).toBeLessThan(child1.y)
    expect(root.y).toBeLessThan(child2.y)
    // In bounds.
    for (const p of [root, child1, child2]) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(1000)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(1000)
    }
  })

  it('handles disconnected nodes without NaN', () => {
    const devices: Device[] = [
      { id: 'a', name: 'a', type: 'router', status: 'online', x: 0, y: 0 },
      { id: 'b', name: 'b', type: 'switch', status: 'online', x: 0, y: 0 },
      { id: 'lonely', name: 'z', type: 'server', status: 'online', x: 0, y: 0 },
    ]
    const connections: Connection[] = [
      { id: 'c1', sourceDeviceId: 'a', targetDeviceId: 'b', status: 'active' },
    ]
    const pos = computeLayout('hierarchical', devices, connections)
    expect(pos.size).toBe(3)
    for (const { x, y } of pos.values()) {
      expect(Number.isNaN(x)).toBe(false)
      expect(Number.isNaN(y)).toBe(false)
    }
  })

  it('is deterministic', () => {
    const devices: Device[] = [
      { id: 'a', name: 'a', type: 'router', status: 'online', x: 0, y: 0 },
      { id: 'b', name: 'b', type: 'switch', status: 'online', x: 0, y: 0 },
    ]
    const connections: Connection[] = [
      { id: 'c1', sourceDeviceId: 'a', targetDeviceId: 'b', status: 'active' },
    ]
    const a = computeLayout('hierarchical', devices, connections)
    const b = computeLayout('hierarchical', devices, connections)
    expect([...a.entries()]).toEqual([...b.entries()])
  })
})

describe('computeLayout — forceDirected', () => {
  it('places every device in bounds', () => {
    const devices: Device[] = [
      { id: 'a', name: 'a', type: 'router', status: 'online', x: 100, y: 100 },
      { id: 'b', name: 'b', type: 'switch', status: 'online', x: 200, y: 200 },
      { id: 'c', name: 'c', type: 'switch', status: 'online', x: 300, y: 300 },
      { id: 'd', name: 'd', type: 'server', status: 'online', x: 400, y: 400 },
    ]
    const connections: Connection[] = [
      { id: 'c1', sourceDeviceId: 'a', targetDeviceId: 'b', status: 'active' },
      { id: 'c2', sourceDeviceId: 'b', targetDeviceId: 'c', status: 'active' },
      { id: 'c3', sourceDeviceId: 'c', targetDeviceId: 'd', status: 'active' },
    ]
    const pos = computeLayout('forceDirected', devices, connections)
    expect(pos.size).toBe(4)
    for (const { x, y } of pos.values()) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(1000)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(1000)
      expect(Number.isNaN(x)).toBe(false)
      expect(Number.isNaN(y)).toBe(false)
    }
  })

  it('is deterministic (seeded from current positions, no randomness)', () => {
    const devices: Device[] = [
      { id: 'a', name: 'a', type: 'router', status: 'online', x: 120, y: 340 },
      { id: 'b', name: 'b', type: 'switch', status: 'online', x: 610, y: 220 },
      { id: 'c', name: 'c', type: 'switch', status: 'online', x: 480, y: 700 },
    ]
    const connections: Connection[] = [
      { id: 'c1', sourceDeviceId: 'a', targetDeviceId: 'b', status: 'active' },
      { id: 'c2', sourceDeviceId: 'b', targetDeviceId: 'c', status: 'active' },
    ]
    const a = computeLayout('forceDirected', devices, connections)
    const b = computeLayout('forceDirected', devices, connections)
    expect([...a.entries()]).toEqual([...b.entries()])
  })

  it('separates two connected nodes that start on the same point', () => {
    const devices: Device[] = [
      { id: 'a', name: 'a', type: 'router', status: 'online', x: 500, y: 500 },
      { id: 'b', name: 'b', type: 'switch', status: 'online', x: 500, y: 500 },
    ]
    const connections: Connection[] = [
      { id: 'c1', sourceDeviceId: 'a', targetDeviceId: 'b', status: 'active' },
    ]
    const pos = computeLayout('forceDirected', devices, connections)
    const pa = pos.get('a')!
    const pb = pos.get('b')!
    const dist = Math.hypot(pa.x - pb.x, pa.y - pb.y)
    expect(dist).toBeGreaterThan(50)
  })
})
