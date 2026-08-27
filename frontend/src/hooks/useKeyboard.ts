/**
 * Keyboard shortcuts — customizable app-level keybindings.
 *
 * The bindings live in ONE module-level store shared by every `useKeyboard()`
 * instance (App's dispatcher, the Settings editor, tooltips), persisted to
 * localStorage and mirrored to the agent (`/settings/keybindings`) so a
 * rebind takes effect immediately everywhere and follows the user's profile.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { getClient } from '../api/client'

// Action identifiers for all keyboard shortcuts
export type KeyboardAction =
  | 'newTerminal'
  | 'newSession'
  | 'newDocument'
  | 'closeTab'
  | 'closeAllTabs'
  | 'reopenClosedTab'
  | 'quickConnect'
  | 'commandPalette'
  | 'findInTerminal'
  | 'saveTerminalOutput'
  | 'aiChat'
  | 'toggleAiChatPanel'
  | 'aiGenerateScript'
  | 'toggleSidebar'
  | 'nextTab'
  | 'previousTab'
  | 'toggleMultiSend'
  | 'reconnect'
  | 'settings'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'connectSelectedSessions'
  | 'quickLookNotes'
  | 'quickLookTemplates'
  | 'quickLookOutputs'
  | 'saveDocument'
  | 'runScript'
  | 'startTroubleshooting'
  | 'aiOverlay'
  | 'scratchpadOpen'
  | 'groupSelectedTabs'
  | 'saveTabsAsGroup'

// Platform-specific keybinding
export interface PlatformKeybinding {
  mac: string
  windows: string
}

export type KeyboardCategory = 'Terminal' | 'Navigation' | 'View' | 'Sessions' | 'AI' | 'Documents'

// Human-readable action info
export interface KeyboardActionInfo {
  id: KeyboardAction
  label: string
  category: KeyboardCategory
  defaultBinding: PlatformKeybinding
}

/** `mac: Cmd+X` / `windows: Ctrl+X` — the shape almost every default takes. */
const both = (chord: string): PlatformKeybinding => ({ mac: `Cmd+${chord}`, windows: `Ctrl+${chord}` })

// Default keybindings configuration
export const DEFAULT_KEYBINDINGS: Record<KeyboardAction, PlatformKeybinding> = {
  newTerminal: both('T'),
  newSession: both('N'),
  newDocument: both('Shift+N'),
  closeTab: both('W'),
  closeAllTabs: both('Shift+W'),
  reopenClosedTab: both('Shift+T'),
  quickConnect: both('Shift+Q'),
  commandPalette: both('Shift+P'),
  findInTerminal: both('F'),
  saveTerminalOutput: both('Shift+S'),
  aiChat: both('I'),
  toggleAiChatPanel: both('J'),
  aiGenerateScript: both('Shift+G'),
  toggleSidebar: both('B'),
  nextTab: both('Shift+]'),
  previousTab: both('Shift+['),
  toggleMultiSend: both('Shift+M'),
  reconnect: both('Shift+R'),
  settings: both(','),
  zoomIn: both('='),
  zoomOut: both('-'),
  zoomReset: both('0'),
  connectSelectedSessions: both('Shift+Enter'),
  // Quick Look chords must not collide with New Document (Cmd+Shift+N) or
  // Reopen Closed Tab (Cmd+Shift+T).
  quickLookNotes: both('Shift+E'),
  quickLookTemplates: both('Shift+L'),
  quickLookOutputs: both('Shift+U'),
  saveDocument: both('S'),
  runScript: both('Enter'),
  startTroubleshooting: both('Shift+K'),
  aiOverlay: both('Shift+A'),
  scratchpadOpen: both('Shift+J'),
  groupSelectedTabs: both('G'),
  // Cmd+Shift+G belongs to aiGenerateScript.
  saveTabsAsGroup: both('Shift+D'),
}

const action = (id: KeyboardAction, label: string, category: KeyboardCategory): KeyboardActionInfo =>
  ({ id, label, category, defaultBinding: DEFAULT_KEYBINDINGS[id] })

