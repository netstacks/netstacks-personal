import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import type { SessionContext } from '../types/sessionContext'

const listSessionContext = vi.hoisted(() => vi.fn())
vi.mock('../api/sessionContext', () => ({ listSessionContext }))

import TeamKnowledge, { ANNOUNCE_MS } from './TeamKnowledge'

const entry = (id: string, issue: string, extra: Partial<SessionContext> = {}): SessionContext => ({
  id, session_id: 's1', issue, root_cause: null, resolution: null, commands: null, ticket_ref: null,
  author: 'netops', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...extra,
})
const contexts = [entry('c2', 'SSH idle timeouts'), entry('c1', 'Uplink flapping', { ticket_ref: 'NET-4182' })]

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

function renderKnowledge(props: Partial<Parameters<typeof TeamKnowledge>[0]> = {}) {
  const handlers = { onAnnounced: vi.fn(), onOpenEntry: vi.fn(), onAskAI: vi.fn() }
  const view = render(<TeamKnowledge sessionId="s1" {...handlers} {...props} />)
  return { ...handlers, ...view }
}

beforeEach(() => {
  vi.useFakeTimers()
  listSessionContext.mockResolvedValue(contexts)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  listSessionContext.mockReset()
})

describe('TeamKnowledge', () => {
  it('shows no tab when the session has no saved context', async () => {
    listSessionContext.mockResolvedValue([])
    const { container } = renderKnowledge()
    await flush()
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a tab with the entry count', async () => {
    renderKnowledge()
    await flush()
    expect(screen.getByRole('button', { name: 'Team Knowledge, 2 entries' })).toHaveTextContent('Knowledge2')
  })

  const card = (container: HTMLElement) => container.querySelector('.team-knowledge-card')

  it('announces the newest entry on connect, then folds back into the tab', async () => {
    const { onAnnounced, container } = renderKnowledge({ announceAt: 1 })
    await flush()
    expect(card(container)).toHaveTextContent('SSH idle timeouts')
    expect(onAnnounced).toHaveBeenCalledOnce()
    act(() => { vi.advanceTimersByTime(ANNOUNCE_MS) })
    expect(card(container)).toBeNull()
  })

  it('reads the announcement through a live region that exists before its text', async () => {
    renderKnowledge({ announceAt: 1 })
    await flush()
    const region = screen.getByRole('status')
    expect(region).toBeEmptyDOMElement()
    act(() => { vi.advanceTimersByTime(0) })
    expect(region).toHaveTextContent('Team Knowledge, 2 entries. Newest from netops: SSH idle timeouts')
    act(() => { vi.advanceTimersByTime(ANNOUNCE_MS) })
    expect(region).toBeEmptyDOMElement()
  })

  it('keeps the announcement up while hovered', async () => {
    const { container } = renderKnowledge({ announceAt: 1 })
    await flush()
    fireEvent.mouseEnter(card(container)!)
    act(() => { vi.advanceTimersByTime(ANNOUNCE_MS * 3) })
    expect(card(container)).toBeInTheDocument()
    fireEvent.mouseLeave(card(container)!)
    act(() => { vi.advanceTimersByTime(ANNOUNCE_MS) })
    expect(card(container)).toBeNull()
  })

  it('reports an announcement with nothing to show as handled', async () => {
    listSessionContext.mockResolvedValue([])
    const { onAnnounced, container } = renderKnowledge({ announceAt: 1 })
    await flush()
    expect(onAnnounced).toHaveBeenCalledOnce()
    expect(card(container)).toBeNull()
  })

  it('lists every entry from the tab; an entry opens its details', async () => {
    const { onOpenEntry } = renderKnowledge()
    await flush()
    fireEvent.click(screen.getByRole('button', { name: /Team Knowledge/ }))
    const list = screen.getByRole('dialog', { name: 'Team Knowledge' })
    expect(list).toHaveTextContent('SSH idle timeouts')
    expect(list).toHaveTextContent('Uplink flapping')
    expect(list).toHaveTextContent('NET-4182')
    fireEvent.click(screen.getByText('Uplink flapping'))
    expect(onOpenEntry).toHaveBeenCalledWith(contexts[1])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Ask AI seeds the chat with that entry', async () => {
    const { onAskAI } = renderKnowledge()
    await flush()
    fireEvent.click(screen.getByRole('button', { name: /Team Knowledge/ }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Ask AI' })[0])
    expect(onAskAI).toHaveBeenCalledWith(contexts[0])
  })

  it('closes the list on Escape', async () => {
    renderKnowledge()
    await flush()
    fireEvent.click(screen.getByRole('button', { name: /Team Knowledge/ }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Escape from inside the list returns focus to the Knowledge tab', async () => {
    renderKnowledge()
    await flush()
    const tab = screen.getByRole('button', { name: /Team Knowledge/ })
    fireEvent.click(tab)
    const entryButton = screen.getByText('Uplink flapping').closest('button')!
    entryButton.focus()
    fireEvent.keyDown(entryButton, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(tab)
  })

  it('a click outside closes the list without moving focus', async () => {
    renderKnowledge()
    await flush()
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    fireEvent.click(screen.getByRole('button', { name: /Team Knowledge/ }))
    outside.focus()
    fireEvent.pointerDown(outside)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })
})
