import { describe, expect, it, vi } from 'vitest'

vi.mock('../../api/client', () => ({
  getClient: () => ({ http: {} }),
  getCurrentMode: () => 'standalone',
}))

import {
  executeTopologyTool, getTopologyTools, buildAIAnnotationData, parseUpdatesArgument,
  TOPOLOGY_SYSTEM_PROMPT, type TopologyAICallbacks,
} from '../topologyAITools'
import { DEFAULT_TOPOLOGY_PROMPT } from '../../api/ai'
import type { Topology } from '../../types/topology'

const topology: Topology = {
  id: 't1', name: 'T', source: 'manual', createdAt: '', updatedAt: '',
  devices: [
    { id: 'a', name: 'core-1', type: 'router', status: 'online', x: 0, y: 0 },
    { id: 'b', name: 'edge-1', type: 'router', status: 'online', x: 10, y: 10 },
  ],
  connections: [{ id: 'c1', sourceDeviceId: 'a', targetDeviceId: 'b', status: 'active' }],
}

function callbacks(over: Partial<TopologyAICallbacks> = {}): TopologyAICallbacks {
  return {
    getTopology: () => topology,
    getDeviceById: id => topology.devices.find(d => d.id === id),
    getConnectionById: id => topology.connections.find(c => c.id === id),
    addDevice: vi.fn(),
    removeDevice: vi.fn(),
    updateDevice: vi.fn(async (id, u) => ({ item: { ...topology.devices.find(d => d.id === id)!, ...u }, persisted: Object.keys(u), notPersisted: [] })),
    moveDevice: vi.fn(),
    addConnection: vi.fn(),
    removeConnection: vi.fn(),
    updateConnection: vi.fn(async (id, u) => {
      const { status, ...rest } = u
      return {
        item: { ...topology.connections.find(c => c.id === id)!, ...u },
        persisted: Object.keys(rest),
        notPersisted: status !== undefined ? ['status'] : [],
      }
    }),
    ...over,
  }
}

const parse = (r: { content: string }) => JSON.parse(r.content) as Record<string, unknown>

describe('advertised topology tools', () => {
  it('omits annotate/highlight/export when no editor wires them', () => {
    const names = getTopologyTools(callbacks()).map(t => t.name)
    expect(names).not.toContain('topology_annotate')
    expect(names).not.toContain('topology_highlight')
    expect(names).not.toContain('topology_export')
    expect(names).toContain('topology_update')
  })

  it('lists them when the editor provides the callbacks', () => {
    const names = getTopologyTools(callbacks({
      addAnnotation: vi.fn(), setHighlights: vi.fn(), exportTopology: vi.fn(),
    })).map(t => t.name)
    expect(names).toEqual(expect.arrayContaining(['topology_annotate', 'topology_highlight', 'topology_export']))
  })

  it('declares topology_update.updates as an object', () => {
    const upd = getTopologyTools(callbacks()).find(t => t.name === 'topology_update')!
    expect(upd.input_schema.properties.updates.type).toBe('object')
    expect(upd.input_schema.properties.updates.description).toContain('sourceInterface')
  })

  it('prompts use analysis_type, not type', () => {
    for (const p of [TOPOLOGY_SYSTEM_PROMPT, DEFAULT_TOPOLOGY_PROMPT]) {
      expect(p).toContain("topology_analyze with analysis_type 'spof'")
      expect(p).not.toMatch(/topology_analyze with type/)
    }
  })
})

