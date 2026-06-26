import { useEffect, useCallback, useState, useRef } from 'react'
import SettingsPanel from './SettingsPanel'
import './SettingsModal.css'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

interface Position {
  x: number
  y: number
}

interface Size {
  width: number
  height: number
}

const DEFAULT_WIDTH = 850
const DEFAULT_HEIGHT = 680
const MIN_WIDTH = 600
const MIN_HEIGHT = 400
const MIN_TOP_MARGIN = 40 // Minimum margin from top of window (accounts for title bar)

export default function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [position, setPosition] = useState<Position | null>(null)
  const [size, setSize] = useState<Size>({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })
  const [isDragging, setIsDragging] = useState(false)
  const [isResizing, setIsResizing] = useState<string | null>(null)
  const dragStart = useRef({ x: 0, y: 0, posX: 0, posY: 0 })
  const resizeStart = useRef({ x: 0, y: 0, width: 0, height: 0, posX: 0, posY: 0 })
  const justFinishedInteraction = useRef(false)

  // Center the modal when first opened
  useEffect(() => {
    if (isOpen && position === null) {
      const x = (window.innerWidth - size.width) / 2
      const y = (window.innerHeight - size.height) / 2
      setPosition({ x: Math.max(0, x), y: Math.max(MIN_TOP_MARGIN, y) })
    }
  }, [isOpen, position, size.width, size.height])

  // Handle escape key to close
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
    }
  }, [onClose])

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, handleKeyDown])

  // Handle drag move
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (isDragging) {
      const newX = e.clientX - dragStart.current.x + dragStart.current.posX
      const newY = e.clientY - dragStart.current.y + dragStart.current.posY
      // Keep within viewport bounds with minimum top margin
      const boundedX = Math.max(0, Math.min(newX, window.innerWidth - size.width))
      const boundedY = Math.max(MIN_TOP_MARGIN, Math.min(newY, window.innerHeight - 50))
      setPosition({ x: boundedX, y: boundedY })
    } else if (isResizing) {
      const deltaX = e.clientX - resizeStart.current.x
      const deltaY = e.clientY - resizeStart.current.y

      let newWidth = resizeStart.current.width
      let newHeight = resizeStart.current.height
      let newX = resizeStart.current.posX
      let newY = resizeStart.current.posY

      if (isResizing.includes('e')) {
        newWidth = Math.max(MIN_WIDTH, resizeStart.current.width + deltaX)
      }
      if (isResizing.includes('w')) {
        const widthDelta = Math.min(deltaX, resizeStart.current.width - MIN_WIDTH)
        newWidth = resizeStart.current.width - widthDelta
        newX = resizeStart.current.posX + widthDelta
      }
      if (isResizing.includes('s')) {
        newHeight = Math.max(MIN_HEIGHT, resizeStart.current.height + deltaY)
      }
      if (isResizing.includes('n')) {
        // Prevent resizing above minimum top margin
        const maxUpward = resizeStart.current.posY - MIN_TOP_MARGIN
        const heightDelta = Math.min(deltaY, resizeStart.current.height - MIN_HEIGHT)
        const boundedHeightDelta = Math.max(heightDelta, -maxUpward)
        newHeight = resizeStart.current.height - boundedHeightDelta
        newY = resizeStart.current.posY + boundedHeightDelta
      }

      setSize({ width: newWidth, height: newHeight })
      setPosition({ x: newX, y: newY })
    }
  }, [isDragging, isResizing, size.width])

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
    setIsResizing(null)
    // Prevent overlay click from closing modal right after drag/resize
    justFinishedInteraction.current = true
    setTimeout(() => {
      justFinishedInteraction.current = false
    }, 100)
  }, [])

  useEffect(() => {
    if (isDragging || isResizing) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      return () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [isDragging, isResizing, handleMouseMove, handleMouseUp])

  const handleDragStart = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.settings-modal-close')) return
    e.preventDefault()
    setIsDragging(true)
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      posX: position?.x ?? 0,
      posY: position?.y ?? 0,
    }
  }

  const handleResizeStart = (direction: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsResizing(direction)
    resizeStart.current = {
      x: e.clientX,
      y: e.clientY,
      width: size.width,
      height: size.height,
      posX: position?.x ?? 0,
      posY: position?.y ?? 0,
    }
  }

  if (!isOpen) return null

  const modalStyle: React.CSSProperties = position ? {
    position: 'absolute',
    left: position.x,
    top: position.y,
    width: size.width,
    height: size.height,
  } : {
    width: size.width,
    height: size.height,
  }

  const handleOverlayClick = () => {
    if (!justFinishedInteraction.current) {
      onClose()
    }
  }

  return (
    <div className="settings-modal-overlay" data-testid="settings-modal" onClick={handleOverlayClick}>
      <div
        className={`settings-modal ${isDragging ? 'dragging' : ''} ${isResizing ? 'resizing' : ''}`}
        style={modalStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="settings-modal-header"
          onMouseDown={handleDragStart}
          style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
        >
          <h2 className="settings-modal-title">Settings</h2>
          <button className="settings-modal-close" onClick={onClose} title="Close (Esc)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="settings-modal-body">
          <SettingsPanel />
        </div>

        {/* Resize handles */}
        <div className="resize-handle resize-n" onMouseDown={handleResizeStart('n')} />
        <div className="resize-handle resize-s" onMouseDown={handleResizeStart('s')} />
        <div className="resize-handle resize-e" onMouseDown={handleResizeStart('e')} />
        <div className="resize-handle resize-w" onMouseDown={handleResizeStart('w')} />
        <div className="resize-handle resize-ne" onMouseDown={handleResizeStart('ne')} />
        <div className="resize-handle resize-nw" onMouseDown={handleResizeStart('nw')} />
        <div className="resize-handle resize-se" onMouseDown={handleResizeStart('se')} />
        <div className="resize-handle resize-sw" onMouseDown={handleResizeStart('sw')} />
      </div>
    </div>
  )
}
