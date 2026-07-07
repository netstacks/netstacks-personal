/**
 * Structure of the Windows/Linux HTML menu bar. Mirrors the native
 * macOS menu built in src-tauri/src/main.rs::build_menu. Command ids
 * match the right-hand side of MENU_ID_TO_COMMAND (menuBridge.ts);
 * labels + accelerators are read from the registered Command objects.
 */
export type MenuEntry =
  | { kind: 'command'; commandId: string }
  | { kind: 'separator' }
  | { kind: 'predefined'; action:
      | 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'
      | 'fullscreen' | 'minimize' | 'maximize' }

export interface MenuSection { title: string; entries: MenuEntry[] }

const sep: MenuEntry = { kind: 'separator' }
const cmd = (commandId: string): MenuEntry => ({ kind: 'command', commandId })
const pre = (action: Extract<MenuEntry, { kind: 'predefined' }>['action']): MenuEntry =>
  ({ kind: 'predefined', action })

export const MENU_MODEL: MenuSection[] = [
  { title: 'File', entries: [
    cmd('file.new-session'), cmd('file.new-terminal'), cmd('file.new-document'), sep,
    cmd('file.quick-connect'), sep,
    cmd('file.save'), sep,
    cmd('file.close-tab'), sep,
    cmd('app.settings'),
  ]},
  { title: 'Edit', entries: [
    pre('undo'), pre('redo'), sep,
    pre('cut'), pre('copy'), pre('paste'), pre('selectAll'), sep,
    cmd('edit.find'),
  ]},
  { title: 'View', entries: [
    cmd('view.command-palette'), sep,
    cmd('view.toggle-sidebar'), cmd('view.toggle-ai-panel'), sep,
    cmd('view.zoom-reset'), cmd('view.zoom-in'), cmd('view.zoom-out'), sep,
    pre('fullscreen'),
  ]},
  { title: 'Session', entries: [
    cmd('session.reconnect'), cmd('session.toggle-multi-send'), sep,
    cmd('session.connect-selected'), sep,
    cmd('workspace.openRemoteWindow'), sep,
    cmd('session.start-troubleshooting'),
  ]},
  { title: 'Tools', entries: [
    cmd('tools.quick-actions'), cmd('tools.snippets'), cmd('tools.mapped-keys'), sep,
    cmd('tools.vault'), cmd('tools.host-keys'), sep,
    cmd('tools.recordings'), cmd('tools.session-logs'), cmd('tools.layouts'),
  ]},
  { title: 'AI', entries: [
    cmd('ai.toggle-chat'), sep,
    cmd('ai.settings'), cmd('ai.mcp-servers'), cmd('ai.memory'),
  ]},
  { title: 'Window', entries: [
    pre('minimize'), pre('maximize'), sep,
    cmd('window.next-tab'), cmd('window.previous-tab'), sep,
    cmd('window.close-all-tabs'), cmd('window.close-tabs-right'), cmd('window.reopen-closed-tab'),
  ]},
  { title: 'Help', entries: [
    cmd('help.docs'), sep,
    cmd('help.about'),
  ]},
]
