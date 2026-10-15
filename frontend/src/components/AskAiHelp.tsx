/**
 * AskAiHelp — a small contextual "Ask AI" button for the complex setup areas
 * (integrations, enrichment, profiles, tunnels, AI permissions, …).
 *
 * On click it dispatches a global ASK_AI_HELP_EVENT that App.tsx listens for and
 * opens the floating AI pop-over seeded with `prompt`. The pop-over's AI has the
 * full agent toolset (incl. navigate_to_settings and the bundled NetStacks docs),
 * so it can both explain the concept and drive the user to the right place.
 *
 * Hidden when the user turns off contextual help (Settings → AI).
 */
import { useSettings } from '../hooks/useSettings'
import './AskAiHelp.css'
import { SparkleIcon } from './icons/SparkleIcon'
import Tooltip from './Tooltip'

export const ASK_AI_HELP_EVENT = 'netstacks:ask-ai-help'

export interface AskAiHelpDetail {
  prompt: string
  position: { x: number; y: number }
}

interface AskAiHelpProps {
  /** What the help is about, e.g. "matchers" → "Ask AI about matchers". */
  topic: string
  /** The help question seeded into the AI pop-over. */
  prompt: string
}

export default function AskAiHelp({ topic, prompt }: AskAiHelpProps) {
  const { settings } = useSettings()
  if (!settings['ai.contextualHelp.enabled']) return null

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const detail: AskAiHelpDetail = { prompt, position: { x: e.clientX, y: e.clientY } }
    window.dispatchEvent(new CustomEvent(ASK_AI_HELP_EVENT, { detail }))
  }

  const label = `Ask AI about ${topic}`
  return (
    <Tooltip label={label}><button
      type="button"
      className="ns-btn ns-btn--ghost ns-btn--small ask-ai-help"
      onClick={handleClick}
      aria-label={label}
    >
      <SparkleIcon />
      Ask AI
    </button></Tooltip>
  )
}
