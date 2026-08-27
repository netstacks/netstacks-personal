/**
 * Links between the three places a shortcut shows up:
 *
 *   - the customizable registry action (`useKeyboard` — what actually fires
 *     in the webview and what the user edits in Settings → Keyboard),
 *   - the CommandRegistry command (what menus and the palette run/display),
 *   - the native macOS menu item id (main.rs `build_menu`), whose
 *     accelerator must follow the user's binding or the OS swallows the
 *     default chord before the webview ever sees it.
 *
 * `DEFAULT_KEYBINDINGS` is the single source of truth: command
 * accelerators are derived from it, and the native menu is re-accelerated
 * from the live bindings by MenuBridge.
 */

import {
  DEFAULT_KEYBINDINGS,
  getCurrentBinding,
  getPlatformBinding,
  parseKeybinding,
  type KeyboardAction,
} from '../hooks/useKeyboard'

export interface KeybindingLink {
  commandId: string
  /** Native menu item id (main.rs). Absent for commands that are not in the menu. */
  menuId?: string
}

export const ACTION_LINKS: Partial<Record<KeyboardAction, KeybindingLink>> = {
  newSession: { commandId: 'file.new-session', menuId: 'new-session' },
  newTerminal: { commandId: 'file.new-terminal', menuId: 'new-terminal' },
  newDocument: { commandId: 'file.new-document', menuId: 'new-document' },
  quickConnect: { commandId: 'file.quick-connect', menuId: 'quick-connect' },
  saveDocument: { commandId: 'file.save', menuId: 'save' },
  closeTab: { commandId: 'file.close-tab', menuId: 'close-tab' },
  settings: { commandId: 'app.settings', menuId: 'settings' },
  findInTerminal: { commandId: 'edit.find', menuId: 'find' },
  commandPalette: { commandId: 'view.command-palette', menuId: 'command-palette' },
  toggleSidebar: { commandId: 'view.toggle-sidebar', menuId: 'toggle-sidebar' },
  aiChat: { commandId: 'view.toggle-ai-panel', menuId: 'toggle-ai-panel' },
  zoomReset: { commandId: 'view.zoom-reset', menuId: 'zoom-reset' },
  zoomIn: { commandId: 'view.zoom-in', menuId: 'zoom-in' },
  zoomOut: { commandId: 'view.zoom-out', menuId: 'zoom-out' },
  reconnect: { commandId: 'session.reconnect', menuId: 'reconnect' },
  toggleMultiSend: { commandId: 'session.toggle-multi-send', menuId: 'toggle-multi-send' },
  connectSelectedSessions: { commandId: 'session.connect-selected', menuId: 'connect-selected' },
  startTroubleshooting: { commandId: 'session.start-troubleshooting', menuId: 'start-troubleshooting' },
  nextTab: { commandId: 'window.next-tab', menuId: 'next-tab' },
  previousTab: { commandId: 'window.previous-tab', menuId: 'previous-tab' },
  closeAllTabs: { commandId: 'window.close-all-tabs', menuId: 'close-all-tabs' },
  reopenClosedTab: { commandId: 'window.reopen-closed-tab', menuId: 'reopen-closed-tab' },
  scratchpadOpen: { commandId: 'tools.scratchpad', menuId: 'open-scratchpad' },
  toggleAiChatPanel: { commandId: 'ai.toggle-chat', menuId: 'toggle-ai-chat' },
}

const COMMAND_TO_ACTION: Record<string, KeyboardAction> = Object.fromEntries(
  (Object.entries(ACTION_LINKS) as [KeyboardAction, KeybindingLink][]).map(([a, l]) => [l.commandId, a]),
)

export function actionForCommand(commandId: string): KeyboardAction | undefined {
  return COMMAND_TO_ACTION[commandId]
}

/** Registry-format key names → Tauri/muda accelerator key names. */
const TAURI_KEY_NAMES: Record<string, string> = {
  enter: 'Return',
  esc: 'Escape',
  space: 'Space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  delete: 'Delete',
  insert: 'Insert',
  tab: 'Tab',
  backspace: 'Backspace',
}

/**
 * Convert a registry binding (`Cmd+Shift+Enter` / `Ctrl+Shift+Enter`) to
 * the accelerator syntax Tauri menus and the HTML menu bar use
 * (`CmdOrCtrl+Shift+Return`). The primary modifier becomes `CmdOrCtrl` so
 * one string reads correctly on every platform.
 */
export function toAccelerator(binding: string): string {
  const p = parseKeybinding(binding)
  const parts: string[] = []
  if (p.meta || p.ctrl) parts.push(p.meta && p.ctrl ? 'CmdOrCtrl+Ctrl' : 'CmdOrCtrl')
  if (p.alt) parts.push('Alt')
  if (p.shift) parts.push('Shift')
  const key = TAURI_KEY_NAMES[p.key] ?? (p.key.length === 1 ? p.key.toUpperCase() : p.key.charAt(0).toUpperCase() + p.key.slice(1))
  parts.push(key)
  return parts.join('+')
}

/** Accelerator to register a command with — derived from the action's default binding. */
export function defaultAccelerator(actionId: KeyboardAction): string {
  return toAccelerator(getPlatformBinding(DEFAULT_KEYBINDINGS[actionId]))
}

/** Accelerator reflecting the user's current binding for a command, else the registered one. */
export function currentAcceleratorForCommand(commandId: string, registered: string | undefined): string | undefined {
  const actionId = actionForCommand(commandId)
  return actionId ? toAccelerator(getCurrentBinding(actionId)) : registered
}
