import { describe, it, expect } from 'vitest'
import { groupActivity, describeActivity } from './aiActivity'

const m = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, content: '', ...extra })

describe('groupActivity', () => {
  it('folds each run of tool calls / reasoning into one activity item', () => {
    const items = groupActivity([
      m('1', 'user'),
      m('2', 'reasoning'),
      m('3', 'command-result'),
      m('4', 'command-result'),
      m('5', 'agent-thinking'),
      m('6', 'command-result'),
    ])
    expect(items.map((i) => (i.kind === 'activity' ? `A[${i.msgs.map((x) => x.id).join(',')}]` : i.msg.id)))
      .toEqual(['1', 'A[2,3,4]', '5', 'A[6]'])
  })

  it('keys a group by its first row so it keeps its identity as rows arrive', () => {
    const first = groupActivity([m('a', 'reasoning')])[0]
    const later = groupActivity([m('a', 'reasoning'), m('b', 'command-result')])[0]
    expect(first.kind === 'activity' && later.kind === 'activity' && first.id === later.id).toBe(true)
  })
})

describe('describeActivity', () => {
  it('summarises tools and thoughts', () => {
    expect(describeActivity([m('1', 'command-result')])).toBe('Used 1 tool')
    expect(describeActivity([m('1', 'reasoning'), m('2', 'command-result'), m('3', 'command-result'), m('4', 'reasoning')]))
      .toBe('Used 2 tools · thought twice')
    expect(describeActivity([m('1', 'reasoning')])).toBe('Thought once')
  })
})
