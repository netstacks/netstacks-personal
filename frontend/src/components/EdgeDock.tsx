import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import './PanelTab.css'
import './EdgeDock.css'

const STORAGE_KEY = 'netstacks-edge-dock-y'
const DEFAULT_Y = 120
const EDGE_MARGIN = 8
/** Pointer travel that turns a press on a tab into a drag of the dock. */
const DRAG_THRESHOLD = 4

function storedY(): number {
  const value = Number(localStorage.getItem(STORAGE_KEY))
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_Y
}

function clampY(y: number, height: number): number {
  return Math.max(EDGE_MARGIN, Math.min(window.innerHeight - height - EDGE_MARGIN, y))
}

interface EdgeDockProps {
  /** Tabs rendered directly by the parent (e.g. Team Knowledge). */
  children?: ReactNode
  /** Receives the element other components portal their tab into (the AI panel's collapsed tab). */
  slotRef: (el: HTMLDivElement | null) => void
}

/**
 * Floating dock on the right window edge holding panel tabs that look like the
 * left PanelTabRail's. Drag it up or down (position persists); tabs stack so
 * they never overlap. Hidden while it holds no tab.
 */
export default function EdgeDock({ children, slotRef }: EdgeDockProps) {
  const dockRef = useRef<HTMLDivElement>(null)
  const [y, setY] = useState(storedY)
  const suppressClick = useRef(false)

  useEffect(() => {
    const onResize = () => setY(prev => clampY(prev, dockRef.current?.offsetHeight ?? 0))
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !(e.target as HTMLElement).closest('.panel-tab')) return
    const startY = e.clientY
    const startTop = y
    const height = dockRef.current?.offsetHeight ?? 0
    let dragging = false
    let last = startTop
    const onMove = (me: PointerEvent) => {
      if (!dragging && Math.abs(me.clientY - startY) < DRAG_THRESHOLD) return
      dragging = true
      last = clampY(startTop + me.clientY - startY, height)
      setY(last)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (!dragging) return
      suppressClick.current = true
      localStorage.setItem(STORAGE_KEY, String(Math.round(last)))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [y])

  // A drag ends with a click on the tab under the pointer; swallow it.
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (!suppressClick.current) return
    suppressClick.current = false
    e.stopPropagation()
    e.preventDefault()
  }, [])

  return (
    <div
      ref={dockRef}
      className="panel-tab-rail panel-tab-rail--floating edge-dock"
      style={{ top: y }}
      onPointerDown={onPointerDown}
      onClickCapture={onClickCapture}
      data-testid="edge-dock"
    >
      {children}
      <div ref={slotRef} className="edge-dock-slot" />
    </div>
  )
}
