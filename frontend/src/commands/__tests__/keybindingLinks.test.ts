import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ACTION_LINKS, actionForCommand, defaultAccelerator, toAccelerator } from '../keybindingLinks'
import { MENU_ID_TO_COMMAND } from '../menuBridge'
import { MENU_MODEL } from '../menuModel'
import { DEFAULT_KEYBINDINGS, type KeyboardAction } from '../../hooks/useKeyboard'

describe('toAccelerator', () => {
  it('converts registry bindings to Tauri accelerator syntax', () => {
    expect(toAccelerator('Cmd+Shift+Enter')).toBe('CmdOrCtrl+Shift+Return')
    expect(toAccelerator('Ctrl+Shift+Enter')).toBe('CmdOrCtrl+Shift+Return')
    expect(toAccelerator('Ctrl+,')).toBe('CmdOrCtrl+,')
    expect(toAccelerator('Ctrl+Alt+Up')).toBe('CmdOrCtrl+Alt+Up')
    expect(toAccelerator('Ctrl+Shift+]')).toBe('CmdOrCtrl+Shift+]')
    expect(toAccelerator('Esc')).toBe('Escape')
  })
})

describe('action ↔ command ↔ native menu links', () => {
  it('every link points at a real menu bridge entry that dispatches the same command', () => {
    for (const [actionId, link] of Object.entries(ACTION_LINKS)) {
      expect(actionForCommand(link.commandId), actionId).toBe(actionId)
      if (link.menuId) expect(MENU_ID_TO_COMMAND[link.menuId], `${actionId} → ${link.menuId}`).toBe(link.commandId)
    }
  })

  it('every bridged menu item exists in the HTML menu model (Windows/Linux parity)', () => {
    const modelled = new Set(MENU_MODEL.flatMap(s => s.entries.flatMap(e => (e.kind === 'command' ? [e.commandId] : []))))
    const bridgedOnly = Object.values(MENU_ID_TO_COMMAND).filter(c => !modelled.has(c))
    // Every native menu command except About/Docs placement differences must be reachable off-mac.
    expect(bridgedOnly.filter(c => !['help.about', 'help.docs', 'workspace.openRemoteWindow'].includes(c))).toEqual([])
  })

  it('native menu accelerators equal the registry defaults, and every accelerated item is rebindable', () => {
    const mainRs = readFileSync(resolve(process.cwd(), 'src-tauri/src/main.rs'), 'utf8')
    const re = /MenuItemBuilder::with_id\("([^"]+)",\s*"[^"]*"\)\s*\.accelerator\("([^"]+)"\)/g
    const native = new Map<string, string>()
    for (const m of mainRs.matchAll(re)) native.set(m[1], m[2])
    expect(native.size).toBeGreaterThan(15)

    const linkedMenuIds = new Map<string, KeyboardAction>()
    for (const [actionId, link] of Object.entries(ACTION_LINKS)) {
      if (link.menuId) linkedMenuIds.set(link.menuId, actionId as KeyboardAction)
    }
    for (const [menuId, accel] of native) {
      if (menuId === 'new-window') continue // Rust-only item, not a registry action
      const actionId = linkedMenuIds.get(menuId)
      expect(actionId, `native menu item "${menuId}" (${accel}) has no rebindable registry action`).toBeDefined()
      expect(accel, `${menuId} accelerator drifted from DEFAULT_KEYBINDINGS.${actionId}`).toBe(defaultAccelerator(actionId!))
    }
    // No two native accelerators on one chord (the OS only fires the first).
    const chords = [...native.values()]
    expect(new Set(chords).size, `duplicate native accelerators: ${chords.join(', ')}`).toBe(chords.length)
  })

  it('the New Window accelerator stays clear of every registry default', () => {
    const defaults = new Set(Object.values(DEFAULT_KEYBINDINGS).map(b => toAccelerator(b.windows)))
    expect(defaults.has('CmdOrCtrl+Alt+N')).toBe(false)
  })
})
