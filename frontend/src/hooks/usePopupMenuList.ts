/**
 * usePopupMenuList — shared data + keyboard plumbing for the status-bar
 * pickers (Quick Prompts, Snippets, Quick Calls).
 *
 * - Loads the list once on mount and tracks `loading` / `error` / `ready`
 *   explicitly, so a failed fetch shows "Couldn't load …  [Retry]" rather
 *   than masquerading as an empty list.
 * - `onListKeyDown` gives the rows (native buttons marked `data-menu-item`)
 *   arrow-key navigation: ArrowDown from the search field enters the list,
 *   ArrowUp/ArrowDown move between rows, Home/End jump, and ArrowUp from
 *   the first row returns to the search field. Enter/Space activate the
 *   focused row natively.
 */
import { useCallback, useEffect, useState } from 'react'

export type PopupListStatus = 'loading' | 'error' | 'ready'

export interface PopupMenuList<T> {
  items: T[]
  status: PopupListStatus
  retry: () => void
  onListKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void
}

const ITEM_SELECTOR = '[data-menu-item]'

/** `load` must be stable (a module-level API function); a new identity reloads. */
export function usePopupMenuList<T>(
  load: () => Promise<T[]>,
  searchRef: React.RefObject<HTMLInputElement | null>,
): PopupMenuList<T> {
  const [items, setItems] = useState<T[]>([])
  const [status, setStatus] = useState<PopupListStatus>('loading')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    load()
      .then((list) => {
        if (cancelled) return
        setItems(list)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        console.error(err)
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [attempt, load])

  const retry = useCallback(() => {
    setStatus('loading')
    setAttempt((n) => n + 1)
  }, [])

  const onListKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(ITEM_SELECTOR)]
    const active = document.activeElement
    const index = rows.findIndex((row) => row === active)
    const inSearch = !!searchRef.current && active === searchRef.current
    if (index === -1 && !(inSearch && e.key === 'ArrowDown')) return
    if (rows.length === 0) return
    e.preventDefault()
    if (e.key === 'Home') rows[0].focus()
    else if (e.key === 'End') rows[rows.length - 1].focus()
    else if (e.key === 'ArrowDown') rows[Math.min(index + 1, rows.length - 1)].focus()
    else if (index === 0) searchRef.current?.focus()
    else rows[index - 1].focus()
  }, [searchRef])

  return { items, status, retry, onListKeyDown }
}
