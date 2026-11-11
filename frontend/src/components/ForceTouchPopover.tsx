import { useEffect, useRef, type ReactNode } from 'react'
import './ForceTouchPopover.css'

/** Context handed to every force-touch action. */
export interface ForceTouchContext {
  /** Currently selected terminal text (may be empty). */
  text: string
  sessionId?: string
  sessionName?: string
}

/** A single entry in the force-touch popover. Add new ones in lib/forceTouchActions. */
export interface ForceTouchOption {
  id: string
  label: string
  icon?: ReactNode
  /** Hide the option when this returns false. Defaults to always shown. */
  visible?: (ctx: ForceTouchContext) => boolean
  run: (ctx: ForceTouchContext) => void | Promise<void>
}

interface ForceTouchPopoverProps {
  isOpen: boolean
  position: { x: number; y: number }
  context: ForceTouchContext
  options: ForceTouchOption[]
  onClose: () => void
}

const POPOVER_WIDTH = 240

export default function ForceTouchPopover({
  isOpen,
  position,
  context,
  options,
  onClose,
}: ForceTouchPopoverProps) {
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click / Escape. Deferred a tick so the gesture that
  // opened the popover doesn't immediately close it. These listeners never
  // call preventDefault/stopPropagation, so they don't block other handlers.
  useEffect(() => {
    if (!isOpen) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  const visible = options.filter((o) => (o.visible ? o.visible(context) : true))
  if (visible.length === 0) return null

  // Keep the popover inside the viewport.
  const estHeight = visible.length * 28 + 56
  const left = Math.max(12, Math.min(position.x, window.innerWidth - POPOVER_WIDTH - 12))
  const top = Math.max(12, Math.min(position.y, window.innerHeight - estHeight - 12))

  const handle = async (o: ForceTouchOption) => {
    onClose()
    try {
      await o.run(context)
    } catch (err) {
      console.error(`Force-touch action "${o.id}" failed:`, err)
    }
  }

  return (
    // `popover-card` = shared frosted-glass skin (see popoverCard.css); this
    // class only positions the popover. Header reuses the enrich card's header
    // classes so the whole thing shares one look.
    <div
      ref={ref}
      className="force-touch-popover popover-card"
      style={{ left, top, width: POPOVER_WIDTH }}
    >
      <div className="ns-enrich-header">
        <button
          type="button"
          className="ns-enrich-close-btn"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
        <span className="ns-enrich-title">{context.text || 'Actions'}</span>
        {context.sessionName && (
          <span className="ns-enrich-type-badge">{context.sessionName}</span>
        )}
      </div>
      <div className="force-touch-popover-options">
        {visible.map((o) => (
          <button
            key={o.id}
            type="button"
            className="force-touch-popover-option"
            onClick={() => handle(o)}
          >
            {o.icon && <span className="force-touch-popover-icon">{o.icon}</span>}
            <span className="force-touch-popover-label">{o.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
