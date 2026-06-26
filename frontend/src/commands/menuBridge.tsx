/**
 * MenuBridge — connects the native Tauri menu to the CommandRegistry.
 *
 * What this owns
 * --------------
 *   1. Subscribes to `menu://<id>` events emitted by the Tauri menu
 *      handler (frontend/src-tauri/src/main.rs on_menu_event).
 *   2. Maps menu IDs to CommandRegistry command IDs.
 *   3. Dispatches the matching command with the current ActiveContext.
 *   4. Watches the registry + ActiveContext and pushes enable/disable
 *      state back to the native menu via the `set_menu_enabled`
 *      invoke handler.
 *
 * What this doesn't own
 * ---------------------
 *   - The native menu structure (lives in main.rs build_menu).
 *   - The commands themselves (registered by individual surfaces).
 *
 * Mount once near the root of the app (App.tsx).
 *
 * Design notes
 * ------------
 * The map is a plain object literal kept right here, intentionally, so
 * adding a new menu item is one line of Rust (build_menu) + one entry
 * here. If the map grows past ~80 entries, consider co-locating it
 * with the Rust menu builder via a code-gen step.
 */

import { useEffect } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { dispatchCommand, useCommandStore } from './registry'
import { useActiveContextStore, getActiveContext } from './activeContext'

/**
 * Mapping from the native menu's item id (defined in main.rs) to the
 * CommandRegistry command id that should run. When the menu emits
 * `menu://reconnect`, we dispatch `session.reconnect`.
 *
 * Convention: keep the right-hand side aligned with the command
 * registration so menu and registry stay in sync.
 */
export const MENU_ID_TO_COMMAND: Record<string, string> = {
  // File
  'new-session': 'file.new-session',
  'new-terminal': 'file.new-terminal',
  'new-document': 'file.new-document',
  'quick-connect': 'file.quick-connect',
  'save': 'file.save',
  'close-tab': 'file.close-tab',

  // App / global
  'settings': 'app.settings',
  'about': 'help.about',

  // Edit
  'find': 'edit.find',

  // View
  'command-palette': 'view.command-palette',
  'toggle-sidebar': 'view.toggle-sidebar',
  'toggle-ai-panel': 'view.toggle-ai-panel',
  'zoom-reset': 'view.zoom-reset',
  'zoom-in': 'view.zoom-in',
  'zoom-out': 'view.zoom-out',

  // Session
  'reconnect': 'session.reconnect',
  'toggle-multi-send': 'session.toggle-multi-send',
  'connect-selected': 'session.connect-selected',
  'start-troubleshooting': 'session.start-troubleshooting',
  'open-remote-window': 'workspace.openRemoteWindow',

  // Window
  'next-tab': 'window.next-tab',
  'previous-tab': 'window.previous-tab',

  // Tools
  'open-quick-actions': 'tools.quick-actions',
  'open-snippets': 'tools.snippets',
  'open-mapped-keys': 'tools.mapped-keys',
  'open-vault': 'tools.vault',
  'open-recordings': 'tools.recordings',
  'open-layouts': 'tools.layouts',
  'open-session-logs': 'tools.session-logs',
  'open-host-keys': 'tools.host-keys',
  'open-scratchpad': 'tools.scratchpad',

  // AI
  'open-ai-settings': 'ai.settings',
  'open-mcp-servers': 'ai.mcp-servers',
  'open-ai-memory': 'ai.memory',
  'toggle-ai-chat': 'ai.toggle-chat',

  // Tabs (under Window)
  'close-all-tabs': 'window.close-all-tabs',
  'close-tabs-right': 'window.close-tabs-right',
  'reopen-closed-tab': 'window.reopen-closed-tab',

  // Help
  'open-docs': 'help.docs',
}

/**
 * Mount the bridge. Idempotent — but only mount once near the root.
 *
 * Backend support
 * ---------------
 * The enable/disable push relies on a `set_menu_enabled` Tauri
 * command being available. When that command isn't registered yet
 * (older app builds), the invoke fails silently and the menu items
 * stay in whatever enabled state they were built with — which is the
 * safe pre-bridge behavior.
 */
export function MenuBridge(): null {
  useEffect(() => {
    // Subscribe to every menu event we care about. listen() returns a
    // promise that resolves to the unlisten function. We track a
    // `cancelled` flag so unsubscribers that resolve AFTER unmount are
    // invoked immediately — without this, StrictMode dev / hot reload
    // would unmount before subscribe() finished and leave orphaned
    // listeners that double-fire commands on subsequent menu clicks.
    let cancelled = false
    const cleanups: UnlistenFn[] = []
    ;(async () => {
      for (const menuId of Object.keys(MENU_ID_TO_COMMAND)) {
        if (cancelled) return
        try {
          const off = await listen(`menu://${menuId}`, () => {
            const commandId = MENU_ID_TO_COMMAND[menuId]
            if (!commandId) return
            void dispatchCommand(commandId, getActiveContext())
          })
          if (cancelled) {
            // Unmounted while we were awaiting — immediately tear down
            // so we don't accumulate orphaned listeners.
            off()
            return
          }
          cleanups.push(off)
        } catch {
          // Event subscription can fail if Tauri isn't fully booted;
          // we just lose the binding for this one item. Not fatal.
        }
      }
    })()

    return () => {
      cancelled = true
      cleanups.forEach((off) => off())
    }
  }, [])

  // Push enable/disable to the native menu whenever:
  //   - the set of registered commands changes (new surface mounted), or
  //   - the active context changes (e.g. tab switch).
  useEffect(() => {
    const evaluate = () => {
      const ctx = useActiveContextStore.getState().snapshot()
      const registry = useCommandStore.getState().commands
      const updates: { id: string; enabled: boolean }[] = []
      for (const [menuId, commandId] of Object.entries(MENU_ID_TO_COMMAND)) {
        const cmd = registry.get(commandId)
        if (!cmd) {
          // Unregistered — disable so users don't click an inert item.
          updates.push({ id: menuId, enabled: false })
          continue
        }
        const ok = cmd.when ? cmd.when(ctx) : true
        updates.push({ id: menuId, enabled: ok })
      }
      // Single batched invoke per evaluation cycle. Backend can apply
      // them in one pass without re-rendering the menu N times.
      invoke('set_menu_enabled_batch', { items: updates }).catch(() => {
        // The backend command may not be registered yet (older build).
        // Falling back to "always enabled" is acceptable for the
        // transition window — the dispatch path still checks `when`.
      })
    }

    // Re-evaluate when either store ticks. Both stores are Zustand so
    // subscribe returns a cleanup.
    const offCtx = useActiveContextStore.subscribe(evaluate)
    const offCmd = useCommandStore.subscribe((s) => s.commands, evaluate)
    // Initial sync (in case nothing has changed yet but commands have
    // already registered before mount).
    evaluate()
    return () => {
      offCtx()
      offCmd()
    }
  }, [])

  return null
}
