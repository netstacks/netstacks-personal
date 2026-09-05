/**
 * Clipboard history store (docs/clipboard-history-plan.md §3).
 *
 * Every in-app copy that goes through `copyToClipboard()` lands here with its
 * provenance. In standalone mode clips are persisted by the local agent
 * (`/clips`), which also scrubs credential patterns and applies retention;
 * in enterprise mode the Controller has no clip surface, so history is
 * memory-only for the life of the window.
 */
import { create } from 'zustand'
import type { Clip, ClipProvenance } from '../types/clip'
import { byteLength, countLines, detectLineEnding } from '../lib/clipText'
import { getSettings } from '../hooks/useSettings'
import { settingInt } from '../lib/clipTransforms'
import { getCurrentMode } from '../api/client'
import { logger } from '../lib/logger'
import * as api from '../api/clips'

/** Copy-on-select fires on every mouseup; identical text within this window is one clip. */
const DEDUPE_WINDOW_MS = 2000

interface ClipState {
  /** Newest first. */
  clips: Clip[]
  loaded: boolean
  capture: (text: string, provenance: ClipProvenance) => Promise<Clip | null>
  refresh: () => Promise<void>
  setPinned: (id: string, pinned: boolean) => Promise<void>
  remove: (id: string) => Promise<void>
  clearUnpinned: () => Promise<void>
}

/** True when the local agent persists history (standalone mode). */
const persistent = () => getCurrentMode() !== 'enterprise'

const retention = () => ({
  max: settingInt('clipboard.maxClips', 500),
  hours: settingInt('clipboard.expiryHours', 24),
})

/** Drop expired/over-cap unpinned clips; pinned clips always survive. */
export function applyRetention(clips: Clip[], now: number, max: number, hours: number): Clip[] {
  const cutoff = now - hours * 3600 * 1000
  let unpinnedKept = 0
  return clips.filter((c) => {
    if (c.pinned) return true
    if (Date.parse(c.createdAt) < cutoff) return false
    unpinnedKept += 1
    return unpinnedKept <= max
  })
}

export const useClipStore = create<ClipState>((set, get) => ({
  clips: [],
  loaded: false,

  capture: async (text, provenance) => {
    if (getSettings()['clipboard.historyEnabled'] === false) return null
    if (!text || text.trim().length === 0) return null

    const now = Date.now()
    const newest = get().clips[0]
    if (newest && newest.text === text && now - Date.parse(newest.createdAt) < DEDUPE_WINDOW_MS) {
      return newest
    }

    const { max, hours } = retention()
    const local: Clip = {
      id: crypto.randomUUID(),
      text,
      createdAt: new Date(now).toISOString(),
      provenance,
      pinned: false,
      lineEnding: detectLineEnding(text),
      bytes: byteLength(text),
      lines: countLines(text),
      redacted: false,
    }

    let clip = local
    if (persistent()) {
      try {
        // The agent scrubs credential patterns and returns the stored text.
        clip = await api.createClip({
          text,
          provenance,
          line_ending: local.lineEnding,
          retain_max: max,
          retain_hours: hours,
        })
      } catch (err) {
        logger.warn('[clipStore] persist failed, keeping clip in memory:', err)
      }
    }

    set((s) => ({ clips: applyRetention([clip, ...s.clips.filter((c) => c.id !== clip.id)], now, max, hours) }))
    return clip
  },

  refresh: async () => {
    if (!persistent()) {
      set({ loaded: true })
      return
    }
    try {
      const { max, hours } = retention()
      const clips = await api.listClips(max)
      set({ clips: applyRetention(clips, Date.now(), max, hours), loaded: true })
    } catch (err) {
      logger.warn('[clipStore] load failed:', err)
      set({ loaded: true })
    }
  },

  setPinned: async (id, pinned) => {
    set((s) => ({ clips: s.clips.map((c) => (c.id === id ? { ...c, pinned } : c)) }))
    if (!persistent()) return
    try {
      await api.updateClip(id, { pinned })
    } catch (err) {
      logger.warn('[clipStore] pin update failed:', err)
    }
  },

  remove: async (id) => {
    set((s) => ({ clips: s.clips.filter((c) => c.id !== id) }))
    if (!persistent()) return
    try {
      await api.deleteClip(id)
    } catch (err) {
      logger.warn('[clipStore] delete failed:', err)
    }
  },

  clearUnpinned: async () => {
    set((s) => ({ clips: s.clips.filter((c) => c.pinned) }))
    if (!persistent()) return
    try {
      await api.clearClips()
    } catch (err) {
      logger.warn('[clipStore] clear failed:', err)
    }
  },
}))
