import { useState, useCallback } from 'react'
import type { MenuItem } from '../components/ContextMenu'

interface ContextMenuState {
  position: { x: number; y: number } | null
  items: MenuItem[]
  open: (e: React.MouseEvent, items: MenuItem[]) => void
  close: () => void
}

export function useContextMenu(): ContextMenuState {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [items, setItems] = useState<MenuItem[]>([])

  const open = useCallback((e: React.MouseEvent, menuItems: MenuItem[]) => {
    e.preventDefault()
    e.stopPropagation()
    setPosition({ x: e.clientX, y: e.clientY })
    setItems(menuItems)
  }, [])

  const close = useCallback(() => {
    setPosition(null)
    setItems([])
  }, [])

  return { position, items, open, close }
}
