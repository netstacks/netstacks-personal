import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import { useActiveContextStore } from '../../commands/activeContext'
import {
  useMopCommandBridge,
  dispatchMopCommand,
  type MopCommandFlags,
} from '../useMopCommandBridge'

const IDLE: MopCommandFlags = {
  canStart: true, canRunNext: false, canAbort: false, canComplete: false, hasExecution: false,
}
const RUNNING: MopCommandFlags = {
  canStart: false, canRunNext: true, canAbort: true, canComplete: false, hasExecution: true,
}

const store = () => useActiveContextStore.getState()

describe('useMopCommandBridge', () => {
  beforeEach(() => {
    store().setContext({ activeTabType: null, activeTabId: null, mop: null })
  })

  it('publishes flags only while its tab is active', () => {
    store().setContext({ activeTabType: 'terminal', activeTabId: 'term-1' })
    const { rerender } = renderHook(
      ({ flags }) => useMopCommandBridge('mop-1', flags, () => {}),
      { initialProps: { flags: IDLE } },
    )
    expect(store().mop).toBeNull()

    // App's context rebuild on tab switch writes mop:null; the hook re-pushes.
    act(() => { store().setContext({ activeTabType: 'mop', activeTabId: 'mop-1', mop: null }) })
    expect(store().mop).toEqual(IDLE)

    act(() => { rerender({ flags: RUNNING }) })
    expect(store().mop).toEqual(RUNNING)

    act(() => { store().setContext({ activeTabType: 'terminal', activeTabId: 'term-1', mop: null }) })
    act(() => { rerender({ flags: IDLE }) })
    expect(store().mop).toBeNull()
  })

  it('clears the flags on unmount', () => {
    store().setContext({ activeTabType: 'mop', activeTabId: 'mop-1' })
    const { unmount } = renderHook(() => useMopCommandBridge('mop-1', IDLE, () => {}))
    expect(store().mop).toEqual(IDLE)
    unmount()
    expect(store().mop).toBeNull()
  })

  it('does nothing without a tab id', () => {
    store().setContext({ activeTabType: 'mop', activeTabId: 'mop-1' })
    renderHook(() => useMopCommandBridge(undefined, IDLE, () => {}))
    expect(store().mop).toBeNull()
  })

  it('routes netstacks:mop-command only for its own tab', () => {
    const onCommand = vi.fn()
    renderHook(() => useMopCommandBridge('mop-1', IDLE, onCommand))

    act(() => { dispatchMopCommand('mop-2', 'start') })
    expect(onCommand).not.toHaveBeenCalled()

    act(() => { dispatchMopCommand('mop-1', 'run-next') })
    expect(onCommand).toHaveBeenCalledTimes(1)
    expect(onCommand).toHaveBeenCalledWith('run-next')
  })

  it('uses the latest onCommand without re-subscribing', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(
      ({ cb }) => useMopCommandBridge('mop-1', IDLE, cb),
      { initialProps: { cb: first } },
    )
    rerender({ cb: second })
    act(() => { dispatchMopCommand('mop-1', 'abort') })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('abort')
  })
})
