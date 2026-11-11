import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const api = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listAgentDevices: vi.fn(),
  listAnomalies: vi.fn(),
  getChatContext: vi.fn(),
  sendChatMessage: vi.fn(),
}))
vi.mock('../../api/profilingAgents', () => api)
vi.mock('../../lib/openExternal', () => ({ openExternalUrl: vi.fn() }))

import { ProfilingAgentsPanel } from '../ProfilingAgentsPanel'
import { ProfilingAgentChat } from '../ProfilingAgentChat'

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset())
  api.listAgents.mockResolvedValue([{ id: 'a1', name: 'Live Agent', active: true }])
  api.listAnomalies.mockResolvedValue([])
  localStorage.clear()
  // jsdom has no layout; the chat auto-scrolls on new messages.
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)

describe('ProfilingAgentsPanel health score (TRM-34)', () => {
  it('shows a dash, not NaN, when devices carry no health score', async () => {
    // The devices endpoint returns assignment rows without health_score.
    api.listAgentDevices.mockResolvedValue([{ id: 'x', agent_id: 'a1', device_id: 'd1' }])
    render(<ProfilingAgentsPanel onOpenChat={() => {}} />)
    expect(await screen.findByText(/Health: —/)).toBeInTheDocument()
    expect(screen.queryByText(/NaN/)).toBeNull()
  })

  it('averages only numeric scores', async () => {
    api.listAgentDevices.mockResolvedValue([
      { device_id: 'd1', health_score: 0.9 },
      { device_id: 'd2', health_score: null },
      { device_id: 'd3' },
    ])
    render(<ProfilingAgentsPanel onOpenChat={() => {}} />)
    expect(await screen.findByText(/Health: 90%/)).toBeInTheDocument()
  })
})

describe('ProfilingAgentChat identity (TRM-34)', () => {
  it('sends no client-generated user id', async () => {
    api.getChatContext.mockResolvedValue({ device_states: [], anomalies: [], conversation_history: [] })
    api.sendChatMessage.mockResolvedValue({ response: 'all good', tool_calls_made: 0 })
    render(<ProfilingAgentChat agentId="a1" agentName="Live Agent" onBack={() => {}} />)

    await waitFor(() => expect(api.getChatContext).toHaveBeenCalledWith('a1'))
    expect(api.getChatContext.mock.calls[0]).toHaveLength(1)

    const box = await screen.findByPlaceholderText(/Ask the agent/)
    fireEvent.change(box, { target: { value: 'hello' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(api.sendChatMessage).toHaveBeenCalledWith('a1', 'hello'))
    expect(api.sendChatMessage.mock.calls[0]).toHaveLength(2)
    expect(await screen.findByText('all good')).toBeInTheDocument()
    expect(localStorage.getItem('profiling-agent-user-id')).toBeNull()
  })
})
