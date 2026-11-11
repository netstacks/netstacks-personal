import { describe, expect, it } from 'vitest'

import { consumeSseLine } from '../sseLines'

function feed(chunks: string[][]): Array<[string, string]> {
  const seen: Array<[string, string]> = []
  let current = ''
  for (const lines of chunks) {
    for (const line of lines) {
      current = consumeSseLine(line, current, (ev, data) => seen.push([ev, data]))
    }
  }
  return seen
}

describe('consumeSseLine', () => {
  it('files duplicate data lines under their own event, not the first match', () => {
    const seen = feed([[
      'event: stdout', 'data: hello', '',
      'event: stderr', 'data: hello', '',
    ]])
    expect(seen).toEqual([['stdout', 'hello'], ['stderr', 'hello']])
  })

  it('carries the event name across a chunk boundary', () => {
    const seen = feed([
      ['event: stderr'],
      ['data: boom', ''],
    ])
    expect(seen).toEqual([['stderr', 'boom']])
  })

  it('resets the event name at a blank line', () => {
    const seen = feed([['event: status', 'data: running', '', 'data: orphan']])
    expect(seen).toEqual([['status', 'running'], ['', 'orphan']])
  })
})
