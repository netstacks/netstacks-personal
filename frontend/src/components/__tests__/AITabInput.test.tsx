import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mocks must be declared before importing the component under test.
const sendChatMessage = vi.fn()
vi.mock('../../api/ai', () => ({
  sendChatMessage: (...args: unknown[]) => sendChatMessage(...args),
  AiNotConfiguredError: class AiNotConfiguredError extends Error {},
}))
vi.mock('../../lib/aiModes', () => ({ NETSTACKS_CONCEPTS_PRIMER: 'PRIMER' }))

import AITabInput from '../AITabInput'

describe('AITabInput — Tab-to-generate + handler composition', () => {
  beforeEach(() => {
    sendChatMessage.mockReset()
  })

  it('generates a value on Tab when the field is empty', async () => {
    sendChatMessage.mockResolvedValue('  "show version"  ')
    const onAIValue = vi.fn()
    render(
      <AITabInput value="" onChange={() => {}} aiField="command" onAIValue={onAIValue} />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Tab' })
    await waitFor(() => expect(onAIValue).toHaveBeenCalledWith('show version'))
    expect(sendChatMessage).toHaveBeenCalledOnce()
  })

  it('still generates on Tab even when the caller passes its own onKeyDown (regression)', async () => {
    sendChatMessage.mockResolvedValue('generated')
    const onAIValue = vi.fn()
    const callerKeyDown = vi.fn()
    render(
      <AITabInput
        value=""
        onChange={() => {}}
        aiField="command"
        onAIValue={onAIValue}
        onKeyDown={callerKeyDown}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Tab' })
    await waitFor(() => expect(onAIValue).toHaveBeenCalledWith('generated'))
    // Tab-to-generate consumed the event; caller's handler is NOT called for it.
    expect(callerKeyDown).not.toHaveBeenCalled()
  })

  it('delegates non-Tab keys to the caller onKeyDown', () => {
    const callerKeyDown = vi.fn()
    render(
      <AITabInput
        value=""
        onChange={() => {}}
        aiField="command"
        onAIValue={() => {}}
        onKeyDown={callerKeyDown}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    expect(callerKeyDown).toHaveBeenCalledOnce()
    expect(sendChatMessage).not.toHaveBeenCalled()
  })

  it('does not generate on Tab when the field already has a value', () => {
    const callerKeyDown = vi.fn()
    render(
      <AITabInput
        value="already typed"
        onChange={() => {}}
        aiField="command"
        onAIValue={() => {}}
        onKeyDown={callerKeyDown}
      />,
    )
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab' })
    expect(sendChatMessage).not.toHaveBeenCalled()
    // Non-generate Tab is delegated to the caller.
    expect(callerKeyDown).toHaveBeenCalledOnce()
  })

  it('composes onFocus with the badge state and calls the caller handler', () => {
    const callerFocus = vi.fn()
    render(
      <AITabInput value="" onChange={() => {}} aiField="command" onAIValue={() => {}} onFocus={callerFocus} />,
    )
    fireEvent.focus(screen.getByRole('textbox'))
    expect(callerFocus).toHaveBeenCalledOnce()
    expect(screen.getByText('TAB ✨')).toBeInTheDocument()
  })
})
