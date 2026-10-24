import { describe, it, expect } from 'vitest'
import { formatChatCapture, selectUncaptured } from '../aiChatCapture'
import type { AgentMessage } from '../../hooks/useAIAgent'

const msg = (id: string, type: AgentMessage['type'], content: string): AgentMessage => ({ id, type, content, timestamp: new Date(0) })

describe('troubleshooting chat capture', () => {
  it('captures by id, so a shorter replacement chat is not skipped and history is not re-imported', () => {
    const captured = new Set<string>()
    const long = [msg('a', 'user', 'q1'), msg('b', 'agent-thinking', 'a1'), msg('c', 'user', 'q2')]
    for (const m of selectUncaptured(long, captured, false)) captured.add(m.id)
    expect([...captured]).toEqual(['a', 'b', 'c'])

    // A loaded (shorter) chat: its history is marked seen, new messages are captured.
    const loaded = [msg('x', 'user', 'old q')]
    loaded.forEach((m) => captured.add(m.id))
    const next = [...loaded, msg('y', 'user', 'new q')]
    expect(selectUncaptured(next, captured, false).map((m) => m.id)).toEqual(['y'])
  })

  it('waits for the streaming reply and skips empty placeholders', () => {
    const msgs = [msg('u', 'user', 'hi'), msg('p', 'agent-thinking', ''), msg('s', 'agent-thinking', 'partial')]
    expect(selectUncaptured(msgs, new Set(), true).map((m) => m.id)).toEqual(['u'])
    expect(selectUncaptured(msgs, new Set(['u']), false).map((m) => m.id)).toEqual(['s'])
  })

  it('labels roles', () => {
    expect(formatChatCapture(msg('1', 'user', 'q'))).toBe('[User] q')
    expect(formatChatCapture(msg('2', 'agent-thinking', 'a'))).toBe('[AI] a')
  })
})
