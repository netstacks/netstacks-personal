import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { AIHighlight } from '../../api/ai'

const analyzeHighlights = vi.fn()
vi.mock('../../api/ai', () => ({
  analyzeHighlights: (...args: unknown[]) => analyzeHighlights(...args),
}))

import { useAIHighlighting } from '../useAIHighlighting'

const hl = (text: string): AIHighlight => ({ line: 0, start: 0, end: text.length, text, type: 'error', confidence: 0.9 } as unknown as AIHighlight)

beforeEach(() => analyzeHighlights.mockReset())

describe('useAIHighlighting error handling', () => {
  it('keeps previous good highlights on a provider error, exposes it, and retries the same input', async () => {
    const { result } = renderHook(() => useAIHighlighting({ enabled: true, debounceMs: 100000 }))

    analyzeHighlights.mockImplementation(async (_o: string, mode: string) => (mode === 'errors' ? [hl('% Invalid input')] : []))
    act(() => result.current.addOutput('first output\n'))
    await act(() => result.current.analyzeNow())
    expect(result.current.highlights.map((h) => h.text)).toEqual(['% Invalid input'])
    expect(result.current.error).toBeNull()

    analyzeHighlights.mockImplementation(async (_o: string, mode: string) => {
      if (mode === 'security') throw new Error('Provider returned 529 overloaded')
      return []
    })
    act(() => result.current.addOutput('second output\n'))
    await act(() => result.current.analyzeNow())
    expect(result.current.highlights.map((h) => h.text)).toEqual(['% Invalid input'])
    expect(result.current.error).toMatch(/overloaded/)
    expect(result.current.isAnalyzing).toBe(false)

    // Same buffer again: not marked analyzed, so it is retried.
    analyzeHighlights.mockClear()
    analyzeHighlights.mockImplementation(async () => [])
    await act(() => result.current.analyzeNow())
    expect(analyzeHighlights).toHaveBeenCalledTimes(3)
    expect(result.current.highlights).toEqual([])
    expect(result.current.error).toBeNull()
  })
})
