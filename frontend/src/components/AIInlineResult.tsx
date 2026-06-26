import { useEffect, useRef } from 'react'
import './AIInlineResult.css'

interface AIInlineResultProps {
  content: string
  onClose: () => void
  position?: { x: number; y: number }
}

/**
 * Floating card that displays AI analysis results inline.
 * Used by backup viewer and other contexts to show AI findings
 * near the user's selection without requiring the side panel.
 */
export default function AIInlineResult({ content, onClose, position }: AIInlineResultProps) {
  const cardRef = useRef<HTMLDivElement>(null)

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  const style: React.CSSProperties = position
    ? {
        position: 'fixed',
        left: Math.min(position.x, window.innerWidth - 520),
        top: Math.min(position.y, window.innerHeight - 420),
      }
    : {}

  return (
    <div className="ai-inline-result" style={style} ref={cardRef}>
      <div className="ai-inline-result-header">
        <span className="ai-inline-result-badge">AI Analysis</span>
        <button className="ai-inline-result-close" onClick={onClose}>&times;</button>
      </div>
      <div className="ai-inline-result-content">
        {content.split('\n').map((line, i) => {
          if (line.startsWith('##')) {
            return <h4 key={i} className="ai-result-heading">{line.replace(/^#+\s*/, '')}</h4>
          }
          if (line.startsWith('- **') || line.startsWith('  -')) {
            return <div key={i} className="ai-result-bullet">{line}</div>
          }
          if (line.trim() === '') {
            return <div key={i} className="ai-result-spacer" />
          }
          return <div key={i} className="ai-result-line">{line}</div>
        })}
      </div>
    </div>
  )
}
