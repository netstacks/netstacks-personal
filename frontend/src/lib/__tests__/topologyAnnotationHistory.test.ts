import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  createAnnotation: vi.fn(),
  deleteAnnotation: vi.fn(),
  updateAnnotation: vi.fn(),
}))

vi.mock('../../api/annotations', () => ({
  ...api,
  toElementData: (a: Record<string, unknown>) => {
    const { id: _id, topologyId: _t, type: _ty, zIndex: _z, createdAt: _c, updatedAt: _u, ...rest } = a
    return rest
  },
}))

import { executeAnnotationHistoryAction, isAnnotationAction } from '../topologyAnnotationHistory'
import type { Annotation, TextAnnotation } from '../../types/annotations'
import type { TopologyAction } from '../../types/topologyHistory'

const note: TextAnnotation = {
  id: 'n1', topologyId: 't1', type: 'text', zIndex: 0, createdAt: '', updatedAt: '',
  position: { x: 1, y: 2 }, content: 'DMZ', fontSize: 14, fontWeight: 'normal', color: '#fff',
}

const addAction: TopologyAction = {
  id: 'h1', type: 'add_annotation', source: 'ai', timestamp: new Date(), description: 'Added annotation text',
  data: { before: null, after: note, context: { annotationId: 'n1' } },
}

/** Annotation array with a React-style setter. */
function store(initial: Annotation[]) {
  let list = initial
  const setAnnotations = vi.fn((u: Annotation[] | ((p: Annotation[]) => Annotation[])) => {
    list = typeof u === 'function' ? u(list) : u
  })
  return { get: () => list, setAnnotations }
}

describe('executeAnnotationHistoryAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('recognises annotation actions only', () => {
    expect(isAnnotationAction(addAction)).toBe(true)
    expect(isAnnotationAction({ ...addAction, type: 'add_device' })).toBe(false)
  })

  it('undo of an AI add deletes it from the backend and the canvas', async () => {
    const s = store([note])
    await executeAnnotationHistoryAction(addAction, 'undo', { topologyId: 't1', isTemporary: false, setAnnotations: s.setAnnotations, idAliases: new Map() })
    expect(api.deleteAnnotation).toHaveBeenCalledWith('t1', 'n1')
    expect(s.get()).toEqual([])
  })

  it('redo re-creates it and later undo deletes the new record', async () => {
    api.createAnnotation.mockResolvedValueOnce({ ...note, id: 'n2' })
    const s = store([])
    const deps = { topologyId: 't1', isTemporary: false, setAnnotations: s.setAnnotations, idAliases: new Map<string, string>() }
    await executeAnnotationHistoryAction(addAction, 'redo', deps)
    expect(api.createAnnotation).toHaveBeenCalledWith('t1', 'text', expect.objectContaining({ content: 'DMZ' }), 0)
    expect(s.get().map(a => a.id)).toEqual(['n2'])

    await executeAnnotationHistoryAction(addAction, 'undo', deps)
    expect(api.deleteAnnotation).toHaveBeenCalledWith('t1', 'n2')
    expect(s.get()).toEqual([])
  })

  it('keeps the canvas unchanged when the backend delete fails', async () => {
    api.deleteAnnotation.mockRejectedValueOnce(new Error('offline'))
    const s = store([note])
    await expect(executeAnnotationHistoryAction(addAction, 'undo', { topologyId: 't1', isTemporary: false, setAnnotations: s.setAnnotations, idAliases: new Map() })).rejects.toThrow('offline')
    expect(s.get()).toEqual([note])
  })

  it('works locally for a temporary topology', async () => {
    const s = store([note])
    const deps = { topologyId: undefined, isTemporary: true, setAnnotations: s.setAnnotations, idAliases: new Map<string, string>() }
    await executeAnnotationHistoryAction(addAction, 'undo', deps)
    expect(s.get()).toEqual([])
    await executeAnnotationHistoryAction(addAction, 'redo', deps)
    expect(s.get()).toEqual([note])
    expect(api.createAnnotation).not.toHaveBeenCalled()
    expect(api.deleteAnnotation).not.toHaveBeenCalled()
  })
})