/** Action metadata for UI display, in the order the Keyboard settings page shows them. */
export const KEYBOARD_ACTIONS: KeyboardActionInfo[] = [
  // Terminal
  action('newTerminal', 'New Terminal', 'Terminal'),
  action('closeTab', 'Close Tab', 'Terminal'),
  action('reconnect', 'Reconnect Session', 'Terminal'),
  action('toggleMultiSend', 'Toggle Multi-Send', 'Terminal'),
  action('findInTerminal', 'Find in Terminal', 'Terminal'),
  action('saveTerminalOutput', 'Save Terminal Output to Docs', 'Terminal'),

  // Navigation
  action('commandPalette', 'Command Palette', 'Navigation'),
  action('toggleSidebar', 'Toggle Sidebar', 'Navigation'),
  action('nextTab', 'Next Tab', 'Navigation'),
  action('previousTab', 'Previous Tab', 'Navigation'),
  action('closeAllTabs', 'Close All Tabs', 'Navigation'),
  action('reopenClosedTab', 'Reopen Closed Tab', 'Navigation'),
  action('groupSelectedTabs', 'Group Selected Tabs', 'Navigation'),
  action('saveTabsAsGroup', 'Save Tabs as Group', 'Navigation'),

  // View
  action('settings', 'Open Settings', 'View'),
  action('zoomIn', 'Zoom In', 'View'),
  action('zoomOut', 'Zoom Out', 'View'),
  action('zoomReset', 'Actual Size', 'View'),
  action('quickLookNotes', 'Quick Look: Notes', 'View'),
  action('quickLookTemplates', 'Quick Look: Templates', 'View'),
  action('quickLookOutputs', 'Quick Look: Outputs', 'View'),
  action('scratchpadOpen', 'Open Scratchpad', 'View'),

  // Sessions
  action('newSession', 'New Session', 'Sessions'),
  action('quickConnect', 'Quick Connect', 'Sessions'),
  action('connectSelectedSessions', 'Connect Selected Sessions', 'Sessions'),
  action('startTroubleshooting', 'Start Troubleshooting Session', 'Sessions'),

  // AI
  action('aiChat', 'AI Assistant', 'AI'),
  action('toggleAiChatPanel', 'Toggle AI Chat Panel', 'AI'),
  action('aiOverlay', 'AI: Open Chat Tab', 'AI'),
  action('aiGenerateScript', 'AI Generate Script', 'AI'),

  // Documents
  action('newDocument', 'New Document', 'Documents'),
  action('saveDocument', 'Save Document', 'Documents'),
  action('runScript', 'Run Script', 'Documents'),
]

/** Category display order for the settings page — every category, so no action can be hidden. */
export const KEYBOARD_CATEGORIES: KeyboardCategory[] = ['Terminal', 'Navigation', 'View', 'Sessions', 'AI', 'Documents']

/**
 * Chords the app cannot give away: tab switching and the platform's own
 * edit/window keys. Offered to the editor so a rebind never silently loses.
 */
export const RESERVED_SHORTCUTS: { binding: PlatformKeybinding; label: string }[] = [
  ...Array.from({ length: 9 }, (_, i) => ({ binding: both(String(i + 1)), label: `Go to Tab ${i + 1}` })),
  { binding: both('Alt+N'), label: 'New Window' },
  { binding: both('C'), label: 'Copy' },
  { binding: both('V'), label: 'Paste' },
  { binding: both('X'), label: 'Cut' },
  { binding: both('A'), label: 'Select All' },
  { binding: both('Z'), label: 'Undo' },
  { binding: both('Shift+Z'), label: 'Redo' },
  { binding: { mac: 'Cmd+Q', windows: 'Alt+F4' }, label: 'Quit' },
  { binding: { mac: 'Cmd+H', windows: 'Ctrl+Shift+C' }, label: isMac() ? 'Hide NetStacks' : 'Copy (terminal)' },
  { binding: { mac: 'Cmd+M', windows: 'Ctrl+Shift+V' }, label: isMac() ? 'Minimize' : 'Paste (terminal)' },
]