describe('topology_update', () => {
  it('accepts an object', async () => {
    const cb = callbacks()
    const res = await executeTopologyTool('topology_update', { item_type: 'connection', item_id: 'c1', updates: { label: 'uplink' } }, cb)
    expect(res.is_error).toBe(false)
    expect(cb.updateConnection).toHaveBeenCalledWith('c1', { label: 'uplink' })
    expect(parse(res).savedFields).toEqual(['label'])
  })

  it('accepts a JSON string and snake_case names', async () => {
    const cb = callbacks()
    const res = await executeTopologyTool('topology_update', {
      item_type: 'connection', item_id: 'c1', updates: '{"source_interface": "Gi0/1", "line_style": "dashed"}',
    }, cb)
    expect(res.is_error).toBe(false)
    expect(cb.updateConnection).toHaveBeenCalledWith('c1', { sourceInterface: 'Gi0/1', lineStyle: 'dashed' })
  })

  it('reports view-only fields instead of claiming they were saved', async () => {
    const res = await executeTopologyTool('topology_update', { item_type: 'connection', item_id: 'c1', updates: { status: 'degraded' } }, callbacks())
    const body = parse(res)
    expect(res.is_error).toBe(false)
    expect(body.savedFields).toEqual([])
    expect(body.notSavedFields).toEqual(['status'])
    expect(body.note).toMatch(/lost on reload/)
  })

  it('rejects bad JSON with a clear error', async () => {
    const cb = callbacks()
    const res = await executeTopologyTool('topology_update', { item_type: 'device', item_id: 'core-1', updates: '{"name": ' }, cb)
    expect(res.is_error).toBe(true)
    expect(parse(res).error).toMatch(/not valid JSON/)
    expect(cb.updateDevice).not.toHaveBeenCalled()
  })

  it('rejects unknown fields, listing the valid ones', async () => {
    const cb = callbacks()
    const res = await executeTopologyTool('topology_update', { item_type: 'connection', item_id: 'c1', updates: { speed: '10G' } }, cb)
    expect(res.is_error).toBe(true)
    expect(parse(res).error).toMatch(/unknown field\(s\): speed.*Valid fields: .*lineWidth/)
    expect(cb.updateConnection).not.toHaveBeenCalled()
  })

  it('rejects invalid values', async () => {
    const res = await executeTopologyTool('topology_update', { item_type: 'device', item_id: 'core-1', updates: { type: 'toaster' } }, callbacks())
    expect(res.is_error).toBe(true)
    expect(parse(res).error).toMatch(/type must be one of/)
  })

  it('parseUpdatesArgument rejects arrays and empty input', () => {
    expect(parseUpdatesArgument([1])).toHaveProperty('error')
    expect(parseUpdatesArgument('')).toHaveProperty('error')
    expect(parseUpdatesArgument({})).toHaveProperty('error')
    expect(parseUpdatesArgument('{"a":1}')).toEqual({ updates: { a: 1 } })
  })
})

describe('topology_annotate', () => {
  it('errors when no editor is wired', async () => {
    const res = await executeTopologyTool('topology_annotate', { annotation_type: 'text' }, callbacks())
    expect(res.is_error).toBe(true)
  })

  it('passes the requested position and content to the editor', async () => {
    const addAnnotation = vi.fn(async () => ({ id: 'n1', type: 'text' as const, persisted: true }))
    const res = await executeTopologyTool('topology_annotate', {
      annotation_type: 'text', content: 'DMZ', x: 120, y: 340, color: 'red',
    }, callbacks({ addAnnotation }))
    expect(res.is_error).toBe(false)
    expect(addAnnotation).toHaveBeenCalledWith(expect.objectContaining({ type: 'text', content: 'DMZ', x: 120, y: 340, color: 'red' }))
    expect(parse(res)).toMatchObject({ success: true, persisted: true })
  })

  it('validates coordinates', async () => {
    const addAnnotation = vi.fn()
    const res = await executeTopologyTool('topology_annotate', { annotation_type: 'shape', x: 5000 }, callbacks({ addAnnotation }))
    expect(res.is_error).toBe(true)
    expect(addAnnotation).not.toHaveBeenCalled()
  })

  it('surfaces a failed save as an error', async () => {
    const addAnnotation = vi.fn(async () => { throw new Error('backend down') })
    const res = await executeTopologyTool('topology_annotate', { annotation_type: 'text' }, callbacks({ addAnnotation }))
    expect(res.is_error).toBe(true)
    expect(parse(res).error).toBe('backend down')
  })

  it('buildAIAnnotationData builds real annotation payloads', () => {
    expect(buildAIAnnotationData({ type: 'text', x: 1, y: 2, content: 'hi' })).toMatchObject({ type: 'text', position: { x: 1, y: 2 }, content: 'hi', fontSize: 14 })
    expect(buildAIAnnotationData({ type: 'shape', x: 1, y: 2, width: 50, height: 40 })).toMatchObject({ type: 'shape', shapeType: 'rectangle', size: { width: 50, height: 40 } })
    expect(buildAIAnnotationData({ type: 'line', x: 1, y: 2, x2: 9, y2: 8 })).toMatchObject({ type: 'line', points: [{ x: 1, y: 2 }, { x: 9, y: 8 }] })
  })
})

