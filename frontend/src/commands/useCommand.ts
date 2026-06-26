/**
 * useCommand — register a Command with the CommandRegistry for the
 * lifetime of the calling component.
 *
 * Usage
 * -----
 *   useCommand({
 *     id: 'terminal.clear',
 *     label: 'Clear',
 *     category: 'terminal',
 *     accelerator: 'CmdOrCtrl+K',
 *     when: (ctx) => ctx.activeTabType === 'terminal' && ctx.terminalStatus === 'connected',
 *     run: () => xterm.clear(),
 *   })
 *
 * Lifecycle
 * ---------
 *   - Registers on mount.
 *   - Re-registers if `id` changes (rare; usually means a programming error).
 *   - Unregisters on unmount.
 *
 * Performance
 * -----------
 * Wrap the Command in useMemo at the call site if its fields close
 * over volatile values — every re-creation triggers a re-register.
 * For most surfaces the closure is cheap enough that this doesn't
 * matter, but a Command attached to per-keystroke state would.
 *
 * Reading vs running
 * ------------------
 * This hook is for *providing* commands. To *run* one (e.g. from a
 * button click), prefer dispatchCommand(id, getActiveContext()) from
 * the registry module — it picks up the latest registered version
 * automatically.
 */

import { useEffect, useRef } from 'react'
import { useCommandStore } from './registry'
import type { Command } from './types'

export function useCommand(cmd: Command): void {
  // Hold the latest command in a ref so the registered closure always
  // sees fresh state without re-registering on every render. The
  // registry stores a wrapper that delegates to the ref.
  const cmdRef = useRef(cmd)
  cmdRef.current = cmd

  useEffect(() => {
    const { register } = useCommandStore.getState()
    const unregister = register({
      ...cmd,
      run: () => cmdRef.current.run(),
      // Always install the wrapper unconditionally. Previously this
      // checked `cmd.when` at first-render and snapshot the truthiness
      // forever — a command that started unconditional and later
      // gained a `when` predicate would silently ignore the new gate
      // because the registered command still had `when: undefined`.
      // The wrapper delegates to cmdRef on every call so fresh closures
      // always win.
      when: (ctx) => (cmdRef.current.when ? cmdRef.current.when(ctx) : true),
    })
    return unregister
    // Intentionally only re-register on id change. The ref pattern
    // above handles fresh values for everything else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmd.id])
}
