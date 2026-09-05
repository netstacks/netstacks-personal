import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Clip } from '../../types/clip'

const api = vi.hoisted(() => ({
  createClip: vi.fn(),
  listClips: vi.fn(),
  updateClip: vi.fn(),
  deleteClip: vi.fn(),
  clearClips: vi.fn(),
}))
const mode = vi.hoisted(() => ({ current: 'standalone' as string | null }))
const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))

vi.mock('../../api/clips', () => api)
vi.mock('../../api/client', () => ({ getCurrentMode: () => mode.current }))
vi.mock('../../hooks/useSettings', () => ({ getSettings: () => settings.current }))

import { useClipStore, applyRetention } from '../clipStore'

const serverClip = (over: Partial<Clip>): Clip => ({
  id: 'srv-1', text: 'from server', createdAt: new Date().toISOString(),
  provenance: { source: 'app-copy' }, pinned: false, lineEnding: 'none', bytes: 11, lines: 1, redacted: false, ...over,
})

beforeEach(() => {
  useClipStore.setState({ clips: [], loaded: false })
  Object.values(api).forEach((f) => f.mockReset())
  mode.current = 'standalone'
  settings.current = {}
})

describe('clipStore.capture', () => {
  it('persists through the agent and keeps the scrubbed server copy', async () => {
    api.createClip.mockResolvedValue(serverClip({ text: 'enable secret [REDACTED]', redacted: true }))
    const clip = await useClipStore.getState().capture('enable secret 5 abc', { source: 'terminal-selection', sessionName: 'r1' })
    expect(api.createClip).toHaveBeenCalledTimes(1)
    expect(api.createClip.mock.calls[0][0]).toMatchObject({ text: 'enable secret 5 abc', line_ending: 'none', retain_max: 500, retain_hours: 24 })
    expect(clip?.redacted).toBe(true)
    expect(useClipStore.getState().clips[0].text).toBe('enable secret [REDACTED]')
  })

  it('keeps the clip in memory when the agent call fails', async () => {
    api.createClip.mockRejectedValue(new Error('down'))
    const clip = await useClipStore.getState().capture('show version', { source: 'app-copy' })
    expect(clip?.text).toBe('show version')
    expect(useClipStore.getState().clips).toHaveLength(1)
  })

  it('is memory-only in enterprise mode', async () => {
    mode.current = 'enterprise'
    await useClipStore.getState().capture('x', { source: 'app-copy' })
    expect(api.createClip).not.toHaveBeenCalled()
    expect(useClipStore.getState().clips).toHaveLength(1)
  })

  it('dedupes identical text copied within the window and honours the setting', async () => {
    mode.current = 'enterprise'
    const a = await useClipStore.getState().capture('same', { source: 'app-copy' })
    const b = await useClipStore.getState().capture('same', { source: 'app-copy' })
    expect(a?.id).toBe(b?.id)
    expect(useClipStore.getState().clips).toHaveLength(1)
    settings.current = { 'clipboard.historyEnabled': false }
    expect(await useClipStore.getState().capture('other', { source: 'app-copy' })).toBeNull()
    expect(await useClipStore.getState().capture('   ', { source: 'app-copy' })).toBeNull()
  })
})

describe('applyRetention', () => {
  it('keeps pinned clips, drops expired and over-cap unpinned ones', () => {
    const now = Date.now()
    const mk = (id: string, ageMs: number, pinned = false): Clip => serverClip({ id, pinned, createdAt: new Date(now - ageMs).toISOString() })
    const clips = [mk('new', 0), mk('pinned-old', 100 * 3600e3, true), mk('mid', 1000), mk('old', 30 * 3600e3)]
    const kept = applyRetention(clips, now, 1, 24).map((c) => c.id)
    expect(kept).toEqual(['new', 'pinned-old'])
  })
})
