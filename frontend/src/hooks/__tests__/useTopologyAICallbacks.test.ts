import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const http = { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() }
let mode: 'standalone' | 'enterprise' = 'standalone'

vi.mock('../../api/client', () => ({
  getClient: () => ({ http }),
  getCurrentMode: () => mode,
}))

import { useTopologyAICallbacks } from '../useTopologyAICallbacks'
import { useActiveTopologyStore } from '../../stores/activeTopologyStore'
import type { Topology } from '../../types/topology'

const topology: Topology = {
  id: 't1', name: 'T', source: 'manual', createdAt: '', updatedAt: '',
  devices: [
    { id: 'a', name: 'r1', type: 'router', status: 'online', x: 0, y: 0 },
    { id: 'b', name: 'r2', type: 'router', status: 'online', x: 10, y: 10 },
  ],
  connections: [{ id: 'c1', sourceDeviceId: 'a', targetDeviceId: 'b', status: 'active' }],
}

function setup(isTemporary = false) {
  const setTopology = vi.fn()
  const pushAction = vi.fn((a) => ({ ...a, id: 'h1', timestamp: new Date() }))
  const { result } = renderHook(() => useTopologyAICallbacks({
    topology, topologyId: 't1', isTemporary, setTopology, pushAction,
  }))
  return { cb: result.current!, setTopology, pushAction }
}

describe('useTopologyAICallbacks updates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mode = 'standalone'
    http.put.mockResolvedValue({ data: null })
    useActiveTopologyStore.getState().clear()
  })

  it('sends connection updates as snake_case and reports status as view-only', async () => {
    const { cb, setTopology } = setup()
    const res = await cb.updateConnection('c1', {
      sourceInterface: 'Gi0/1', curveStyle: 'orthogonal', lineWidth: 3, bundleId: 'po1', status: 'degraded',
    })
    expect(http.put).toHaveBeenCalledWith('/topologies/t1/connections/c1', {
      source_interface: 'Gi0/1', curve_style: 'orthogonal', line_width: 3, bundle_id: 'po1',
    })
    expect(res.persisted.sort()).toEqual(['bundleId', 'curveStyle', 'lineWidth', 'sourceInterface'])
    expect(res.notPersisted).toEqual(['status'])
    expect(res.item).toMatchObject({ status: 'degraded', lineWidth: 3 })
    expect(setTopology).toHaveBeenCalled()
  })

  it('throws on unknown fields without touching backend or state', async () => {
    const { cb, setTopology, pushAction } = setup()
    await expect(cb.updateConnection('c1', { bogus: 1 } as never)).rejects.toThrow(/Valid fields/)
    expect(http.put).not.toHaveBeenCalled()
    expect(setTopology).not.toHaveBeenCalled()
    expect(pushAction).not.toHaveBeenCalled()
  })

  it('does not apply locally when the save fails', async () => {
    http.put.mockRejectedValueOnce(new Error('500'))
    const { cb, setTopology } = setup()
    await expect(cb.updateConnection('c1', { label: 'x' })).rejects.toThrow('500')
    expect(setTopology).not.toHaveBeenCalled()
  })

  it('reports device name as not persisted on the agent, persisted on the Controller', async () => {
    let { cb } = setup()
    let res = await cb.updateDevice('a', { name: 'core-1', site: 'DC1' })
    expect(http.put).toHaveBeenLastCalledWith('/topologies/t1/devices/a/details', { site: 'DC1' })
    expect(res.notPersisted).toEqual(['name'])

    mode = 'enterprise'
    ;({ cb } = setup())
    res = await cb.updateDevice('a', { name: 'core-1', site: 'DC1' })
    expect(http.put).toHaveBeenLastCalledWith('/topologies/t1/devices/a/details', { name: 'core-1', site: 'DC1' })
    expect(res.notPersisted).toEqual([])
  })

  it('reports everything as not persisted for a temporary topology', async () => {
    const { cb } = setup(true)
    const res = await cb.updateConnection('c1', { label: 'x' })
    expect(http.put).not.toHaveBeenCalled()
    expect(res).toMatchObject({ persisted: [], notPersisted: ['label'] })
  })
})

describe('useTopologyAICallbacks editor-backed operations', () => {
  beforeEach(() => useActiveTopologyStore.getState().clear())

  it('has no annotate/highlight/export without an editor', () => {
    const { cb } = setup()
    expect(cb.addAnnotation).toBeUndefined()
    expect(cb.setHighlights).toBeUndefined()
    expect(cb.exportTopology).toBeUndefined()
  })

  it('exposes the callbacks the editor published', () => {
    const addAnnotation = vi.fn()
    const setHighlights = vi.fn()
    const exportTopology = vi.fn()
    const { result } = renderHook(() => useTopologyAICallbacks({
      topology, topologyId: 't1', setTopology: vi.fn(), pushAction: vi.fn(),
    }))
    act(() => {
      useActiveTopologyStore.getState().publish({ topology, addAnnotation, setHighlights, exportTopology })
    })
    expect(result.current?.addAnnotation).toBe(addAnnotation)
    expect(result.current?.setHighlights).toBe(setHighlights)
    expect(result.current?.exportTopology).toBe(exportTopology)
  })
})
