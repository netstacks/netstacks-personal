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
    const { container } = render(<AskAiHelp prompt="explain X" />)
    expect(container.firstChild).toBeNull()
  })

  it('dispatches ASK_AI_HELP_EVENT with the prompt on click', () => {
    setGlobalSettings({ ...base, 'ai.contextualHelp.enabled': true })
    let received: AskAiHelpDetail | null = null
    const handler = (e: Event) => { received = (e as CustomEvent<AskAiHelpDetail>).detail }
    window.addEventListener(ASK_AI_HELP_EVENT, handler as EventListener)

    render(<AskAiHelp prompt="explain token matchers" label="Ask AI" />)
    fireEvent.click(screen.getByRole('button', { name: /Ask AI/i }))

    window.removeEventListener(ASK_AI_HELP_EVENT, handler as EventListener)
    expect(received).not.toBeNull()
    expect(received!.prompt).toBe('explain token matchers')
    expect(received!.position).toBeDefined()
  })
})
