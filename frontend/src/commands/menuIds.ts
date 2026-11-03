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
  'redraw-terminal': 'view.redraw-terminal',
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

  // MOP
  'new-mop': 'file.new-mop',
  'save-mop': 'mop.save',
  'mop-start': 'mop.start',
  'mop-run-next': 'mop.run-next',
  'mop-abort': 'mop.abort',
  'mop-complete': 'mop.complete',

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
