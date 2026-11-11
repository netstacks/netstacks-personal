import { beforeEach, describe, expect, it, vi } from 'vitest'

const http = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  post: vi.fn(),
}

vi.mock('../client', () => ({
  getClient: () => ({ http }),
}))

import { toElementData, updateAnnotation, createAnnotation } from '../annotations'
import type { ShapeAnnotation, LineAnnotation } from '../../types/annotations'

const shape: ShapeAnnotation = {
  id: 'a1',
  topologyId: 't1',
  type: 'shape',
  zIndex: 3,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  shapeType: 'rectangle',
  position: { x: 10, y: 20 },
  size: { width: 100, height: 60 },
  strokeColor: '#4a9eff',
  strokeStyle: 'solid',
  strokeWidth: 2,
  fillColor: '#4a9eff',
  fillOpacity: 0.1,
}

describe('toElementData', () => {
  it('strips base fields and keeps every type-specific field', () => {
    const data = toElementData(shape)
    expect(data).toEqual({
      shapeType: 'rectangle',
      position: { x: 10, y: 20 },
      size: { width: 100, height: 60 },
      strokeColor: '#4a9eff',
      strokeStyle: 'solid',
      strokeWidth: 2,
      fillColor: '#4a9eff',
      fillOpacity: 0.1,
    })
    for (const k of ['id', 'topologyId', 'type', 'zIndex', 'createdAt', 'updatedAt']) {
      expect(data).not.toHaveProperty(k)
    }
  })

  it('drops undefined values', () => {
    expect(toElementData({ ...shape, label: undefined })).not.toHaveProperty('label')
  })
})

describe('updateAnnotation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('PUTs the full merged element_data (position AND size) after a move', async () => {
    const moved = { ...shape, position: { x: 50, y: 60 } }
    await updateAnnotation('t1', 'a1', { elementData: toElementData(moved) })
    expect(http.put).toHaveBeenCalledWith('/topologies/t1/annotations/a1', {
      element_data: expect.objectContaining({
        shapeType: 'rectangle',
        position: { x: 50, y: 60 },
        size: { width: 100, height: 60 },
        strokeColor: '#4a9eff',
      }),
    })
    const body = http.put.mock.calls[0][1] as { element_data: Record<string, unknown> }
    expect(body.element_data).not.toHaveProperty('id')
    expect(body.element_data).not.toHaveProperty('updatedAt')
  })

  it('carries line points so a line move persists', async () => {
    const line: LineAnnotation = {
      id: 'l1', topologyId: 't1', type: 'line', zIndex: 0, createdAt: '', updatedAt: '',
      points: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
      curveStyle: 'straight', color: '#fff', lineStyle: 'solid', lineWidth: 2,
    }
    await updateAnnotation('t1', 'l1', { elementData: toElementData(line) })
    const body = http.put.mock.calls[0][1] as { element_data: Record<string, unknown> }
    expect(body.element_data.points).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }])
  })

  it('omits element_data when only zIndex changes', async () => {
    await updateAnnotation('t1', 'a1', { zIndex: 7 })
    expect(http.put).toHaveBeenCalledWith('/topologies/t1/annotations/a1', { z_index: 7 })
  })
})

describe('createAnnotation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('never sends base fields inside element_data', async () => {
    http.post.mockResolvedValueOnce({ data: { id: 'n', topology_id: 't1', annotation_type: 'shape', element_data: {}, z_index: 0, created_at: '', updated_at: '' } })
    await createAnnotation('t1', 'shape', toElementData(shape) as Omit<ShapeAnnotation, 'id' | 'topologyId' | 'type' | 'zIndex' | 'createdAt' | 'updatedAt'>, 3)
    const body = http.post.mock.calls[0][1] as { annotation_type: string; element_data: Record<string, unknown>; z_index: number }
    expect(body.annotation_type).toBe('shape')
    expect(body.z_index).toBe(3)
    expect(body.element_data).not.toHaveProperty('id')
    expect(body.element_data.size).toEqual({ width: 100, height: 60 })
  })
})
