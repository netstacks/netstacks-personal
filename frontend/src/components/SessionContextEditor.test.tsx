import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { SessionContext } from '../types/sessionContext'

const listSessionContext = vi.hoisted(() => vi.fn())
vi.mock('../api/sessionContext', () => ({ listSessionContext }))

import SessionContextEditor from './SessionContextEditor'

const entry = (id: string, issue: string, root_cause: string): SessionContext => ({
  id, session_id: 's1', issue, root_cause, resolution: null, commands: null, ticket_ref: null,
  author: 'netops', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
})

const originalScrollIntoView = Element.prototype.scrollIntoView

afterEach(() => {
  cleanup()
  listSessionContext.mockReset()
  Element.prototype.scrollIntoView = originalScrollIntoView
})

describe('SessionContextEditor', () => {
  it('opens with the requested entry expanded and scrolled into view', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    listSessionContext.mockResolvedValue([entry('c1', 'Uplink flapping', 'Storm control'), entry('c2', 'SSH timeouts', 'exec-timeout')])
    render(<SessionContextEditor sessionId="s1" currentUser="me" initialExpandedId="c2" />)
    expect(await screen.findByText('exec-timeout')).toBeInTheDocument()
    expect(screen.queryByText('Storm control')).toBeNull()
    expect(scrollIntoView).toHaveBeenCalledOnce()
  })
})
