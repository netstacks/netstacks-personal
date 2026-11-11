import { describe, it, expect } from 'vitest'
import { findMappedKey, findDuplicateMappedKey } from '../mappedKeys'
import type { MappedKey } from '../../api/mappedKeys'

const mk = (id: string, key_combo: string): MappedKey =>
  ({ id, key_combo, command: `cmd-${id}`, description: null, is_secret: false, created_at: '' })

const keys = [mk('a', 'Ctrl+K'), mk('b', 'Cmd+K'), mk('c', 'Alt+Escape'), mk('d', 'Ctrl+Shift+Return')]
const ev = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)

describe('findMappedKey', () => {
  it('tells Ctrl and Cmd chords apart', () => {
    expect(findMappedKey(ev({ key: 'k', ctrlKey: true }), keys)?.id).toBe('a')
    expect(findMappedKey(ev({ key: 'k', metaKey: true }), keys)?.id).toBe('b')
    expect(findMappedKey(ev({ key: 'k' }), keys)).toBeUndefined()
  })

  it('accepts both key-name dialects (Escape/Esc, Return/Enter)', () => {
    expect(findMappedKey(ev({ key: 'Escape', altKey: true }), keys)?.id).toBe('c')
    expect(findMappedKey(ev({ key: 'Enter', ctrlKey: true, shiftKey: true }), keys)?.id).toBe('d')
  })

  it('ignores bare modifier presses', () => {
    expect(findMappedKey(ev({ key: 'Control', ctrlKey: true }), [mk('x', 'Control')])).toBeUndefined()
  })
})

describe('findDuplicateMappedKey', () => {
  it('finds the same chord regardless of spelling, skipping the row being edited', () => {
    expect(findDuplicateMappedKey('Shift+Ctrl+Enter', keys)?.id).toBe('d')
    expect(findDuplicateMappedKey('Ctrl+Shift+Return', keys, 'd')).toBeUndefined()
    expect(findDuplicateMappedKey('Ctrl+Q', keys)).toBeUndefined()
  })
})