// Detect platform
export function isMac(): boolean {
  return navigator.platform.toUpperCase().indexOf('MAC') >= 0
}

/**
 * Format a keyboard hint for the current platform. Accepts word style
 * ('Cmd+Shift+T', 'CmdOrCtrl+P') and mac glyph style ('⇧⌘S').
 * On mac the string is returned in Cmd form; elsewhere Cmd becomes Ctrl
 * and glyphs are expanded to words ('⇧⌘S' → 'Ctrl+Shift+S').
 */
export function displayShortcut(s: string): string {
  if (isMac()) return s.replace(/CmdOrCtrl/g, 'Cmd')
  const words = s
    .replace(/([⌘⇧⌥⌃])/g, '$1+')
    .replace(/⌘/g, 'Cmd')
    .replace(/⇧/g, 'Shift')
    .replace(/⌥/g, 'Alt')
    .replace(/⌃/g, 'Ctrl')
    .replace(/CmdOrCtrl|Cmd/g, 'Ctrl')
    .replace(/\+\++/g, '+')
    .replace(/\+$/, '')
  const modifierOrder = (p: string) => (p === 'Ctrl' ? 0 : p === 'Alt' ? 1 : p === 'Shift' ? 2 : 3)
  return words
    .split('+')
    .filter(Boolean)
    .sort((a, b) => modifierOrder(a) - modifierOrder(b))
    .join('+')
}

/**
 * Format a binding for display: mac glyphs (⌘⇧S) on macOS, `Ctrl+Shift+S`
 * words elsewhere. Used by every tooltip/menu that shows a shortcut.
 */