describe('topology_highlight', () => {
  it('errors when no editor is wired', async () => {
    const res = await executeTopologyTool('topology_highlight', { targets: ['core-1'], color: 'red' }, callbacks())
    expect(res.is_error).toBe(true)
  })

  it('resolves names to IDs and reports unresolved targets', async () => {
    const setHighlights = vi.fn(() => ({ visibleInCurrentView: true }))
    const res = await executeTopologyTool('topology_highlight', { targets: ['core-1', 'c1', 'nope'], color: 'red', label: 'path' }, callbacks({ setHighlights }))
    expect(res.is_error).toBe(false)
    expect(setHighlights).toHaveBeenCalledWith({ targets: ['a', 'c1'], color: 'red', label: 'path' })
    expect(parse(res)).toMatchObject({ highlighted: ['core-1', 'core-1 - edge-1'], unresolved: ['nope'] })
  })

  it('is an error when nothing matched', async () => {
    const setHighlights = vi.fn(() => ({ visibleInCurrentView: true }))
    const res = await executeTopologyTool('topology_highlight', { targets: ['ghost'], color: 'red' }, callbacks({ setHighlights }))
    expect(res.is_error).toBe(true)
    expect(setHighlights).not.toHaveBeenCalled()
  })

  it('clears with an empty target list', async () => {
    const clearHighlights = vi.fn()
    const res = await executeTopologyTool('topology_highlight', { targets: [] }, callbacks({ setHighlights: vi.fn(), clearHighlights }))
    expect(res.is_error).toBe(false)
    expect(clearHighlights).toHaveBeenCalled()
  })

  it('notes when the editor is in 3D view', async () => {
    const setHighlights = vi.fn(() => ({ visibleInCurrentView: false }))
    const res = await executeTopologyTool('topology_highlight', { targets: ['edge-1'], color: '#f00' }, callbacks({ setHighlights }))
    expect(parse(res).note).toMatch(/2D view/)
  })
})

describe('topology_export', () => {
  it('errors when no editor is wired', async () => {
    const res = await executeTopologyTool('topology_export', { format: 'png' }, callbacks())
    expect(res.is_error).toBe(true)
  })

  it('reports the saved path', async () => {
    const exportTopology = vi.fn(async () => ({ path: '/tmp/t.svg' }))
    const res = await executeTopologyTool('topology_export', { format: 'svg' }, callbacks({ exportTopology }))
    expect(res.is_error).toBe(false)
    expect(exportTopology).toHaveBeenCalledWith('svg')
    expect(parse(res).path).toBe('/tmp/t.svg')
  })

  it('is an error when the user cancels the save dialog', async () => {
    const exportTopology = vi.fn(async () => null)
    const res = await executeTopologyTool('topology_export', { format: 'json' }, callbacks({ exportTopology }))
    expect(res.is_error).toBe(true)
    expect(parse(res).error).toMatch(/cancelled/)
  })

  it('is an error when the export fails', async () => {
    const exportTopology = vi.fn(async () => { throw new Error('Canvas not found') })
    const res = await executeTopologyTool('topology_export', { format: 'png' }, callbacks({ exportTopology }))
    expect(res.is_error).toBe(true)
  })
})
