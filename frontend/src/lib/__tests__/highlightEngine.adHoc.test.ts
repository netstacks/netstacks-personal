import { describe, it, expect, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'

vi.mock('../../api/highlightRules', () => ({
  getEffectiveHighlightRules: () => Promise.resolve([]),
  listHighlightRules: () => Promise.resolve([]),
}))

import { HighlightEngine } from '../highlightEngine'

function fakeTerminal() {
  const disposed: number[] = []
  let n = 0
  const term = {
    rows: 24,
    buffer: { active: { viewportY: 0, baseY: 0, cursorY: 0 } },
    registerMarker: () => ({ dispose() {} }),
    registerDecoration: () => {
      const id = n++
      return { onRender() {}, dispose() { disposed.push(id) } }
    },
  }
  return { term: term as unknown as Terminal, disposed }
}

const hl = { line: 1, start: 0, end: 4, foreground: '#f00' }

describe('HighlightEngine AI (ad-hoc) highlights', () => {
  it('replaces the previous set, and an empty set clears it', () => {
    const { term, disposed } = fakeTerminal()
    const engine = new HighlightEngine(term)
    engine.applyAdHocHighlights([hl, { ...hl, line: 2 }])
    expect(disposed).toEqual([])

    engine.applyAdHocHighlights([{ ...hl, line: 3 }])
    expect(disposed).toEqual([0, 1])

    engine.applyAdHocHighlights([])
    expect(disposed).toEqual([0, 1, 2])
  })
})
