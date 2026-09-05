/**
 * useMopCommandBridge — two-way link between a MopWorkspace and the
 * command registry's `mop.*` commands.
 *
 *   - Publishes the workspace's execution flags into `ActiveContext.mop`
 *     while its tab is the active one (App rewrites `mop: null` on every
 *     tab switch, so the hook re-pushes whenever the store ticks — the
 *     same pattern MopWorkspace uses for `isDirty`), and clears it on
 *     unmount.
 *   - Listens for `netstacks:mop-command` events addressed to its tab and
 *     routes the action to the workspace's existing handlers.
 *
 * App.tsx's `mop.*` commands call `dispatchMopCommand(activeTabId, action)`.
 */

import { useEffect, useMemo, useRef } from 'react'
import { useActiveContextStore } from '../commands/activeContext'
import type { MopCommandContext } from '../commands/types'

export type MopCommandFlags = MopCommandContext

export type MopCommandAction = 'start' | 'run-next' | 'abort' | 'complete'

export const MOP_COMMAND_EVENT = 'netstacks:mop-command'

interface MopCommandDetail {
  tabId: string
  action: MopCommandAction
}

/** Fire a `mop.*` command at the MopWorkspace hosted in `tabId`. */
export function dispatchMopCommand(tabId: string, action: MopCommandAction): void {
  const detail: MopCommandDetail = { tabId, action }
  window.dispatchEvent(new CustomEvent<MopCommandDetail>(MOP_COMMAND_EVENT, { detail }))
}

/**
 * Publishes `flags` into `ActiveContext.mop` while `tabId` is the active
 * tab (clears on unmount / tab change) and invokes `onCommand(action)`
 * when a `netstacks:mop-command` event with a matching tabId fires.
 */
export function useMopCommandBridge(
  tabId: string | undefined,
  flags: MopCommandFlags,
  onCommand: (action: MopCommandAction) => void,
): void {
  const { canStart, canRunNext, canAbort, canComplete, hasExecution } = flags
  // Stable object per distinct flag combination so the store's identity
  // check below is enough to skip redundant setContext calls.
  const snapshot = useMemo<MopCommandContext>(
    () => ({ canStart, canRunNext, canAbort, canComplete, hasExecution }),
    [canStart, canRunNext, canAbort, canComplete, hasExecution],
  )
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  const onCommandRef = useRef(onCommand)
  onCommandRef.current = onCommand

  // Subscribe once per tab; push whenever the store ticks (tab switch or
  // App's context rebuild) and the tab is still the active one.
  useEffect(() => {
    if (!tabId) return
    const push = () => {
      const ctx = useActiveContextStore.getState()
      if (ctx.activeTabId !== tabId) return
      if (ctx.mop !== snapshotRef.current) ctx.setContext({ mop: snapshotRef.current })
    }
    push()
    const off = useActiveContextStore.subscribe(ctx => `${ctx.activeTabId}|${ctx.mop === snapshotRef.current}`, push)
    return () => {
      off()
      const ctx = useActiveContextStore.getState()
      if (ctx.activeTabId === tabId && ctx.mop !== null) ctx.setContext({ mop: null })
    }
  }, [tabId])

  // Re-push when the flags themselves change.
  useEffect(() => {
    if (!tabId) return
    const ctx = useActiveContextStore.getState()
    if (ctx.activeTabId === tabId && ctx.mop !== snapshot) ctx.setContext({ mop: snapshot })
  }, [tabId, snapshot])

  useEffect(() => {
    if (!tabId) return
    const handler = (e: Event) => {
      const { tabId: target, action } = (e as CustomEvent<MopCommandDetail>).detail
      if (target === tabId) onCommandRef.current(action)
    }
    window.addEventListener(MOP_COMMAND_EVENT, handler)
    return () => window.removeEventListener(MOP_COMMAND_EVENT, handler)
  }, [tabId])
}
