import { describe, it, expect, beforeEach } from 'vitest'
import { useDirtyTabsStore, setTabDirty, isTabDirtyById } from '../dirtyTabsStore'

describe('dirtyTabsStore', () => {
  beforeEach(() => useDirtyTabsStore.getState().clear())

  it('unknown tabs are clean', () => {
    expect(isTabDirtyById('nope')).toBe(false)
  })

  it('tracks dirty per tab id and clears on false', () => {
    setTabDirty('tab-a', true)
    setTabDirty('tab-b', true)
    expect(isTabDirtyById('tab-a')).toBe(true)
    expect(isTabDirtyById('tab-b')).toBe(true)

    setTabDirty('tab-a', false)
    expect(isTabDirtyById('tab-a')).toBe(false)
    expect(isTabDirtyById('tab-b')).toBe(true)
    expect(useDirtyTabsStore.getState().dirtyTabIds).toEqual({ 'tab-b': true })
  })

  it('does not create a new state object when nothing changes', () => {
    setTabDirty('tab-a', true)
    const before = useDirtyTabsStore.getState().dirtyTabIds
    setTabDirty('tab-a', true)
    setTabDirty('never-dirty', false)
    expect(useDirtyTabsStore.getState().dirtyTabIds).toBe(before)
  })
})
