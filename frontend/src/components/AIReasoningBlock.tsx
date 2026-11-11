import './AIToolCallRow.css'
import './AIReasoningBlock.css'

interface AIReasoningBlockProps {
  /** The model's summarized thinking (grows while it streams). */
  text: string
}

/**
 * The model's reasoning ("Show AI Reasoning", Settings → AI) as a row in an
 * AI activity group: folded to its latest line, the full text on expand.
 */
export default function AIReasoningBlock({ text }: AIReasoningBlockProps) {
  const lines = text.trim().split('\n').filter((l) => l.trim())
  const preview = lines[lines.length - 1] ?? ''
  return (
    <details className="ai-reasoning">
      <summary className="ai-reasoning-summary" title="Click to show the full reasoning">
        <span className="ai-row-icon" aria-label="Thinking">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
            <path d="M9 18h6" />
            <path d="M10 22h4" />
            <path d="M12 2a7 7 0 0 0-4 12.74V16h8v-1.26A7 7 0 0 0 12 2z" />
          </svg>
        </span>
        <span className="ai-reasoning-preview">{preview}</span>
        <svg className="ai-row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11" aria-hidden="true">
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </summary>
      <div className="ai-reasoning-body">{text.trim()}</div>
    </details>
  )
}
