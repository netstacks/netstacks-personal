/**
 * AskAiHelp — a small contextual "Ask AI" button placed next to confusing
 * settings (API Resources, enrichment sources, token matchers, integrations).
 *
 * On click it dispatches a global ASK_AI_HELP_EVENT that App.tsx listens for and
 * opens the floating AI pop-over seeded with `prompt`. The pop-over's AI has the
 * full agent toolset (incl. navigate_to_settings), so it can both explain the
 * concept and drive the user to the right place in the UI.
 *
 * Hidden when the user turns off contextual help (Settings → AI).
 */
import { useSettings } from '../hooks/useSettings'
import './AskAiHelp.css'

export const ASK_AI_HELP_EVENT = 'netstacks:ask-ai-help'

export interface AskAiHelpDetail {
  prompt: string
  position: { x: number; y: number }
}

interface AskAiHelpProps {
  /** The help question seeded into the AI pop-over. */
  prompt: string
  /** Button label (default "Ask AI"). */
  label?: string
  className?: string
}

export default function AskAiHelp({ prompt, label = 'Ask AI', className }: AskAiHelpProps) {
  const { settings } = useSettings()
  if (!settings['ai.contextualHelp.enabled']) return null

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const detail: AskAiHelpDetail = { prompt, position: { x: e.clientX, y: e.clientY } }
    window.dispatchEvent(new CustomEvent(ASK_AI_HELP_EVENT, { detail }))
  }

  return (
    <button
      type="button"
      className={`ask-ai-help ${className || ''}`}
      onClick={handleClick}
      title="Ask the AI to explain this and help you set it up"
    >
      <span className="ask-ai-help-icon" aria-hidden>✨</span>
      {label}
    </button>
  )
}
