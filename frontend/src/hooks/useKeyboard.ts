/**
 * Keyboard shortcuts hook - manages customizable keybindings
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { getClient } from '../api/client'

// Action identifiers for all keyboard shortcuts
export type KeyboardAction =
  | 'newTerminal'
  | 'closeTab'
  | 'quickConnect'
  | 'commandPalette'
  | 'findInTerminal'
  | 'aiChat'
  | 'aiGenerateScript'
  | 'toggleSidebar'
  | 'nextTab'
  | 'previousTab'
  | 'toggleMultiSend'
  | 'reconnect'
  | 'settings'
  | 'connectSelectedSessions'
  | 'quickLookNotes'
  | 'quickLookTemplates'
  | 'quickLookOutputs'
  | 'saveDocument'
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

// Human-readable action info
export interface KeyboardActionInfo {
  id: KeyboardAction
  label: string
  category: 'Terminal' | 'Navigation' | 'AI' | 'Scripts' | 'View' | 'Sessions'
  defaultBinding: PlatformKeybinding
}

// Default keybindings configuration
export const DEFAULT_KEYBINDINGS: Record<KeyboardAction, PlatformKeybinding> = {
  newTerminal: { mac: 'Cmd+T', windows: 'Ctrl+T' },
  closeTab: { mac: 'Cmd+W', windows: 'Ctrl+W' },
  quickConnect: { mac: 'Cmd+Shift+Q', windows: 'Ctrl+Shift+Q' },
  commandPalette: { mac: 'Cmd+Shift+P', windows: 'Ctrl+Shift+P' },
  findInTerminal: { mac: 'Cmd+F', windows: 'Ctrl+F' },
  aiChat: { mac: 'Cmd+I', windows: 'Ctrl+I' },
  aiGenerateScript: { mac: 'Cmd+Shift+G', windows: 'Ctrl+Shift+G' },
  toggleSidebar: { mac: 'Cmd+B', windows: 'Ctrl+B' },
  nextTab: { mac: 'Cmd+Shift+]', windows: 'Ctrl+Shift+]' },
  previousTab: { mac: 'Cmd+Shift+[', windows: 'Ctrl+Shift+[' },
  toggleMultiSend: { mac: 'Cmd+Shift+M', windows: 'Ctrl+Shift+M' },
  reconnect: { mac: 'Cmd+Shift+R', windows: 'Ctrl+Shift+R' },
  settings: { mac: 'Cmd+,', windows: 'Ctrl+,' },
  connectSelectedSessions: { mac: 'Cmd+Shift+Enter', windows: 'Ctrl+Shift+Enter' },
  // Quick Look chords must not collide with native menu accelerators
  // (Cmd+Shift+N = New Document, Cmd+Shift+T = Reopen Closed Tab).
  quickLookNotes: { mac: 'Cmd+Shift+E', windows: 'Ctrl+Shift+E' },
  quickLookTemplates: { mac: 'Cmd+Shift+L', windows: 'Ctrl+Shift+L' },
  quickLookOutputs: { mac: 'Cmd+Shift+U', windows: 'Ctrl+Shift+U' },
  saveDocument: { mac: 'Cmd+S', windows: 'Ctrl+S' },
  startTroubleshooting: { mac: 'Cmd+Shift+K', windows: 'Ctrl+Shift+K' },
  aiOverlay: { mac: 'Cmd+Shift+A', windows: 'Ctrl+Shift+A' },
  scratchpadOpen: { mac: 'Cmd+Shift+J', windows: 'Ctrl+Shift+J' },
  groupSelectedTabs: { mac: 'Cmd+G', windows: 'Ctrl+G' },
  // Cmd+Shift+G belongs to aiGenerateScript — the old raw window listener
  // for save-as-group used the same chord and never fired.
  saveTabsAsGroup: { mac: 'Cmd+Shift+D', windows: 'Ctrl+Shift+D' },
}

// Action metadata for UI display
export const KEYBOARD_ACTIONS: KeyboardActionInfo[] = [
  // Terminal
  { id: 'newTerminal', label: 'New Terminal', category: 'Terminal', defaultBinding: DEFAULT_KEYBINDINGS.newTerminal },
  { id: 'closeTab', label: 'Close Tab', category: 'Terminal', defaultBinding: DEFAULT_KEYBINDINGS.closeTab },
  { id: 'reconnect', label: 'Reconnect Session', category: 'Terminal', defaultBinding: DEFAULT_KEYBINDINGS.reconnect },
  { id: 'toggleMultiSend', label: 'Toggle Multi-Send', category: 'Terminal', defaultBinding: DEFAULT_KEYBINDINGS.toggleMultiSend },

  // Navigation
  { id: 'commandPalette', label: 'Command Palette', category: 'Navigation', defaultBinding: DEFAULT_KEYBINDINGS.commandPalette },
  { id: 'toggleSidebar', label: 'Toggle Sidebar', category: 'Navigation', defaultBinding: DEFAULT_KEYBINDINGS.toggleSidebar },
  { id: 'nextTab', label: 'Next Tab', category: 'Navigation', defaultBinding: DEFAULT_KEYBINDINGS.nextTab },
  { id: 'previousTab', label: 'Previous Tab', category: 'Navigation', defaultBinding: DEFAULT_KEYBINDINGS.previousTab },
  { id: 'quickConnect', label: 'Quick Connect', category: 'Navigation', defaultBinding: DEFAULT_KEYBINDINGS.quickConnect },
  { id: 'findInTerminal', label: 'Find in Terminal', category: 'Navigation', defaultBinding: DEFAULT_KEYBINDINGS.findInTerminal },
  { id: 'settings', label: 'Open Settings', category: 'View', defaultBinding: DEFAULT_KEYBINDINGS.settings },

  // AI
  { id: 'aiChat', label: 'AI Assistant', category: 'AI', defaultBinding: DEFAULT_KEYBINDINGS.aiChat },
  { id: 'aiGenerateScript', label: 'AI Generate Script', category: 'AI', defaultBinding: DEFAULT_KEYBINDINGS.aiGenerateScript },
  { id: 'aiOverlay', label: 'AI: Open Chat Tab', category: 'AI', defaultBinding: DEFAULT_KEYBINDINGS.aiOverlay },

  // Sessions
  { id: 'connectSelectedSessions', label: 'Connect Selected Sessions', category: 'Sessions', defaultBinding: DEFAULT_KEYBINDINGS.connectSelectedSessions },

  // Documents
  { id: 'saveDocument', label: 'Save Document', category: 'Navigation', defaultBinding: DEFAULT_KEYBINDINGS.saveDocument },
  { id: 'quickLookNotes', label: 'Quick Look: Notes', category: 'View', defaultBinding: DEFAULT_KEYBINDINGS.quickLookNotes },
  { id: 'quickLookTemplates', label: 'Quick Look: Templates', category: 'View', defaultBinding: DEFAULT_KEYBINDINGS.quickLookTemplates },
  { id: 'quickLookOutputs', label: 'Quick Look: Outputs', category: 'View', defaultBinding: DEFAULT_KEYBINDINGS.quickLookOutputs },

  // Troubleshooting (Phase 26)
  { id: 'startTroubleshooting', label: 'Start Troubleshooting Session', category: 'Sessions', defaultBinding: DEFAULT_KEYBINDINGS.startTroubleshooting },

  // Scratchpad
  { id: 'scratchpadOpen', label: 'Open Scratchpad', category: 'View', defaultBinding: DEFAULT_KEYBINDINGS.scratchpadOpen },

  // Tab groups
  { id: 'groupSelectedTabs', label: 'Group Selected Tabs', category: 'Navigation', defaultBinding: DEFAULT_KEYBINDINGS.groupSelectedTabs },
  { id: 'saveTabsAsGroup', label: 'Save Tabs as Group', category: 'Navigation', defaultBinding: DEFAULT_KEYBINDINGS.saveTabsAsGroup },
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

// Storage key
const STORAGE_KEY = 'netstacks-keybindings'

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
    key: key.toLowerCase(),
  }
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

  // Check key
  const eventKey = e.key.toLowerCase()
  const bindingKey = parsed.key.toLowerCase()

  // Handle special key mappings
  const keyMappings: Record<string, string[]> = {
    'enter': ['enter'],
    'esc': ['escape'],
    'space': [' '],
    'up': ['arrowup'],
    'down': ['arrowdown'],
    'left': ['arrowleft'],
    'right': ['arrowright'],
    '[': ['['],
    ']': [']'],
  }

  if (keyMappings[bindingKey]) {
    return keyMappings[bindingKey].includes(eventKey)
  }

  return eventKey === bindingKey
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

// Hook return type
export interface UseKeyboardReturn {
  // Current bindings (custom overrides merged with defaults)
  bindings: Record<KeyboardAction, PlatformKeybinding>

  // Get the current binding for an action
  getBinding: (action: KeyboardAction) => string

  // Set a custom binding for an action
  setBinding: (action: KeyboardAction, binding: string) => void

  // Reset a single action to default
  resetBinding: (action: KeyboardAction) => void

  // Reset all bindings to defaults
  resetAllToDefaults: () => void

  // Check if a binding has a conflict with another action
  findConflict: (action: KeyboardAction, binding: string) => KeyboardAction | null

  // Register an action handler. A handler may return `false` to decline the
  // event — the key then passes through untouched (no preventDefault) so a
  // component-level listener (e.g. SFTP editor's own Cmd+S) can handle it.
  registerAction: (action: KeyboardAction, handler: KeyboardActionHandler) => void

  // Unregister an action handler
  unregisterAction: (action: KeyboardAction) => void

  // Save bindings to backend
  saveToBackend: () => Promise<void>

  // Load bindings from backend
  loadFromBackend: () => Promise<void>
}

export function useKeyboard(): UseKeyboardReturn {
  // Custom bindings (only stores overrides)
  const [customBindings, setCustomBindings] = useState<Partial<Record<KeyboardAction, PlatformKeybinding>>>({})

  // Action handlers
  const handlersRef = useRef<Partial<Record<KeyboardAction, KeyboardActionHandler>>>({})

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        setCustomBindings(JSON.parse(stored))
      }
    } catch (err) {
      console.error('Failed to load keybindings from localStorage:', err)
    }
  }, [])

  // Save to localStorage when bindings change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(customBindings))
    } catch (err) {
      console.error('Failed to save keybindings to localStorage:', err)
    }
  }, [customBindings])

  // Merge custom bindings with defaults
  const bindings: Record<KeyboardAction, PlatformKeybinding> = {
    ...DEFAULT_KEYBINDINGS,
    ...customBindings,
  }

  // Get binding for an action
  const getBinding = useCallback((action: KeyboardAction): string => {
    const binding = bindings[action] || DEFAULT_KEYBINDINGS[action]
    return getPlatformBinding(binding)
  }, [bindings])

  // Set a custom binding
  const setBinding = useCallback((action: KeyboardAction, bindingStr: string) => {
    const platform = isMac() ? 'mac' : 'windows'
    const otherPlatform = isMac() ? 'windows' : 'mac'

    setCustomBindings(prev => ({
      ...prev,
      [action]: {
        ...DEFAULT_KEYBINDINGS[action],
        ...prev[action],
        [platform]: bindingStr,
        // Keep the other platform binding
        [otherPlatform]: prev[action]?.[otherPlatform] || DEFAULT_KEYBINDINGS[action][otherPlatform],
      },
    }))
  }, [])

  // Reset a single binding
  const resetBinding = useCallback((action: KeyboardAction) => {
    setCustomBindings(prev => {
      const next = { ...prev }
      delete next[action]
      return next
    })
  }, [])

  // Reset all bindings
  const resetAllToDefaults = useCallback(() => {
    setCustomBindings({})
  }, [])

  // Find conflict with another action
  const findConflict = useCallback((action: KeyboardAction, bindingStr: string): KeyboardAction | null => {
    const bindingLower = bindingStr.toLowerCase()

    for (const [key, value] of Object.entries(bindings)) {
      if (key === action) continue

      const currentBinding = getPlatformBinding(value).toLowerCase()
      if (currentBinding === bindingLower) {
        return key as KeyboardAction
      }
    }

    return null
  }, [bindings])

  // Register action handler
  const registerAction = useCallback((action: KeyboardAction, handler: KeyboardActionHandler) => {
    handlersRef.current[action] = handler
  }, [])

  // Unregister action handler
  const unregisterAction = useCallback((action: KeyboardAction) => {
    delete handlersRef.current[action]
  }, [])

  // Global keydown handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't steal shortcuts from Monaco editors. The capture-phase
      // listener used to swallow Cmd+I (and any other binding Monaco
      // also handled) before Monaco saw the key, breaking the inline
      // AI overlord widget. Letting focused Monaco instances win means
      // the per-editor addAction registrations actually fire.
      const target = e.target as HTMLElement | null
      if (target?.closest?.('.monaco-editor')) return

      // Check each registered action
      for (const [action, handler] of Object.entries(handlersRef.current)) {
        if (!handler) continue

        const binding = bindings[action as KeyboardAction]
        if (!binding) continue

        const platformBinding = getPlatformBinding(binding)

        if (matchesBinding(e, platformBinding)) {
          // xterm (readline Ctrl+W/T/…) and text inputs own single-modifier
          // chords — never steal them from the focused element.
          if (shouldDeferToTarget(e.target, platformBinding)) return
          if (handler() === false) return
          e.preventDefault()
          e.stopPropagation()
          return
        }
      }
    }

    // Use capture phase to intercept before other handlers
    document.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [bindings])

  // Backend sync functions
  const saveToBackend = useCallback(async () => {
    try {
      await getClient().http.put('/settings/keybindings', customBindings)
    } catch (err) {
      console.error('Failed to save keybindings to backend:', err)
    }
  }, [customBindings])

  const loadFromBackend = useCallback(async () => {
    try {
      const { data } = await getClient().http.get('/settings/keybindings')
      if (data && typeof data === 'object') {
        setCustomBindings(data)
      }
    } catch (err) {
      console.error('Failed to load keybindings from backend:', err)
    }
  }, [])

  return {
    bindings,
    getBinding,
    setBinding,
    resetBinding,
    resetAllToDefaults,
    findConflict,
    registerAction,
    unregisterAction,
    saveToBackend,
    loadFromBackend,
  }
}
