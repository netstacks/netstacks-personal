import { describe, it, expect } from 'vitest'
import { MENU_MODEL } from '../menuModel'
import { MENU_ID_TO_COMMAND } from '../menuBridge'

describe('MENU_MODEL', () => {
  it('has the expected top-level sections in order', () => {
    expect(MENU_MODEL.map(s => s.title)).toEqual(
      ['File', 'Edit', 'View', 'Session', 'Tools', 'AI', 'Window', 'Help']
    )
  })

  it('every command entry references a real command id from the bridge map', () => {
    const known = new Set(Object.values(MENU_ID_TO_COMMAND))
    for (const section of MENU_MODEL) {
      for (const e of section.entries) {
        if (e.kind === 'command') expect(known.has(e.commandId)).toBe(true)
      }
    }
  })
})
