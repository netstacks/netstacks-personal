/**
 * Terminal "mapped keys": a chord that types a saved command into the
 * terminal. Recorded and matched with the same key-chord grammar as the
 * app shortcuts (`eventToBinding` / `matchesBinding`), so `Cmd` and `Ctrl`
 * are distinct and `Esc`/`Escape`, `Enter`/`Return` spellings all match.
 */

import type { MappedKey } from '../api/mappedKeys'
import { canonicalBinding, matchesBinding } from '../hooks/useKeyboard'

/** Fired on `window` after a mapped key is created, edited, or deleted. */
export const MAPPED_KEYS_CHANGED_EVENT = 'netstacks:mapped-keys-changed'

export function notifyMappedKeysChanged(): void {
  window.dispatchEvent(new Event(MAPPED_KEYS_CHANGED_EVENT))
}

/** The mapped key whose chord the keydown event is, if any. */
export function findMappedKey(e: KeyboardEvent, keys: readonly MappedKey[]): MappedKey | undefined {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return undefined
  return keys.find(k => matchesBinding(e, k.key_combo))
}

/** Another mapped key already bound to the same chord (ignoring `exceptId`). */
export function findDuplicateMappedKey(combo: string, keys: readonly MappedKey[], exceptId?: string): MappedKey | undefined {
  const wanted = canonicalBinding(combo)
  return keys.find(k => k.id !== exceptId && canonicalBinding(k.key_combo) === wanted)
}