export function formatShortcut(binding: string): string {
  if (!binding) return ''
  if (!isMac()) return displayShortcut(binding)
  const p = parseKeybinding(binding)
  const key = p.key === 'enter' ? '⏎' : p.key === 'esc' ? '⎋' : p.key === 'space' ? '␣' : p.key.length === 1 ? p.key.toUpperCase() : capitalize(p.key)
  return `${p.ctrl ? '⌃' : ''}${p.alt ? '⌥' : ''}${p.shift ? '⇧' : ''}${p.meta ? '⌘' : ''}${key}`
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// Storage key
const STORAGE_KEY = 'netstacks-keybindings'
/** Agent settings key (`/settings/:key`) the overrides are mirrored to. */
const BACKEND_SETTING_KEY = 'keybindings'

// Parse a keybinding string into components
export function parseKeybinding(binding: string): {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  key: string
} {
  const parts = binding.split('+').map(p => p.trim())
  const key = parts[parts.length - 1]

  return {
    ctrl: parts.some(p => p === 'Ctrl'),
    shift: parts.some(p => p === 'Shift'),
    alt: parts.some(p => p === 'Alt'),
    meta: parts.some(p => p === 'Cmd' || p === 'Meta'),
    key: normalizeKeyName(key),
  }
}

/** Key-name aliases accepted in bindings, folded to one lowercase spelling. */
const KEY_ALIASES: Record<string, string> = {
  return: 'enter',
  escape: 'esc',
  ' ': 'space',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  del: 'delete',
  ins: 'insert',
}

function normalizeKeyName(key: string): string {
  const lower = key.toLowerCase()
  return KEY_ALIASES[lower] ?? lower
}

/**
 * Canonical spelling of a binding (`Ctrl+Alt+Shift+Cmd+key`), so two
 * strings that mean the same chord compare equal regardless of modifier
 * order, `Meta` vs `Cmd`, or key aliases (`Enter` vs `Return`).
 */
export function canonicalBinding(binding: string): string {
  const p = parseKeybinding(binding)
  return [p.ctrl && 'Ctrl', p.alt && 'Alt', p.shift && 'Shift', p.meta && 'Cmd', p.key].filter(Boolean).join('+')
}

// Convert a keyboard event to a binding string
export function eventToBinding(e: KeyboardEvent): string {
  const parts: string[] = []

  if (e.metaKey) parts.push(isMac() ? 'Cmd' : 'Meta')
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')

  // Get the key
  let key = e.key

  // Normalize special keys
  const specialKeys: Record<string, string> = {
    'Control': '',
    'Shift': '',
    'Alt': '',
    'Meta': '',
    'ArrowUp': 'Up',
    'ArrowDown': 'Down',
    'ArrowLeft': 'Left',
    'ArrowRight': 'Right',
    ' ': 'Space',
    'Escape': 'Esc',
  }

  if (specialKeys[key] !== undefined) {
    key = specialKeys[key]
  }

  // Skip if only modifier pressed
  if (!key) return ''

  // Capitalize single letters
  if (key.length === 1) {
    key = key.toUpperCase()
  }

  parts.push(key)

  return parts.join('+')
}

// Check if an event matches a binding
export function matchesBinding(e: KeyboardEvent, binding: string): boolean {
  const parsed = parseKeybinding(binding)

  // Check modifiers — both Ctrl and Meta states must match the binding spec.
  // The Windows branch previously used ||, which meant bindings like Ctrl+W
  // would match a bare W keypress (parsed.meta===false matches e.metaKey===false).
  const metaMatch = parsed.meta === e.metaKey && parsed.ctrl === e.ctrlKey

  if (!metaMatch) return false
  if (parsed.shift !== e.shiftKey) return false
  if (parsed.alt !== e.altKey) return false

  return normalizeKeyName(e.key) === parsed.key
}

// Get the platform-appropriate binding from a PlatformKeybinding
export function getPlatformBinding(binding: PlatformKeybinding): string {
  return isMac() ? binding.mac : binding.windows
}

export type KeyboardActionHandler = () => void | boolean

/**
 * True when a keydown targeted a plain text-entry element. Single-modifier
 * chords (Ctrl+W, Cmd+S, …) inside these are left to the element / its
 * component; multi-modifier chords still reach the global bindings.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type)
  }
  return false
}

/**
 * Decide whether a matched binding should be swallowed by the global
 * listener or left to the focused element. Exported for tests.
 *
 * - Inside xterm, single-Ctrl chords (Ctrl+W/T/B/F/I/S…) are readline
 *   keys — the terminal owns them. Cmd-based chords on macOS still fire.
 * - Inside a text-entry element, any single-modifier chord is left alone.
 */
export function shouldDeferToTarget(target: EventTarget | null, binding: string): boolean {
  const el = target instanceof HTMLElement ? target : null
  if (!el) return false
  const parsed = parseKeybinding(binding)
  const modifierCount = [parsed.ctrl, parsed.shift, parsed.alt, parsed.meta].filter(Boolean).length
  // xterm's key events originate from its helper textarea — apply only the
  // terminal rule there, so Cmd+W/T on macOS still reach the app.
  if (el.closest('.xterm')) return parsed.ctrl && !parsed.meta && modifierCount === 1
  return isTextEntryTarget(el) && modifierCount === 1
}

// ── Shared store ───────────────────────────────────────────────────────

export type CustomKeybindings = Partial<Record<KeyboardAction, PlatformKeybinding>>
export type Keybindings = Record<KeyboardAction, PlatformKeybinding>

/** Keep only well-formed overrides for actions that still exist. */
function sanitizeCustomBindings(raw: unknown): CustomKeybindings {
  if (!raw || typeof raw !== 'object') return {}
  const out: CustomKeybindings = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(id in DEFAULT_KEYBINDINGS)) continue
    const v = value as Partial<PlatformKeybinding> | undefined
    if (!v || typeof v !== 'object') continue
    const def = DEFAULT_KEYBINDINGS[id as KeyboardAction]
    out[id as KeyboardAction] = {
      mac: typeof v.mac === 'string' && v.mac ? v.mac : def.mac,
      windows: typeof v.windows === 'string' && v.windows ? v.windows : def.windows,
    }
  }
  return out
}

function readStoredBindings(): CustomKeybindings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? sanitizeCustomBindings(JSON.parse(stored)) : {}
  } catch (err) {
    console.error('Failed to load keybindings from localStorage:', err)
    return {}
  }
}

