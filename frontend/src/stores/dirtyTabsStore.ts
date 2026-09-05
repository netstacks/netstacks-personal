/**
 * dirtyTabsStore - per-tab "has unsaved edits" registry
 *
 * App.tsx's isTabDirty() decides whether closing a tab needs an unsaved-changes
 * prompt. Tab types whose editor state lives inside their own component
 * (MopWorkspace today) can't be inspected from App.tsx, so they publish their
 * dirty flag here keyed by tab id and App reads it back. Publishers should
 * call setTabDirty(tabId, false) on unmount so closed tabs don't linger.
 */
import { create } from 'zustand'

interface DirtyTabsState {
  dirtyTabIds: Record<string, true>
  setTabDirty: (tabId: string, dirty: boolean) => void
  isTabDirty: (tabId: string) => boolean
  clear: () => void
}

export const useDirtyTabsStore = create<DirtyTabsState>((set, get) => ({
  dirtyTabIds: {},
  setTabDirty: (tabId, dirty) => set((state) => {
    const already = !!state.dirtyTabIds[tabId]
    if (already === dirty) return state
    const next = { ...state.dirtyTabIds }
    if (dirty) next[tabId] = true
    else delete next[tabId]
    return { dirtyTabIds: next }
  }),
  isTabDirty: (tabId) => !!get().dirtyTabIds[tabId],
  clear: () => set({ dirtyTabIds: {} }),
}))

/** Publish a tab's dirty flag (no-op when unchanged). */
export function setTabDirty(tabId: string, dirty: boolean): void {
  useDirtyTabsStore.getState().setTabDirty(tabId, dirty)
}

/** Read a tab's published dirty flag; unknown tabs are clean. */
export function isTabDirtyById(tabId: string): boolean {
  return useDirtyTabsStore.getState().isTabDirty(tabId)
}
