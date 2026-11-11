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

import {
  deviceEnrichmentDetails, connectionCreateRequest, updateDevice,
  toConnectionUpdateRequest, toDeviceUpdateRequest, saveConnectionUpdate, saveDeviceUpdate,
  getTopology, TopologyUpdateError, CONNECTION_UPDATE_FIELDS,
} from '../topology'
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

// ── Update conversion layer (camelCase -> both backends' snake_case) ──

/**
 * Field names of the backends' UpdateConnectionRequest structs, copied from
 * agent/src/models.rs and controller crates/models/src/topology.rs. They are
 * identical; neither has `status`.
 */
const AGENT_CONNECTION_UPDATE_FIELDS = [
  'source_interface', 'target_interface', 'label', 'waypoints', 'curve_style', 'bundle_id',
  'bundle_index', 'color', 'line_style', 'line_width', 'notes',
]
const CONTROLLER_CONNECTION_UPDATE_FIELDS = AGENT_CONNECTION_UPDATE_FIELDS

/** Every mutable connection field with a non-default value. */
const CONNECTION_FIELD_VALUES: Partial<Connection> = {
  sourceInterface: 'Gi0/9',
  targetInterface: 'Te1/0/1',
  label: 'core uplink',
  waypoints: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
  curveStyle: 'curved',
  bundleId: 'po1',
  bundleIndex: 2,
  color: '#00ff00',
  lineStyle: 'dotted',
  lineWidth: 4,
  notes: 'circuit 123',
}

/** Minimal backend: stores a connection row and applies snake_case updates. */
function fakeBackend() {
  const row: Record<string, unknown> = {
    id: 'c1', topology_id: 't1', source_device_id: 'a', target_device_id: 'b',
    protocol: 'manual', created_at: '2026-01-01T00:00:00Z',
  }
  http.put.mockImplementation(async (url: string, body: Record<string, unknown>) => {
    if (url.includes('/connections/')) {
      for (const [k, v] of Object.entries(body)) {
        // serde ignores unknown keys — mimic that so a wrong key is lost
        if (AGENT_CONNECTION_UPDATE_FIELDS.includes(k)) row[k] = v
      }
    }
    return { data: null }
  })
  http.get.mockImplementation(async () => ({
    data: {
      id: 't1', name: 'T', created_at: '', updated_at: '',
      devices: [], connections: [row],
    },
  }))
  return row
}

describe('connection update conversion', () => {
  beforeEach(() => vi.clearAllMocks())

  it('covers exactly the fields both backends store', () => {
    const wire = Object.values(CONNECTION_UPDATE_FIELDS).map(f => f.wire).sort()
    expect(wire).toEqual([...AGENT_CONNECTION_UPDATE_FIELDS].sort())
    expect(wire).toEqual([...CONTROLLER_CONNECTION_UPDATE_FIELDS].sort())
    expect(Object.keys(CONNECTION_FIELD_VALUES).sort()).toEqual(Object.keys(CONNECTION_UPDATE_FIELDS).sort())
  })

  it('maps every camelCase field to snake_case (waypoints as JSON)', () => {
    const conv = toConnectionUpdateRequest(CONNECTION_FIELD_VALUES, 'standalone')
    expect(conv.request).toEqual({
      source_interface: 'Gi0/9', target_interface: 'Te1/0/1', label: 'core uplink',
      waypoints: JSON.stringify([{ x: 10, y: 20 }, { x: 30, y: 40 }]), curve_style: 'curved',
      bundle_id: 'po1', bundle_index: 2, color: '#00ff00', line_style: 'dotted', line_width: 4, notes: 'circuit 123',
    })
    expect(conv.unknown).toEqual([])
    expect(conv.invalid).toEqual([])
    expect(conv.notPersisted).toEqual([])
    expect(toConnectionUpdateRequest(CONNECTION_FIELD_VALUES, 'enterprise').request).toEqual(conv.request)
  })

  for (const [field, value] of Object.entries(CONNECTION_FIELD_VALUES)) {
    it(`round-trips ${field} through save + reload`, async () => {
      fakeBackend()
      const saved = await saveConnectionUpdate('t1', 'c1', { [field]: value })
      expect(saved).toEqual({ persisted: [field], notPersisted: [] })
      const reloaded = await getTopology('t1')
      expect((reloaded.connections[0] as unknown as Record<string, unknown>)[field]).toEqual(value)
    })
  }

  it('reports status as not persisted and sends nothing for it', async () => {
    fakeBackend()
    const saved = await saveConnectionUpdate('t1', 'c1', { status: 'degraded', label: 'x' })
    expect(saved).toEqual({ persisted: ['label'], notPersisted: ['status'] })
    expect(http.put).toHaveBeenCalledWith('/topologies/t1/connections/c1', { label: 'x' })
  })

  it('skips the PUT when only view-only fields change', async () => {
    fakeBackend()
    const saved = await saveConnectionUpdate('t1', 'c1', { status: 'inactive' })
    expect(saved.persisted).toEqual([])
    expect(http.put).not.toHaveBeenCalled()
  })

  it('rejects unknown fields and bad values before sending, listing valid fields', async () => {
    await expect(saveConnectionUpdate('t1', 'c1', { bogus: 1 })).rejects.toThrow(/unknown field\(s\): bogus.*Valid fields: sourceInterface/)
    await expect(saveConnectionUpdate('t1', 'c1', { lineWidth: 2.5 })).rejects.toThrow(/lineWidth must be an integer/)
    await expect(saveConnectionUpdate('t1', 'c1', { curveStyle: 'wiggly' })).rejects.toThrow(TopologyUpdateError)
    await expect(saveConnectionUpdate('t1', 'c1', { waypoints: [{ x: 1 }] })).rejects.toThrow(/waypoints/)
    expect(http.put).not.toHaveBeenCalled()
  })
})

describe('device update conversion', () => {
  beforeEach(() => vi.clearAllMocks())

  it('only sends name to the Controller and profile IDs to the agent', () => {
    const updates = { name: 'core-1', profileId: 'p1', snmpProfileId: 's1', site: 'DC1', type: 'switch' as const }
    const agent = toDeviceUpdateRequest(updates, 'standalone')
    expect(agent.request).toEqual({ profile_id: 'p1', snmp_profile_id: 's1', site: 'DC1', device_type: 'switch' })
    expect(agent.notPersisted).toEqual(['name'])
    const controller = toDeviceUpdateRequest(updates, 'enterprise')
    expect(controller.request).toEqual({ name: 'core-1', site: 'DC1', device_type: 'switch' })
    expect(controller.notPersisted.sort()).toEqual(['profileId', 'snmpProfileId'])
  })

  it('maps primaryIp and rejects non-detail fields', async () => {
    expect(toDeviceUpdateRequest({ primaryIp: '10.0.0.1' }, 'standalone').request).toEqual({ primary_ip: '10.0.0.1' })
    await expect(saveDeviceUpdate('t1', 'd1', { x: 5 })).rejects.toThrow(/unknown field\(s\): x/)
    await expect(saveDeviceUpdate('t1', 'd1', { status: 'sleepy' })).rejects.toThrow(/status must be one of/)
    expect(http.put).not.toHaveBeenCalled()
  })

  it('saves through the details route in standalone mode', async () => {
    const saved = await saveDeviceUpdate('t1', 'd1', { site: 'DC2', name: 'r9' })
    expect(http.put).toHaveBeenCalledWith('/topologies/t1/devices/d1/details', { site: 'DC2' })
    expect(saved).toEqual({ persisted: ['site'], notPersisted: ['name'] })
  })
})