const listeners = new Set<() => void>()
let customBindings: CustomKeybindings = readStoredBindings()
let bindingsSnapshot: Keybindings = { ...DEFAULT_KEYBINDINGS, ...customBindings }

function commitBindings(next: CustomKeybindings, persist: boolean): void {
  customBindings = next
  bindingsSnapshot = { ...DEFAULT_KEYBINDINGS, ...next }
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch (err) {
      console.error('Failed to save keybindings to localStorage:', err)
    }
  }
  listeners.forEach(l => l())
}

// Another window (pop-out terminal, second main window) rebinding a key
// writes the same localStorage key — pick it up without a restart.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) commitBindings(readStoredBindings(), false)
  })
}

export function subscribeKeybindings(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Every action's binding (defaults with the user's overrides applied). */
export function getKeybindings(): Keybindings {
  return bindingsSnapshot
}

/** Current platform binding for an action — usable outside React (terminal, menus). */
export function getCurrentBinding(actionId: KeyboardAction): string {
  return getPlatformBinding(bindingsSnapshot[actionId])
}

export function setKeybinding(actionId: KeyboardAction, bindingStr: string): void {
  const platform = isMac() ? 'mac' : 'windows'
  const current = customBindings[actionId] ?? DEFAULT_KEYBINDINGS[actionId]
  commitBindings({ ...customBindings, [actionId]: { ...current, [platform]: bindingStr } }, true)
}

export function resetKeybinding(actionId: KeyboardAction): void {
  const next = { ...customBindings }
  delete next[actionId]
  commitBindings(next, true)
}

export function resetAllKeybindings(): void {
  commitBindings({}, true)
}

export function isKeybindingCustomized(actionId: KeyboardAction): boolean {
  return canonicalBinding(getCurrentBinding(actionId)) !== canonicalBinding(getPlatformBinding(DEFAULT_KEYBINDINGS[actionId]))
}

/** What a chord is already used by: another action, or a reserved app/system key. */
export interface KeybindingConflict {
  action?: KeyboardAction
  label: string
}

/** The action or reserved key that currently owns a chord, if any. */
export function findShortcutOwner(bindingStr: string): KeybindingConflict | null {
  const wanted = canonicalBinding(bindingStr)
  const owner = KEYBOARD_ACTIONS.find(info => canonicalBinding(getCurrentBinding(info.id)) === wanted)
  if (owner) return { action: owner.id, label: owner.label }
  const reserved = RESERVED_SHORTCUTS.find(r => canonicalBinding(getPlatformBinding(r.binding)) === wanted)
  return reserved ? { label: reserved.label } : null
}

/** Like `findShortcutOwner`, ignoring the action being edited. */
export function findKeybindingConflict(actionId: KeyboardAction, bindingStr: string): KeybindingConflict | null {
  const owner = findShortcutOwner(bindingStr)
  return owner?.action === actionId ? null : owner
}

/** Mirror the overrides to the agent so they follow the user's profile. */
export async function saveKeybindingsToBackend(): Promise<void> {
  try {
    await getClient().http.put(`/settings/${BACKEND_SETTING_KEY}`, customBindings)
  } catch (err) {
    console.error('Failed to save keybindings to backend:', err)
  }
}

/**
 * Load the overrides stored on the agent. The agent copy is the profile's
 * source of truth: when it has bindings they replace the local cache; an
 * empty/absent agent copy leaves whatever is cached locally.
 */
export async function loadKeybindingsFromBackend(): Promise<void> {
  try {
    const { data } = await getClient().http.get(`/settings/${BACKEND_SETTING_KEY}`)
    if (data && typeof data === 'object' && Object.keys(data).length > 0) {
      commitBindings(sanitizeCustomBindings(data), true)
    }
  } catch (err) {
    console.error('Failed to load keybindings from backend:', err)
  }
}

/** React subscription to the current bindings. */
export function useKeybindings(): Keybindings {
  return useSyncExternalStore(subscribeKeybindings, getKeybindings, getKeybindings)
}

