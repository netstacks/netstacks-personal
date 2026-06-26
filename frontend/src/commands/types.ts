/**
 * Command system — type definitions.
 *
 * Every user-actionable thing in the app (open a tab, save, reconnect,
 * toggle a panel, copy a row, …) is modeled as a Command. Commands are
 * registered with the CommandRegistry and consumed by:
 *
 *   - The native menu bar (Tauri's File / Edit / View / Session / …)
 *   - Right-click context menus throughout the app
 *   - The forthcoming Command Palette (Cmd+Shift+P)
 *   - Keyboard accelerators
 *
 * Centralising commands here is a one-time investment that pays off
 * forever: adding a new action is one registration call, and every
 * surface that can run commands picks it up automatically.
 *
 * Stability contract:
 *   - Command IDs are part of the public-ish API (menu accelerators,
 *     telemetry, debug logging) — choose them carefully and never
 *     rename without a deprecation path.
 *   - Categories drive grouping in the Palette and Help menu.
 *   - `when` predicates run on every ActiveContext change, so they
 *     must be cheap and pure.
 */

/**
 * Top-level category for a command. Drives grouping in the Command
 * Palette and helps the native menu builder decide which submenu owns
 * the command. New categories should be added thoughtfully — the
 * point of a small fixed set is consistency.
 */
export type CommandCategory =
  | 'file'        // New / Open / Save / Close / Import / Export / Quit
  | 'edit'        // Undo / Redo / Copy / Paste / Find / Replace / Select
  | 'view'        // Zoom / Toggle panels / Theme / Full-screen
  | 'session'     // Connect / Disconnect / Reconnect / Broadcast / Multi-send
  | 'terminal'    // Clear / Send break / Reset / Scrollback / Copy-as-X
  | 'topology'    // Discover / Layout / Snapshot / Diff
  | 'document'    // Export / Print / Outline
  | 'workspace'   // Switch / Reload / Open in finder / Git
  | 'sftp'        // Upload / Download / Rename / Permissions
  | 'tools'       // Quick Actions / Snippets / Mapped Keys / Vault / Recordings / Layouts
  | 'ai'          // Settings / MCP / Memory / Generate / Run agent
  | 'window'      // Tabs / New window / Next-prev tab
  | 'navigation'  // Open recent / Jump to / Activity bar
  | 'help'        // Docs / About / Report bug / Diagnostics

/**
 * Snapshot of "what's active right now" — passed to every `when`
 * predicate. Kept intentionally small; expand only when a real command
 * needs the new field. Bigger context = more re-evaluation on every
 * tab switch.
 */
export interface ActiveContext {
  /** Type discriminator for the active tab, or null if no tab open. */
  activeTabType:
    | 'terminal'
    | 'document'
    | 'topology'
    | 'device-detail'
    | 'link-detail'
    | 'sftp'
    | 'sftp-editor'
    | 'mop'
    | 'script'
    | 'workspace'
    | 'settings'
    | 'api-response'
    | 'incident-detail'
    | 'alert-detail'
    | 'stack-detail'
    | 'backup-history'
    | 'config-template'
    | 'config-stack'
    | 'config-instance'
    | 'config-deployment'
    | null

  /** Active tab's stable id, or null. */
  activeTabId: string | null

  /** Connection state of the active terminal tab (null if not a
   *  terminal tab or status is unknown). */
  terminalStatus: 'connecting' | 'connected' | 'disconnected' | 'error' | null

  /** True if the active document/script/etc. has unsaved edits. */
  isDirty: boolean

  /** Active sidebar view ('sessions' | 'topology' | 'workspaces' | ...).
   *  Lets sidebar-scoped commands gate themselves to the right view. */
  activeSidebarView: string | null

  /** Number of items currently selected in the active sidebar panel
   *  (sessions, devices, etc.). 0 when nothing selected. */
  selectionCount: number

  /** Whether the app is running in enterprise (controller) mode.
   *  Some commands only make sense in one mode. */
  isEnterprise: boolean
}

/** Predicate signature for a command's `when` gate. */
export type WhenPredicate = (ctx: ActiveContext) => boolean

/**
 * A registered command. Once registered, surfaces (menu, context menu,
 * palette) read this verbatim — they don't fork or wrap the action,
 * which keeps behavior identical across entry points.
 */
export interface Command {
  /**
   * Stable, dotted identifier. Convention: `<category>.<action>` or
   * `<category>.<scope>.<action>`. Examples:
   *   - `session.reconnect`
   *   - `terminal.clear`
   *   - `terminal.copy`
   *   - `workspace.git.commit`
   *
   * Never rename without a deprecation alias.
   */
  id: string

  /**
   * Human-readable label as shown in menus. Title case, no trailing
   * punctuation. Use the ellipsis character (…) for commands that
   * open a dialog requiring further input ("Quick Connect…").
   */
  label: string

  /** Category for grouping. See CommandCategory. */
  category: CommandCategory

  /**
   * Optional accelerator in Tauri's format ("CmdOrCtrl+Shift+P").
   * Shown next to the label in menus. The actual key binding is
   * registered separately on the native menu — this string is just
   * for display + parity-check.
   */
  accelerator?: string

  /**
   * Gate predicate. Returns true when the command can run in the
   * current ActiveContext. When false, the command appears disabled
   * in menus and is filtered out of the context-sensitive Palette
   * results. Defaults to "always available" when omitted.
   *
   * MUST be pure and cheap — it runs on every ActiveContext change.
   * Don't do API calls or DOM reads here.
   */
  when?: WhenPredicate

  /**
   * The action to perform. Synchronous or async. Errors surface as
   * toasts (handled by the dispatcher) — don't try/catch inside
   * `run` unless you want different UX than "show toast on failure".
   */
  run: () => void | Promise<void>

  /**
   * Optional one-line description for the Palette and tooltips. Should
   * complement the label, not repeat it. E.g. label "Clear" +
   * description "Empty the terminal scrollback".
   */
  description?: string

  /**
   * Optional icon component (e.g. an SVG). Used by Palette and
   * potentially toolbar surfaces. Menus don't render icons today.
   */
  icon?: React.ReactNode
}
