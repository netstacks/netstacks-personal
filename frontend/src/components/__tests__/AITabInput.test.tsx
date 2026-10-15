import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mocks must be declared before importing the component under test.
const sendChatMessage = vi.fn()
const ai = vi.hoisted(() => ({ AiNotConfiguredError: class AiNotConfiguredError extends Error {} }))
vi.mock('../../api/ai', () => ({
  sendChatMessage: (...args: unknown[]) => sendChatMessage(...args),
  AiNotConfiguredError: ai.AiNotConfiguredError,
  describeAiError: (err: Error) => err.message,
}))
const showToast = vi.hoisted(() => vi.fn())
vi.mock('../Toast', () => ({ showToast }))
vi.mock('../../lib/aiModes', () => ({ NETSTACKS_CONCEPTS_PRIMER: 'PRIMER' }))

import AITabInput from '../AITabInput'
import { registerFormAiContext } from '../../lib/aiFormContext'

describe('AITabInput — Tab-to-generate + handler composition', () => {
  beforeEach(() => {
    sendChatMessage.mockReset()
  })

  it('says why when the AI request fails (e.g. token budget used up)', async () => {
    sendChatMessage.mockRejectedValue(new Error('Your AI token budget is used up: limit 100000. Try again later, or ask your administrator to raise it.'))
    render(<AITabInput value="" onChange={() => {}} aiField="command" onAIValue={() => {}} />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab' })
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/token budget is used up/), 'error'))
  })

  it('says who sets AI up when it is not configured', async () => {
    sendChatMessage.mockRejectedValue(new ai.AiNotConfiguredError('AI not configured. Ask your administrator to set up an AI provider on the Controller (Admin UI → AI → LLM Providers).'))
    render(<AITabInput value="" onChange={() => {}} aiField="command" onAIValue={() => {}} />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab' })
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/Ask your administrator to set up an AI provider/), 'error'))
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

  it('sends the registered workspace context to the AI', async () => {
    sendChatMessage.mockResolvedValue('x')
    const ctx = { sessionName: 'peter', terminal: { detectedVendor: 'Cisco', detectedPlatform: 'IOS/IOS-XE' } }
    registerFormAiContext(() => ctx)
    try {
      render(<AITabInput value="" onChange={() => {}} aiField="command" onAIValue={() => {}} />)
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab' })
      await waitFor(() => expect(sendChatMessage).toHaveBeenCalled())
      expect(sendChatMessage.mock.calls[0][1].context).toEqual(ctx)
    } finally {
      registerFormAiContext(null)
    }
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
    expect(screen.getByText('Tab')).toBeInTheDocument()
  })

  it('never offers or generates AI for password fields', () => {
    const { container } = render(
      <AITabInput type="password" value="" onChange={() => {}} aiField="secret" onAIValue={() => {}} />,
    )
    const input = container.querySelector('input')!
    fireEvent.focus(input)
    expect(screen.queryByText('Tab')).toBeNull()
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(sendChatMessage).not.toHaveBeenCalled()
  })

  it('shows a set-up hint once AI turns out not to be configured, and Tab then moves on', async () => {
    sendChatMessage.mockRejectedValue(new ai.AiNotConfiguredError('no provider'))
    render(<AITabInput value="" onChange={() => {}} aiField="name" onAIValue={() => {}} />)
    const input = screen.getByRole('textbox')
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'Tab' })
    await waitFor(() => expect(screen.getByText('AI not set up')).toBeInTheDocument())
    const second = fireEvent.keyDown(input, { key: 'Tab' })
    expect(second).toBe(true)
    expect(sendChatMessage).toHaveBeenCalledOnce()
  })

  it('lets Tab move focus while a value is generating, and Escape cancels it', async () => {
    let resolve!: (v: string) => void
    sendChatMessage.mockReturnValue(new Promise<string>((r) => { resolve = r }))
    const onAIValue = vi.fn()
    render(<AITabInput value="" onChange={() => {}} aiField="name" onAIValue={onAIValue} />)
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Tab' })
    await waitFor(() => expect(input).toHaveAttribute('aria-busy', 'true'))
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true)
    expect(sendChatMessage).toHaveBeenCalledOnce()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).not.toHaveAttribute('aria-busy')
    resolve('late value')
    await Promise.resolve()
    expect(onAIValue).not.toHaveBeenCalled()
  })
})
