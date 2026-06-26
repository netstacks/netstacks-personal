import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react'
import './SplitPaneContainer.css'

interface SplitPaneContainerProps {
  /** Layout direction: horizontal = side by side, vertical = stacked */
  orientation: 'horizontal' | 'vertical'
  /** Child panes to render */
  children: ReactNode[]
  /** Sizes as percentages (must sum to 100) */
  sizes?: number[]
  /** Callback when sizes change via drag */
  onSizesChange?: (sizes: number[]) => void
  /** Minimum pane size in pixels */
  minSize?: number
  /** Unique ID for nested split support */
  id?: string
  /** Current nesting depth (0 = top-level, max 3) */
  depth?: number
}

const MIN_PANE_SIZE = 100 // pixels
export const MAX_NESTING_DEPTH = 3

/**
 * SplitPaneContainer renders children in horizontal or vertical splits
 * with draggable dividers for resizing
 */
export default function SplitPaneContainer({
  orientation,
  children,
  sizes: controlledSizes,
  onSizesChange,
  minSize = MIN_PANE_SIZE,
  id,
  depth = 0
}: SplitPaneContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const childCount = Array.isArray(children) ? children.length : 1

  // Enforce maximum nesting depth (for future recursive splitting support)
  const _isMaxDepth = depth >= MAX_NESTING_DEPTH
  void _isMaxDepth

  // Initialize default sizes (equal distribution)
  const defaultSizes = Array(childCount).fill(100 / childCount)
  const [internalSizes, setInternalSizes] = useState(defaultSizes)

  // Use controlled or internal sizes
  const sizes = controlledSizes ?? internalSizes
  const setSizes = onSizesChange ?? setInternalSizes

  // Track drag state
  const [isDragging, setIsDragging] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const startPosRef = useRef(0)
  const startSizesRef = useRef<number[]>([])

  // Normalize sizes when child count changes
  useEffect(() => {
    if (sizes.length !== childCount) {
      setSizes(Array(childCount).fill(100 / childCount))
    }
  }, [childCount, sizes.length, setSizes])

  // Handle divider drag start
  const handleDividerMouseDown = useCallback((index: number) => (e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    setDragIndex(index)
    startPosRef.current = orientation === 'horizontal' ? e.clientX : e.clientY
    startSizesRef.current = [...sizes]
  }, [orientation, sizes])

  // Handle drag move
  useEffect(() => {
    if (!isDragging || dragIndex === null || !containerRef.current) return

    const container = containerRef.current
    const containerRect = container.getBoundingClientRect()
    const containerSize = orientation === 'horizontal'
      ? containerRect.width
      : containerRect.height

    const handleMouseMove = (e: MouseEvent) => {
      const currentPos = orientation === 'horizontal' ? e.clientX : e.clientY
      const delta = currentPos - startPosRef.current
      const deltaPercent = (delta / containerSize) * 100

      // Calculate new sizes
      const newSizes = [...startSizesRef.current]
      const leftIndex = dragIndex
      const rightIndex = dragIndex + 1

      // Calculate minimum percentage based on container size and minSize
      const minPercent = (minSize / containerSize) * 100

      // Adjust sizes
      const newLeftSize = startSizesRef.current[leftIndex] + deltaPercent
      const newRightSize = startSizesRef.current[rightIndex] - deltaPercent

      // Enforce minimum sizes
      if (newLeftSize >= minPercent && newRightSize >= minPercent) {
        newSizes[leftIndex] = newLeftSize
        newSizes[rightIndex] = newRightSize
        setSizes(newSizes)
      }
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      setDragIndex(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, dragIndex, orientation, minSize, setSizes])

  // Handle double-click to reset sizes
  const handleDividerDoubleClick = useCallback(() => {
    setSizes(Array(childCount).fill(100 / childCount))
  }, [childCount, setSizes])

  // If only one child, render without splits
  if (childCount <= 1) {
    return (
      <div className="split-pane-container single" data-id={id}>
        {children}
      </div>
    )
  }

  const childArray = Array.isArray(children) ? children : [children]

  return (
    <div
      ref={containerRef}
      className={`split-pane-container ${orientation} ${isDragging ? 'dragging' : ''}`}
      data-id={id}
    >
      {childArray.map((child, index) => (
        <div key={index} className="split-pane-wrapper">
          <div
            className="split-pane"
            style={{
              [orientation === 'horizontal' ? 'width' : 'height']: `${sizes[index]}%`
            }}
          >
            {child}
          </div>
          {index < childCount - 1 && (
            <div
              className={`split-pane-divider ${orientation}`}
              onMouseDown={handleDividerMouseDown(index)}
              onDoubleClick={handleDividerDoubleClick}
            >
              <div className="split-pane-divider-handle" />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
