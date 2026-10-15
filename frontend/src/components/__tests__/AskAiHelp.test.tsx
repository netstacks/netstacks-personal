import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import AskAiHelp, { ASK_AI_HELP_EVENT, type AskAiHelpDetail } from '../AskAiHelp'
import { getSettings, setGlobalSettings } from '../../hooks/useSettings'

const base = getSettings()

afterEach(() => {
  cleanup()
  setGlobalSettings({ ...base, 'ai.contextualHelp.enabled': true })
})

describe('AskAiHelp', () => {
  it('renders nothing when contextual help is disabled', () => {
    setGlobalSettings({ ...base, 'ai.contextualHelp.enabled': false })
    const { container } = render(<AskAiHelp topic="matchers" prompt="explain X" />)
    expect(container.firstChild).toBeNull()
  })

  it('names its topic for assistive tech and keeps the visible "Ask AI" label', () => {
    setGlobalSettings({ ...base, 'ai.contextualHelp.enabled': true })
    render(<AskAiHelp topic="token matchers" prompt="explain" />)
    const button = screen.getByRole('button', { name: 'Ask AI about token matchers' })
    expect(button).toHaveTextContent('Ask AI')
    expect(button).toHaveClass('ns-btn', 'ns-btn--ghost', 'ns-btn--small')
  })

  it('dispatches ASK_AI_HELP_EVENT with the prompt on click', () => {
    setGlobalSettings({ ...base, 'ai.contextualHelp.enabled': true })
    let received: AskAiHelpDetail | null = null
    const handler = (e: Event) => { received = (e as CustomEvent<AskAiHelpDetail>).detail }
    window.addEventListener(ASK_AI_HELP_EVENT, handler as EventListener)

    render(<AskAiHelp topic="token matchers" prompt="explain token matchers" />)
    fireEvent.click(screen.getByRole('button', { name: /Ask AI/i }))

    window.removeEventListener(ASK_AI_HELP_EVENT, handler as EventListener)
    expect(received).not.toBeNull()
    expect(received!.prompt).toBe('explain token matchers')
    expect(received!.position).toBeDefined()
  })
})
