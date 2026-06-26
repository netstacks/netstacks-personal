/**
 * ActiveContext store — the live "what is the user looking at right
 * now" snapshot that gates the CommandRegistry's `when` predicates.
 *
 * Design
 * ------
 * Kept deliberately small. Every field here is something at least one
 * command needs to make an enable/disable decision. Adding a field
 * forces a re-evaluation of every `when` predicate that reads it,
 * which fans out to a native-menu rebuild. Don't add transient state
 * (cursor position, scroll offset, etc.) — that should live in the
 * owning component.
 *
 * Update pattern
 * --------------
 * App.tsx (or a small subscriber component near the root) calls
 * `useActiveContextStore.setState({...})` whenever the relevant inputs
 * change. The store doesn't compute anything — callers feed it
 * pre-computed values to keep it pure and predictable.
 *
 * Selectors
 * ---------
 * Components subscribe with selectors to minimise re-renders:
 *
 *   const status = useActiveContextStore(s => s.terminalStatus)
 *
 * Don't pull the whole object unless you genuinely need most of it.
 */

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { ActiveContext } from './types'

/** Initial snapshot used before any tab is open. */
const INITIAL: ActiveContext = {
  activeTabType: null,
  activeTabId: null,
  terminalStatus: null,
  isDirty: false,
  activeSidebarView: null,
  selectionCount: 0,
  isEnterprise: false,
}

interface ActiveContextStore extends ActiveContext {
  /** Bulk replace — used by the App-level subscriber. Partial updates
   *  are also supported via Zustand's standard setState. */
  setContext: (next: Partial<ActiveContext>) => void
  /** Snapshot the current context. Useful for non-React callers. */
  snapshot: () => ActiveContext
}

export const useActiveContextStore = create<ActiveContextStore>()(
  subscribeWithSelector((set, get) => ({
    ...INITIAL,
    setContext: (next) => set(next),
    snapshot: () => {
      const s = get()
      // Strip out the methods so the returned object matches the
      // ActiveContext interface exactly.
      return {
        activeTabType: s.activeTabType,
        activeTabId: s.activeTabId,
        terminalStatus: s.terminalStatus,
        isDirty: s.isDirty,
        activeSidebarView: s.activeSidebarView,
        selectionCount: s.selectionCount,
        isEnterprise: s.isEnterprise,
      }
    },
  })),
)

/** Non-React accessor — used by dispatchCommand and the menu-event
 *  bridge so they don't need to be hooks. */
export function getActiveContext(): ActiveContext {
  return useActiveContextStore.getState().snapshot()
}
