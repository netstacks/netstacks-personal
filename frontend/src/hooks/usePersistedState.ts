import { useCallback, useEffect, useState } from 'react'

/**
 * Like `useState` but the value is mirrored to `localStorage` under
 * `key`, so it survives unmount, page reload, and full app restart.
 *
 * Pattern in the rest of the app today is each component re-implementing
 * try/catch + JSON.parse + .setItem — easy to get wrong (a corrupt
 * stored value can break the whole UI). This hook handles:
 *  - first-render init from storage (typed via JSON.parse; falls back to
 *    `initial` on any parse failure)
 *  - automatic persist on every state change
 *  - cross-tab/window sync via the `storage` event so two open windows
 *    don't drift (notably: Tauri popout terminals).
 *
 * Usage:
 *   const [collapsed, setCollapsed] = usePersistedState('workspaces.wsCollapsed', false)
 */
export interface UsePersistedStateOptions<T> {
  /**
   * Optional runtime validator. Called on the parsed value before it's
   * accepted into state — returning false (or throwing) falls back to
   * `initial`. Use for union types or anything where a stale / hostile
   * value in localStorage could break the UI. JSON.parse failure
   * already falls back without needing a validator.
   */
  validate?: (value: unknown) => value is T
}

export function usePersistedState<T>(
  key: string,
  initial: T,
  options?: UsePersistedStateOptions<T>,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const validate = options?.validate
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initial
    try {
      const stored = window.localStorage.getItem(key)
      if (stored === null) return initial
      const parsed = JSON.parse(stored) as unknown
      if (validate && !validate(parsed)) return initial
      return parsed as T
    } catch {
      return initial
    }
  })

  // Persist on every change.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Storage full / disabled — fail silently; the in-memory state
      // still works for the current session.
    }
  }, [key, value])

  // Cross-window sync: when another tab/window writes our key, mirror
  // the new value locally so we don't show stale state.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = (e: StorageEvent) => {
      if (e.key !== key) return
      if (e.newValue === null) return
      try {
        const parsed = JSON.parse(e.newValue) as unknown
        if (validate && !validate(parsed)) return
        setValue(parsed as T)
      } catch {
        // Ignore parse errors on incoming updates.
      }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [key, validate])

  // Stable setter wrapper isn't needed (useState already returns a
  // stable setter), but the return shape matches useState 1:1.
  const stableSet = useCallback((next: React.SetStateAction<T>) => {
    setValue(next)
  }, [])

  return [value, stableSet]
}
