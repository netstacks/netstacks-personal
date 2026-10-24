import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const openExternalUrl = vi.fn()
vi.mock('../../lib/openExternal', () => ({
  openExternalUrl: (url: string) => openExternalUrl(url),
}))
vi.mock('../../api/profilingAgents', () => ({
  listAgents: () => Promise.resolve([
    { id: 'a1', name: 'Idle Agent', active: false },
    { id: 'a2', name: 'Live Agent', active: true },
  ]),
  listAgentDevices: () => Promise.resolve([]),
  listAnomalies: () => Promise.resolve([]),
}))

import { ProfilingAgentsPanel } from '../ProfilingAgentsPanel'

beforeEach(() => openExternalUrl.mockReset())
afterEach(cleanup)

describe('ProfilingAgentsPanel inactive agents', () => {
  it('opens the Admin UI config page for an inactive agent', async () => {
    openExternalUrl.mockResolvedValue(true)
    render(<ProfilingAgentsPanel onOpenChat={() => {}} adminUiBaseUrl="https://ctl.example/" />)
    fireEvent.click(await screen.findByText('Idle Agent'))
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith('https://ctl.example/profiling-agents/a1'))
    expect(screen.queryByText(/Configure this agent in the Admin UI/)).toBeNull()
  })

  it('shows an inline hint when no Admin UI URL is available', async () => {
    render(<ProfilingAgentsPanel onOpenChat={() => {}} adminUiBaseUrl={null} />)
    fireEvent.click(await screen.findByText('Idle Agent'))
    expect(await screen.findByText(/Configure this agent in the Admin UI/)).toBeInTheDocument()
    expect(openExternalUrl).not.toHaveBeenCalled()
  })

  it('still opens chat for an active agent', async () => {
    const onOpenChat = vi.fn()
    render(<ProfilingAgentsPanel onOpenChat={onOpenChat} adminUiBaseUrl="https://ctl.example" />)
    fireEvent.click(await screen.findByText('Live Agent'))
    expect(onOpenChat).toHaveBeenCalledWith('a2', 'Live Agent')
  })
})
