import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PromoteToTaskDialog } from '../PromoteToTaskDialog'
import type { AgentMessage } from '../../hooks/useAIAgent'

const msg = (over: Partial<AgentMessage>): AgentMessage => ({
  id: Math.random().toString(36), type: 'agent-thinking', content: '', timestamp: new Date(), ...over,
})

function renderDialog(messages: AgentMessage[]) {
  const onPromote = vi.fn(async () => {})
  render(<PromoteToTaskDialog messages={messages} onClose={() => {}} onPromote={onPromote} />)
  fireEvent.click(screen.getByLabelText(/With Context/))
  return { onPromote, preview: () => document.querySelector('.promote-dialog-preview')!.textContent ?? '' }
}

describe('PromoteToTaskDialog context prompt', () => {
  it('includes command output and labels roles', () => {
    const { preview } = renderDialog([
      msg({ type: 'user', content: 'Why is BGP down?' }),
      msg({ type: 'command-result', content: 'Executed: show ip bgp summary', command: 'show ip bgp summary', output: 'Neighbor 10.0.0.2 Idle', sessionName: 'rtr1', exitCode: 0 }),
      msg({ type: 'agent-thinking', content: 'The neighbor is Idle.' }),
    ])
    const text = preview()
    expect(text).toContain('User: Why is BGP down?')
    expect(text).toContain('Tool output (rtr1): Executed: show ip bgp summary')
    expect(text).toContain('Output (exit 0):')
    expect(text).toContain('Neighbor 10.0.0.2 Idle')
    expect(text).toContain('Assistant: The neighbor is Idle.')
  })

  it('bounds long tool output and the total size', () => {
    const huge = 'x'.repeat(50000)
    const { preview } = renderDialog(
      Array.from({ length: 6 }, (_, i) => msg({ type: 'command-result', content: `Executed: cmd${i}`, output: huge })),
    )
    const text = preview()
    expect(text).toContain('characters omitted')
    expect(text.length).toBeLessThan(26000)
    expect(text).toContain('Executed: cmd5')
  })
})