/** Display label for an action's current binding (re-renders on rebind). */
export function useShortcut(actionId: KeyboardAction): string {
  const bindings = useKeybindings()
  return formatShortcut(getPlatformBinding(bindings[actionId]))
}

// Hook return type
export interface UseKeyboardReturn {
  // Current bindings (custom overrides merged with defaults)
  bindings: Keybindings

  // Get the current binding for an action
  getBinding: (action: KeyboardAction) => string

  // Set a custom binding for an action (persists locally and to the agent)
  setBinding: (action: KeyboardAction, binding: string) => void

  // Reset a single action to default
  resetBinding: (action: KeyboardAction) => void

  // Reset all bindings to defaults
  resetAllToDefaults: () => void

  // Whether the action's binding differs from its default
  isCustomized: (action: KeyboardAction) => boolean

  // Check if a binding conflicts with another action or a reserved key
  findConflict: (action: KeyboardAction, binding: string) => KeybindingConflict | null

  // Register an action handler. A handler may return `false` to decline the
  // event — the key then passes through untouched (no preventDefault) so a
  // component-level listener (e.g. SFTP editor's own Cmd+S) can handle it.
  registerAction: (action: KeyboardAction, handler: KeyboardActionHandler) => void

  // Unregister an action handler
  unregisterAction: (action: KeyboardAction) => void
}

export function useKeyboard(): UseKeyboardReturn {
  const bindings = useKeybindings()

  // Action handlers registered by this instance
  const handlersRef = useRef<Partial<Record<KeyboardAction, KeyboardActionHandler>>>({})

  const getBinding = useCallback((actionId: KeyboardAction): string => getPlatformBinding(bindings[actionId]), [bindings])

  const setBinding = useCallback((actionId: KeyboardAction, bindingStr: string) => {
    setKeybinding(actionId, bindingStr)
    void saveKeybindingsToBackend()
  }, [])

  const resetBinding = useCallback((actionId: KeyboardAction) => {
    resetKeybinding(actionId)
    void saveKeybindingsToBackend()
  }, [])

  const resetAllToDefaults = useCallback(() => {
    resetAllKeybindings()
    void saveKeybindingsToBackend()
  }, [])

  // `bindings` in the deps keeps these in step with the store for callers that memoize on them.
  const isCustomized = useCallback((actionId: KeyboardAction) => isKeybindingCustomized(actionId), [bindings]) // eslint-disable-line react-hooks/exhaustive-deps
  const findConflict = useCallback(
    (actionId: KeyboardAction, bindingStr: string) => findKeybindingConflict(actionId, bindingStr),
    [bindings], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const registerAction = useCallback((actionId: KeyboardAction, handler: KeyboardActionHandler) => {
    handlersRef.current[actionId] = handler
  }, [])

  const unregisterAction = useCallback((actionId: KeyboardAction) => {
    delete handlersRef.current[actionId]
  }, [])

  // Global keydown handler — only instances that registered handlers do work.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't steal shortcuts from Monaco editors. The capture-phase
      // listener used to swallow Cmd+I (and any other binding Monaco
      // also handled) before Monaco saw the key, breaking the inline
      // AI overlord widget. Letting focused Monaco instances win means
      // the per-editor addAction registrations actually fire.
      const target = e.target as HTMLElement | null
      if (target?.closest?.('.monaco-editor')) return

      for (const [actionId, handler] of Object.entries(handlersRef.current)) {
        if (!handler) continue
        const platformBinding = getPlatformBinding(bindings[actionId as KeyboardAction])
        if (!matchesBinding(e, platformBinding)) continue
        // xterm (readline Ctrl+W/T/…) and text inputs own single-modifier
        // chords — never steal them from the focused element.
        if (shouldDeferToTarget(e.target, platformBinding)) return
        if (handler() === false) return
        e.preventDefault()
        e.stopPropagation()
        return
      }
    }

    // Use capture phase to intercept before other handlers
    document.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [bindings])

  return {
    bindings,
    getBinding,
    setBinding,
    resetBinding,
    resetAllToDefaults,
    isCustomized,
    findConflict,
    registerAction,
    unregisterAction,
  }
}
