import { render, screen, act } from '@testing-library/react'
import { Profiler } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PendingInteraction } from '../../api/taskApprovals'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  mode: { isEnterprise: false },
}))

vi.mock('../../api/taskApprovals', () => ({
  listAllPendingInteractions: mocks.list,
  resolveInteraction: vi.fn(),
}))
vi.mock('../../hooks/useMode', () => ({ useMode: () => mocks.mode }))
vi.mock('../../commands', () => ({
  useActiveContextStore: (sel: (s: { activeTabType: string | null }) => unknown) =>
    sel({ activeTabType: 'agent-run' }),
}))

import InteractionPanel from '../InteractionPanel'
import { useAgentTasksStore } from '../../hooks/useAgentTasks'

const item: PendingInteraction = {
  id: 'i-1',
  task_id: 't-1',
  kind: 'approval',
  prompt: 'Run show version?',
  created_at: '2026-10-28T00:00:00Z',
}

let hidden = false
const setHidden = (value: boolean) => {
  hidden = value
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
}
/** Advance fake time and flush the awaited poll promise. */
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

describe('InteractionPanel polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hidden = false
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    mocks.list.mockReset()
    mocks.list.mockResolvedValue([])
    mocks.mode.isEnterprise = false
    useAgentTasksStore.setState({ tasks: [] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls every 750 ms while items are queued', async () => {
    mocks.list.mockResolvedValue([item])
    render(<InteractionPanel />)
    await advance(0)
    expect(mocks.list).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Run show version?')).toBeInTheDocument()
    await advance(750 * 20)
    expect(mocks.list).toHaveBeenCalledTimes(21)
  })

  it('backs off to at most 5 s while the queue stays empty, then snaps back', async () => {
    render(<InteractionPanel />)
    await advance(0)
    // 8 grace polls at 750 ms, then doubling 1.5 → 3 → 5 (cap) s.
    await advance(750 * 8)
    expect(mocks.list).toHaveBeenCalledTimes(9)
    await advance(1500)
    expect(mocks.list).toHaveBeenCalledTimes(10)
    await advance(3000)
    expect(mocks.list).toHaveBeenCalledTimes(11)
    await advance(5000)
    expect(mocks.list).toHaveBeenCalledTimes(12)
    await advance(5000)
    expect(mocks.list).toHaveBeenCalledTimes(13)
    await advance(4999)
    expect(mocks.list).toHaveBeenCalledTimes(13)

    // An item appears → fast rate again.
    mocks.list.mockResolvedValue([item])
    await advance(1)
    expect(mocks.list).toHaveBeenCalledTimes(14)
    expect(screen.getByText('Run show version?')).toBeInTheDocument()
    await advance(750)
    expect(mocks.list).toHaveBeenCalledTimes(15)
  })

  it('polls immediately at the fast rate when an agent task starts', async () => {
    render(<InteractionPanel />)
    await advance(0)
    await advance(750 * 8 + 1500 + 3000) // backed off to 5 s
    const calls = mocks.list.mock.calls.length
    act(() => {
      useAgentTasksStore.setState({ tasks: [{ id: 't-1', status: 'running' } as never] })
    })
    await advance(0)
    expect(mocks.list).toHaveBeenCalledTimes(calls + 1)
    // Stays fast (no backoff) while the task runs, even with an empty queue.
    await advance(750 * 20)
    expect(mocks.list).toHaveBeenCalledTimes(calls + 21)
  })

  it('pauses while the document is hidden and resumes immediately when shown', async () => {
    mocks.list.mockResolvedValue([item])
    render(<InteractionPanel />)
    await advance(0)
    expect(mocks.list).toHaveBeenCalledTimes(1)
    setHidden(true)
    await advance(60_000)
    expect(mocks.list).toHaveBeenCalledTimes(1)
    setHidden(false)
    await advance(0)
    expect(mocks.list).toHaveBeenCalledTimes(2)
    await advance(750)
    expect(mocks.list).toHaveBeenCalledTimes(3)
  })

  it('does not re-render for an unchanged payload', async () => {
    // Fresh-but-equal objects every poll.
    mocks.list.mockImplementation(async () => [{ ...item }])
    const onRender = vi.fn()
    render(<Profiler id="panel" onRender={onRender}><InteractionPanel /></Profiler>)
    await advance(0)
    const commits = onRender.mock.calls.length
    for (let i = 0; i < 5; i++) await advance(750) // separate acts: no batching
    expect(mocks.list).toHaveBeenCalledTimes(6)
    // Without the equality guard every poll commits (5 more). React may still
    // perform one bail-out render after a same-state update, hence the +1.
    expect(onRender.mock.calls.length).toBeLessThanOrEqual(commits + 1)
    expect(screen.getByText('Run show version?')).toBeInTheDocument()
  })

  it('never polls in enterprise mode', async () => {
    mocks.mode.isEnterprise = true
    render(<InteractionPanel />)
    await advance(10_000)
    expect(mocks.list).not.toHaveBeenCalled()
  })
})
